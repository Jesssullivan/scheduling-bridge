/**
 * ServiceResolver — Multi-Strategy Service Name Matching
 *
 * Effect Context.Tag providing resilient service resolution with
 * cascading fallback strategies and confidence scoring.
 *
 * Strategies (tried in order via Effect.orElse):
 * 1. ID match    (confidence 1.0)  — match by Acuity numeric ID in BUSINESS object
 * 2. Normalized  (confidence 0.95) — strip punctuation, collapse whitespace, exact match
 * 3. Token overlap (0.5-0.9)       — word-level intersection scoring
 * 4. Fuzzy/Levenshtein (0.3-0.7)   — edit-distance based matching
 */

import { Context, Effect, Layer } from 'effect';
import {
	FUZZY_THRESHOLD,
	TOKEN_THRESHOLD,
	fuzzyConfidence,
	levenshtein,
	normalize,
	scoreLabel,
	tokenOverlap,
	type FuzzyStrategy,
} from '@tummycrypt/scheduling-kit/fuzzy';
import type { Page, ElementHandle } from 'playwright-core';
import { ServiceResolverError } from './errors.js';
import { Selectors } from './selectors.js';
import type { AcuityBusinessData } from './steps/extract-business.js';

// =============================================================================
// TYPES
// =============================================================================

export interface ServiceResolution {
	/** The matched DOM element (the .select-item container) */
	readonly element: ElementHandle;
	/** Confidence score 0-1 */
	readonly confidence: number;
	/** Which strategy produced the match */
	readonly strategy: FuzzyStrategy;
	/** The name as it appears on the page */
	readonly matchedName: string;
}

/** A runner-up candidate considered (but not selected) by the cascade. */
export interface ServiceResolutionAlternate {
	readonly label: string;
	readonly confidence: number;
}

/**
 * Default per-flow admitting threshold for service resolution. Matches the cascade's own
 * floor (fuzzy strategy scales onto 0.3-0.7), so the default is behavior-preserving; flows
 * tighten it as data (`ACUITY_FLOW_MIN_CONFIDENCE`, design §6: "thresholds are data on the
 * flow definition").
 */
export const DEFAULT_SERVICE_MIN_CONFIDENCE = 0.3;

/**
 * A cascade resolution plus the audit fields that map 1:1 onto `FuzzyResolution`
 * (design §6): the admitting threshold and the scored runners-up. The volatile
 * `element` handle MUST stay out of flow state / journals (design risk #2) — use
 * `toServiceResolutionSummary` for the JSON-safe projection.
 */
export interface ResolvedServiceSelection extends ServiceResolution {
	/** The per-flow minConfidence policy that admitted this match. */
	readonly threshold: number;
	/** Runners-up with their cascade-scaled confidence, best first. */
	readonly alternates: readonly ServiceResolutionAlternate[];
}

/** JSON-safe projection of a resolution (no ElementHandle) for journaling/audit. */
export interface ServiceResolutionSummary {
	readonly confidence: number;
	readonly strategy: ServiceResolution['strategy'];
	readonly matchedName: string;
	readonly threshold: number;
	readonly alternates: readonly ServiceResolutionAlternate[];
}

export const toServiceResolutionSummary = (
	resolution: ResolvedServiceSelection,
): ServiceResolutionSummary => ({
	confidence: resolution.confidence,
	strategy: resolution.strategy,
	matchedName: resolution.matchedName,
	threshold: resolution.threshold,
	alternates: resolution.alternates,
});

export interface ServiceResolverShape {
	readonly resolve: (
		page: Page,
		serviceName: string,
		appointmentTypeId?: string,
	) => Effect.Effect<ServiceResolution, ServiceResolverError>;
}

// =============================================================================
// CONTEXT TAG
// =============================================================================

export class ServiceResolver extends Context.Tag('scheduling-bridge/ServiceResolver')<
	ServiceResolver,
	ServiceResolverShape
>() {}

// The pure string-scoring machinery now lives in scheduling-kit. Re-export it
// here for the existing Acuity adapter/tests while the implementation consumes
// the shared package authority.
export {
	FUZZY_THRESHOLD,
	TOKEN_THRESHOLD,
	fuzzyConfidence,
	levenshtein,
	normalize,
	scoreLabel,
	tokenOverlap,
};

// =============================================================================
// SERVICE EXTRACTION FROM PAGE
// =============================================================================

interface PageService {
	name: string;
	element: ElementHandle;
}

/** Extract all service items and their names from the page DOM. */
const extractPageServices = (page: Page): Effect.Effect<PageService[], never> =>
	Effect.tryPromise({
		try: async () => {
			const items = await page.$$(Selectors.serviceList[0]);
			const services: PageService[] = [];

			for (const item of items) {
				const nameEl = await item.$(Selectors.serviceName[0]);
				const name = await nameEl?.textContent();
				if (name?.trim()) {
					services.push({ name: name.trim(), element: item });
				}
			}

			return services;
		},
		catch: () => [] as PageService[],
	}).pipe(Effect.orElseSucceed(() => [] as PageService[]));

