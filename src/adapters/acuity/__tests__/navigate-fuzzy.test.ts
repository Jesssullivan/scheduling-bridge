/**
 * Fuzzy-in wiring for acuity/navigate (design §6 Services bullet, §10 0.6.x):
 * the ServiceResolver 4-strategy cascade replaces the legacy substring
 * `serviceNameMatches` scan inside `selectService`, the per-flow `minConfidence`
 * policy admits or rejects matches with a typed `ServiceResolverError`, and the
 * resolution surfaces as a `FuzzyResolution` in `StepOutcome.resolutions` so the
 * fold journals it. Both the legacy worker path and the flagged flow path share
 * `navigateToBooking`, so these cases cover both.
 */

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { BrowserService, defaultBrowserConfig } from '../../../shared/browser-service.js';
import {
	DEFAULT_SERVICE_MIN_CONFIDENCE,
	resolveServiceOnPage,
} from '../service-resolver.js';
import { navigateToBooking } from '../steps/navigate.js';
import {
	acuityNavigateStep,
	makeAcuityNavigateStep,
	serviceResolutionToFuzzy,
	toClientState,
} from '../flow-steps.js';
import { ACUITY_FLOW_MIN_CONFIDENCE, acuityBookingFlow } from '../flows.js';

// =============================================================================
// FAKE PAGES
// =============================================================================

/** Minimal fake service-selection page for resolveServiceOnPage. */
const makeServiceListPage = (
	labels: readonly string[],
	business: unknown = null,
): Page => {
	const items = labels.map((label) => ({
		$: async (selector: string) =>
			selector === '.appointment-type-name'
				? { textContent: async () => label }
				: null,
	}));
	return {
		$$: async (selector: string) => (selector === '.select-item' ? items : []),
		evaluate: async () => business,
	} as unknown as Page;
};

/** Full fake wizard page driving navigateToBooking end to end (no Chromium). */
const makeWizardPage = (labels: readonly string[]) => {
	let currentUrl = 'https://example.as.me';
	const clicks: string[] = [];
	const items = labels.map((label) => ({
		$: async (selector: string) =>
			selector === '.appointment-type-name'
				? { textContent: async () => label }
				: selector === 'button.btn'
					? {
							click: async () => {
								clicks.push(`book:${label}`);
								currentUrl =
									'https://example.as.me/schedule/abc/appointment/98765/calendar/4321';
							},
						}
					: null,
	}));
	const dayTile = {
		evaluate: async () => false,
		getAttribute: async () => 'react-calendar__tile',
		textContent: async () => '15',
		click: async () => {
			clicks.push('day:15');
		},
	};
	const timeSlot = {
		textContent: async () => '10:00 AM1 spot left',
		click: async () => {
			clicks.push('slot:10:00 AM');
		},
	};
	const page = {
		goto: async () => null,
		url: () => currentUrl,
		$: async (selector: string) =>
			selector === 'input[name="client.firstName"]' ? {} : null,
		$$: async (selector: string) =>
			selector === '.select-item'
				? items
				: selector === '.react-calendar__tile'
					? [dayTile]
					: selector === 'button.time-selection'
						? [timeSlot]
						: [],
		$eval: async (_selector: string, fn: (el: unknown) => unknown) =>
			fn({ textContent: 'March 2026' }),
		evaluate: async () => null,
		waitForSelector: async (selector: string) =>
			selector === 'li[role="menuitem"]'
				? {
						click: async () => {
							clicks.push('select-and-continue');
							currentUrl = `${currentUrl}/datetime/2026-03-15T10:00`;
						},
					}
				: { click: async () => {} },
		waitForURL: async () => undefined,
		waitForTimeout: async () => undefined,
	} as unknown as Page;
	return { page, clicks };
};

const fakeBrowserService = (page: Page) =>
	({
		acquirePage: Effect.succeed(page),
		screenshot: () => Effect.succeed(Buffer.from('')),
		config: { ...defaultBrowserConfig },
	}) as never;

const LABELS = [
	'TMD Tune up (75 min)',
	'Cervical Medical Massage 30 minutes',
] as const;

const CLIENT = { firstName: 'Jess', lastName: 'Sullivan', email: 'jess@example.com' };

// =============================================================================
// CASCADE (resolveServiceOnPage)
// =============================================================================

