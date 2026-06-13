/**
 * Fuzzy-in primitives — tolerant matching with explicit confidence and audit trails.
 * Design: docs/design/flow-dag-formalization.md §4 (fuzzy.ts) and §6.
 *
 * The pure scorers are reused verbatim from the ServiceResolver cascade
 * (src/adapters/acuity/service-resolver.ts:57-117); the confidence scaling below mirrors the
 * cascade strategies (id-match 1.0, normalized-exact 0.95, token-overlap scaled 0.5-0.9,
 * fuzzy/Levenshtein scaled 0.3-0.7) so the strategy trail maps 1:1 onto `FuzzyResolution`.
 * Nothing here is wired into navigate.ts — that is 0.6.x work.
 */

import { Context, Data, Effect, Layer } from 'effect';
import { scoreLabel } from '../adapters/acuity/service-resolver.js';

// Re-export the shared pure scoring machinery for matcher implementations.
// `scoreLabel` and the cascade thresholds live beside the in-page cascade
// (service-resolver.ts) so navigate's resolution and the catalog matcher
// share one scoring source of truth.
export {
	FUZZY_THRESHOLD,
	TOKEN_THRESHOLD,
	fuzzyConfidence,
	levenshtein,
	normalize,
	scoreLabel,
	tokenOverlap,
} from '../adapters/acuity/service-resolver.js';

/** Strategy vocabulary, identical to ServiceResolution.strategy. */
export type FuzzyStrategy = 'id-match' | 'normalized-exact' | 'token-overlap' | 'fuzzy';

/** The audit record every tolerant match produces. */
export interface FuzzyResolution<A> {
	readonly value: A;
	/** 0..1 */
	readonly confidence: number;
	readonly strategy: FuzzyStrategy;
	readonly matchedLabel: string;
	/** Policy that admitted the match. */
	readonly threshold: number;
	readonly alternates: readonly { readonly label: string; readonly confidence: number }[];
}

/** Failure: no candidate cleared the admitting threshold. */
export class FuzzyMatchError extends Data.TaggedError('FuzzyMatchError')<{
	readonly query: string;
	readonly threshold: number;
	readonly bestConfidence: number;
	readonly message: string;
}> {}

export interface FuzzyMatcher<Q, A> {
	readonly threshold: number;
	readonly match: (
		query: Q,
		candidates: readonly A[],
	) => Effect.Effect<FuzzyResolution<A>, FuzzyMatchError>;
}

export interface ServiceMatchQuery {
	readonly serviceName: string;
	readonly appointmentTypeId?: string;
}

export interface ServiceCandidate {
	readonly label: string;
	readonly ref: string;
}

export class ServiceMatcher extends Context.Tag('scheduling-bridge/ServiceMatcher')<
	ServiceMatcher,
	FuzzyMatcher<ServiceMatchQuery, ServiceCandidate>
>() {}
// DateMatcher (tolerant date/TZ normalization + slot membership) and FieldMatcher
// (intake-label inference generalizing fill-form.ts:234-266) are the same shape; both are
// 0.7.0 lanes per design §6.

// =============================================================================
// SHARED SCORING MACHINERY (pure; sourced from service-resolver.ts)
// =============================================================================

/** Default service matcher: id-match first, then the label cascade over candidates. */
export const makeServiceMatcher = (
	threshold = 0.3,
): FuzzyMatcher<ServiceMatchQuery, ServiceCandidate> => ({
	threshold,
	match: (query, candidates) =>
		Effect.suspend(() => {
			if (query.appointmentTypeId !== undefined) {
				const byId = candidates.find((c) => c.ref === query.appointmentTypeId);
				if (byId) {
					return Effect.succeed<FuzzyResolution<ServiceCandidate>>({
						value: byId,
						confidence: 1.0,
						strategy: 'id-match',
						matchedLabel: byId.label,
						threshold,
						alternates: [],
					});
				}
			}

			const scored = candidates
				.map((candidate) => ({ candidate, score: scoreLabel(query.serviceName, candidate.label) }))
				.sort((a, b) => b.score.confidence - a.score.confidence);
			const best = scored[0];

			if (!best || best.score.confidence < threshold) {
				return Effect.fail(
					new FuzzyMatchError({
						query: query.serviceName,
						threshold,
						bestConfidence: best?.score.confidence ?? 0,
						message: `No service candidate cleared threshold ${threshold} for '${query.serviceName}'`,
					}),
				);
			}

			return Effect.succeed<FuzzyResolution<ServiceCandidate>>({
				value: best.candidate,
				confidence: best.score.confidence,
				strategy: best.score.strategy,
				matchedLabel: best.candidate.label,
				threshold,
				alternates: scored
					.slice(1)
					.map(({ candidate, score }) => ({ label: candidate.label, confidence: score.confidence })),
			});
		}),
});

/** Default ServiceMatcher layer (Layer substitution replaces test-seam overrides). */
export const ServiceMatcherLive: Layer.Layer<ServiceMatcher> = Layer.sync(ServiceMatcher, () =>
	makeServiceMatcher(),
);