// =============================================================================
// STRATEGY IMPLEMENTATIONS
// =============================================================================

/** Strategy 1: Match by Acuity numeric ID via BUSINESS object. */
const tryIdMatch = (
	page: Page,
	pageServices: PageService[],
	appointmentTypeId: string,
): Effect.Effect<ServiceResolution, ServiceResolverError> =>
	Effect.gen(function* () {
		// Try to get BUSINESS object from the page
		const business: AcuityBusinessData | null = yield* Effect.tryPromise({
			try: () => page.evaluate(() => (window as unknown as { BUSINESS?: AcuityBusinessData }).BUSINESS ?? null),
			catch: () => null,
		}).pipe(Effect.orElseSucceed(() => null));

		if (!business) {
			return yield* Effect.fail(new ServiceResolverError({
				serviceName: appointmentTypeId,
				strategies: ['id-match'],
				message: 'BUSINESS object not available on page',
			}));
		}

		// Find the appointment type by ID
		let targetName: string | null = null;
		for (const types of Object.values(business.appointmentTypes ?? {})) {
			for (const apt of types as Array<{ id: number; name: string }>) {
				if (String(apt.id) === appointmentTypeId) {
					targetName = apt.name;
					break;
				}
			}
			if (targetName) break;
		}

		if (!targetName) {
			return yield* Effect.fail(new ServiceResolverError({
				serviceName: appointmentTypeId,
				strategies: ['id-match'],
				message: `Acuity ID ${appointmentTypeId} not found in BUSINESS object`,
			}));
		}

		// Now match the BUSINESS name to a DOM element
		const normalizedTarget = normalize(targetName);
		for (const svc of pageServices) {
			if (normalize(svc.name) === normalizedTarget) {
				return {
					element: svc.element,
					confidence: 1.0,
					strategy: 'id-match' as const,
					matchedName: svc.name,
				};
			}
		}

		return yield* Effect.fail(new ServiceResolverError({
			serviceName: appointmentTypeId,
			strategies: ['id-match'],
			message: `BUSINESS name "${targetName}" not found in DOM`,
		}));
	});

/** Strategy 2: Normalized exact match. */
const tryNormalizedMatch = (
	pageServices: PageService[],
	serviceName: string,
): Effect.Effect<ServiceResolution, ServiceResolverError> => {
	const normalizedTarget = normalize(serviceName);

	for (const svc of pageServices) {
		if (normalize(svc.name) === normalizedTarget) {
			return Effect.succeed({
				element: svc.element,
				confidence: 0.95,
				strategy: 'normalized-exact' as const,
				matchedName: svc.name,
			});
		}
	}

	return Effect.fail(new ServiceResolverError({
		serviceName,
		strategies: ['normalized-exact'],
		message: `No normalized match for "${serviceName}"`,
	}));
};

/** Strategy 3: Token overlap. */
const tryTokenOverlap = (
	pageServices: PageService[],
	serviceName: string,
): Effect.Effect<ServiceResolution, ServiceResolverError> => {
	let bestMatch: PageService | null = null;
	let bestConfidence = 0;

	for (const svc of pageServices) {
		const score = scoreLabel(serviceName, svc.name);
		if (score.strategy === 'token-overlap' && score.confidence > bestConfidence) {
			bestConfidence = score.confidence;
			bestMatch = svc;
		}
	}

	if (bestMatch && bestConfidence > 0) {
		return Effect.succeed({
			element: bestMatch.element,
			confidence: bestConfidence,
			strategy: 'token-overlap' as const,
			matchedName: bestMatch.name,
		});
	}

	return Effect.fail(new ServiceResolverError({
		serviceName,
		strategies: ['token-overlap'],
		message: `No token-overlap match cleared the shared scorer threshold ${TOKEN_THRESHOLD}`,
	}));
};

/** Strategy 4: Fuzzy/Levenshtein. */
const tryFuzzyMatch = (
	pageServices: PageService[],
	serviceName: string,
): Effect.Effect<ServiceResolution, ServiceResolverError> => {
	let bestMatch: PageService | null = null;
	let bestConfidence = 0;

	for (const svc of pageServices) {
		const score = scoreLabel(serviceName, svc.name);
		if (score.strategy === 'fuzzy' && score.confidence > bestConfidence) {
			bestConfidence = score.confidence;
			bestMatch = svc;
		}
	}

	if (bestMatch && bestConfidence > 0) {
		return Effect.succeed({
			element: bestMatch.element,
			confidence: bestConfidence,
			strategy: 'fuzzy' as const,
			matchedName: bestMatch.name,
		});
	}

	return Effect.fail(new ServiceResolverError({
		serviceName,
		strategies: ['fuzzy'],
		message: `No fuzzy match cleared the shared scorer threshold ${FUZZY_THRESHOLD}`,
	}));
};