describe('resolveServiceOnPage — ServiceResolver cascade', () => {
	it('preserves exact/normalized matching behavior (strategy normalized-exact, 0.95)', async () => {
		const resolution = await Effect.runPromise(
			resolveServiceOnPage(makeServiceListPage(LABELS), 'TMD Tune up (75 min)'),
		);
		expect(resolution.strategy).toBe('normalized-exact');
		expect(resolution.confidence).toBe(0.95);
		expect(resolution.matchedName).toBe('TMD Tune up (75 min)');
		expect(resolution.threshold).toBe(DEFAULT_SERVICE_MIN_CONFIDENCE);
	});

	it('resolves by Acuity numeric id through the BUSINESS object (strategy id-match, 1.0)', async () => {
		const business = {
			appointmentTypes: {
				TMD: [{ id: 53178494, name: 'TMD Tune up (75 min)' }],
			},
		};
		const resolution = await Effect.runPromise(
			resolveServiceOnPage(
				makeServiceListPage(LABELS, business),
				'completely unrelated request',
				'53178494',
			),
		);
		expect(resolution.strategy).toBe('id-match');
		expect(resolution.confidence).toBe(1.0);
		expect(resolution.matchedName).toBe('TMD Tune up (75 min)');
	});

	it('admits tolerant token-overlap matches the substring matcher never scored', async () => {
		const resolution = await Effect.runPromise(
			resolveServiceOnPage(makeServiceListPage(LABELS), 'Cervical Medical Massage'),
		);
		expect(resolution.strategy).toBe('token-overlap');
		expect(resolution.confidence).toBeCloseTo(0.5, 10);
		expect(resolution.matchedName).toBe('Cervical Medical Massage 30 minutes');
	});

	it('admits fuzzy/Levenshtein matches for near-miss spellings', async () => {
		const resolution = await Effect.runPromise(
			resolveServiceOnPage(makeServiceListPage(['Massage', 'Facial']), 'Massagee'),
		);
		expect(resolution.strategy).toBe('fuzzy');
		expect(resolution.confidence).toBeGreaterThanOrEqual(0.3);
		expect(resolution.confidence).toBeLessThan(0.7);
		expect(resolution.matchedName).toBe('Massage');
	});

	it('records scored runners-up as alternates, best first, excluding the match', async () => {
		const resolution = await Effect.runPromise(
			resolveServiceOnPage(makeServiceListPage(LABELS), 'Cervical Medical Massage'),
		);
		expect(resolution.alternates).toHaveLength(1);
		expect(resolution.alternates[0].label).toBe('TMD Tune up (75 min)');
		expect(resolution.alternates[0].confidence).toBe(0);
	});

	it('rejects below-cascade-threshold requests with a typed ServiceResolverError', async () => {
		const error = await Effect.runPromise(
			Effect.flip(resolveServiceOnPage(makeServiceListPage(LABELS), 'Yoga')),
		);
		expect(error._tag).toBe('ServiceResolverError');
		expect(error.strategies).toContain('normalized-exact:failed');
		expect(error.strategies).toContain('token-overlap:failed');
		expect(error.strategies).toContain('fuzzy:failed');
	});

	it('rejects matches below the per-flow minConfidence policy with a typed error', async () => {
		const error = await Effect.runPromise(
			Effect.flip(
				resolveServiceOnPage(
					makeServiceListPage(LABELS),
					'Cervical Medical Massage',
					undefined,
					0.9,
				),
			),
		);
		expect(error._tag).toBe('ServiceResolverError');
		expect(error.message).toContain('minConfidence 0.9');
		expect(error.message).toContain('token-overlap');
	});
});

// =============================================================================
// NAVIGATE WIRING (legacy + flagged paths share navigateToBooking)
// =============================================================================