// =============================================================================
// CASCADE (shared by ServiceResolverLive and acuity/navigate's selectService)
// =============================================================================

/**
 * Run the 4-strategy cascade against the live service-selection page and admit the
 * result against a per-flow `minConfidence` policy (design §6: thresholds are data on
 * the flow definition, defaulted to the cascade floor so exact/normalized behavior is
 * preserved). Returns the resolution plus the FuzzyResolution audit fields
 * (threshold + scored runners-up); fails with a typed `ServiceResolverError`
 * carrying the strategy trail when nothing is admitted or the best match falls
 * below `minConfidence`.
 */
export const resolveServiceOnPage = (
	page: Page,
	serviceName: string,
	appointmentTypeId?: string,
	minConfidence: number = DEFAULT_SERVICE_MIN_CONFIDENCE,
): Effect.Effect<ResolvedServiceSelection, ServiceResolverError> =>
	Effect.gen(function* () {
		const pageServices = yield* extractPageServices(page);

		if (pageServices.length === 0) {
			return yield* Effect.fail(new ServiceResolverError({
				serviceName,
				strategies: [],
				message: 'No services found on page',
			}));
		}

		const strategies: string[] = [];
		const tap = (label: string) => ({
			onSuccess: () => Effect.sync(() => strategies.push(`${label}:success`)),
			onFailure: () => Effect.sync(() => strategies.push(`${label}:failed`)),
		});
		const withTrail = (
			label: string,
			attempt: Effect.Effect<ServiceResolution, ServiceResolverError>,
		) =>
			attempt.pipe(
				Effect.tap(tap(label).onSuccess),
				Effect.tapError(tap(label).onFailure),
			);

		// Strategy 1 (only when an Acuity numeric id is provided) → 2 → 3 → 4.
		const cascade = (
			appointmentTypeId
				? withTrail('id-match', tryIdMatch(page, pageServices, appointmentTypeId)).pipe(
						Effect.orElse(() =>
							withTrail('normalized-exact', tryNormalizedMatch(pageServices, serviceName)),
						),
					)
				: withTrail('normalized-exact', tryNormalizedMatch(pageServices, serviceName))
		).pipe(
			Effect.orElse(() => withTrail('token-overlap', tryTokenOverlap(pageServices, serviceName))),
			Effect.orElse(() => withTrail('fuzzy', tryFuzzyMatch(pageServices, serviceName))),
			Effect.mapError(() => new ServiceResolverError({
				serviceName,
				strategies,
				message: `No match found for "${serviceName}" across ${pageServices.length} services (tried: ${strategies.join(', ')})`,
			})),
		);

		const resolution = yield* cascade;

		// Per-flow admitting policy: below-threshold resolutions are typed rejections,
		// never silent low-confidence clicks.
		if (resolution.confidence < minConfidence) {
			return yield* Effect.fail(new ServiceResolverError({
				serviceName,
				strategies,
				message: `Resolved "${resolution.matchedName}" via ${resolution.strategy} at confidence ${resolution.confidence.toFixed(2)}, below the flow's minConfidence ${minConfidence} (tried: ${strategies.join(', ')})`,
			}));
		}

		// Runners-up, scored through the same cascade scaling, best first.
		const alternates = pageServices
			.filter((svc) => svc.name !== resolution.matchedName)
			.map((svc) => ({ label: svc.name, confidence: scoreLabel(serviceName, svc.name).confidence }))
			.sort((a, b) => b.confidence - a.confidence);

		return { ...resolution, threshold: minConfidence, alternates };
	});

// =============================================================================
// LIVE LAYER
// =============================================================================

export const ServiceResolverLive: Layer.Layer<ServiceResolver> = Layer.succeed(
	ServiceResolver,
	{
		resolve: (page, serviceName, appointmentTypeId) =>
			resolveServiceOnPage(page, serviceName, appointmentTypeId),
	},
);

// =============================================================================
// TEST LAYER
// =============================================================================

/**
 * A static ServiceResolver for tests that always returns a mock resolution.
 */
export const ServiceResolverTest = (
	mockResolution?: Partial<ServiceResolution>,
): Layer.Layer<ServiceResolver> =>
	Layer.succeed(ServiceResolver, {
		resolve: () =>
			Effect.succeed({
				element: null as unknown as ElementHandle,
				confidence: 1.0,
				strategy: 'normalized-exact' as const,
				matchedName: 'Test Service',
				...mockResolution,
			}),
	});