describe('navigateToBooking — cascade wiring', () => {
	it('navigates the wizard on a tolerant match and surfaces the resolution audit trail', async () => {
		const { page, clicks } = makeWizardPage(LABELS);
		const result = await Effect.runPromise(
			navigateToBooking({
				serviceName: 'cervical medical massage',
				datetime: '2026-03-15T10:00:00',
				client: CLIENT,
			}).pipe(
				Effect.provideService(BrowserService, fakeBrowserService(page)),
				Effect.scoped,
			),
		);

		expect(result.landingStep).toBe('client-form');
		expect(result.appointmentTypeId).toBe('98765');
		expect(result.calendarId).toBe('4321');
		expect(clicks).toContain('book:Cervical Medical Massage 30 minutes');
		expect(result.serviceResolution).toBeDefined();
		expect(result.serviceResolution?.strategy).toBe('token-overlap');
		expect(result.serviceResolution?.matchedName).toBe(
			'Cervical Medical Massage 30 minutes',
		);
		expect(result.serviceResolution?.threshold).toBe(DEFAULT_SERVICE_MIN_CONFIDENCE);
	});

	it('fails navigate with the typed ServiceResolverError when nothing clears the threshold', async () => {
		const { page, clicks } = makeWizardPage(LABELS);
		const error = await Effect.runPromise(
			Effect.flip(
				navigateToBooking({
					serviceName: 'Yoga Class',
					datetime: '2026-03-15T10:00:00',
					client: CLIENT,
				}).pipe(
					Effect.provideService(BrowserService, fakeBrowserService(page)),
					Effect.scoped,
				),
			),
		);
		expect((error as { _tag: string })._tag).toBe('ServiceResolverError');
		// Typed rejection, never a low-confidence click.
		expect(clicks).toHaveLength(0);
	});
});

// =============================================================================
// FLOW-STEP SURFACE (StepOutcome.resolutions → fold journaling)
// =============================================================================

describe('acuity/navigate FlowStep — fuzzy resolution surfacing', () => {
	it('maps ServiceResolutionSummary 1:1 onto FuzzyResolution', () => {
		const summary = {
			confidence: 0.5,
			strategy: 'token-overlap' as const,
			matchedName: 'Cervical Medical Massage 30 minutes',
			threshold: 0.3,
			alternates: [{ label: 'TMD Tune up (75 min)', confidence: 0 }],
		};
		expect(serviceResolutionToFuzzy(summary)).toEqual({
			value: 'Cervical Medical Massage 30 minutes',
			confidence: 0.5,
			strategy: 'token-overlap',
			matchedLabel: 'Cervical Medical Massage 30 minutes',
			threshold: 0.3,
			alternates: [{ label: 'TMD Tune up (75 min)', confidence: 0 }],
		});
	});

	it('surfaces the resolution in StepOutcome.resolutions for the fold to journal', async () => {
		const { page } = makeWizardPage(LABELS);
		const outcome = await Effect.runPromise(
			acuityNavigateStep
				.run({
					serviceId: '98765',
					datetime: '2026-03-15T10:00:00',
					serviceName: 'cervical medical massage',
					client: toClientState(CLIENT),
				})
				.pipe(
					Effect.provideService(BrowserService, fakeBrowserService(page)),
					Effect.scoped,
				),
		);

		expect(outcome.state.navigation.landingStep).toBe('client-form');
		expect(outcome.resolutions).toHaveLength(1);
		const resolution = outcome.resolutions?.[0];
		expect(resolution).toMatchObject({
			value: 'Cervical Medical Massage 30 minutes',
			matchedLabel: 'Cervical Medical Massage 30 minutes',
			strategy: 'token-overlap',
			threshold: DEFAULT_SERVICE_MIN_CONFIDENCE,
		});
		expect(outcome.observed?.observed).toBe('acuity:client-form');
	});

	it('threads the per-flow minConfidence (data on the flow definition) into the cascade', async () => {
		const { page, clicks } = makeWizardPage(LABELS);
		const strictStep = makeAcuityNavigateStep({ minConfidence: 0.9 });
		// Meta (and therefore the plan shape) is threshold-independent.
		expect(strictStep.meta).toEqual(acuityNavigateStep.meta);

		const error = await Effect.runPromise(
			Effect.flip(
				strictStep
					.run({
						serviceId: '98765',
						datetime: '2026-03-15T10:00:00',
						serviceName: 'cervical medical massage',
						client: toClientState(CLIENT),
					})
					.pipe(
						Effect.provideService(BrowserService, fakeBrowserService(page)),
						Effect.scoped,
					),
			),
		);
		expect((error as { _tag?: string })?._tag).toBe('ServiceResolverError');
		expect(clicks).toHaveLength(0);
	});

	it('registers per-flow thresholds as data and keeps the booking planHash stable', () => {
		expect(ACUITY_FLOW_MIN_CONFIDENCE.booking_create_with_payment).toBe(
			DEFAULT_SERVICE_MIN_CONFIDENCE,
		);
		// The threshold lives outside the hashed plan: the navigate node is unchanged.
		const navigateNode = acuityBookingFlow.plan.nodes[0];
		expect(navigateNode.stepId).toBe('acuity/navigate');
		expect(acuityBookingFlow.planHash).toMatch(/^[0-9a-f]{64}$/);
	});
});
