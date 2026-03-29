/**
 * Selector Health Check
 *
 * Tiered probing of Acuity page selectors with degradation detection.
 * "Degraded" means the primary selector (index 0) failed but a fallback
 * (index > 0) still works — an early warning that Acuity changed their DOM.
 *
 * Tiers:
 *   depth=0: HTTP-only BUSINESS object check (~200ms, no browser)
 *   depth=1: Service page selectors (~3-5s, browser required)
 *   depth=2: + Calendar page selectors (~8-15s, clicks through wizard)
 */

import { Effect, Scope } from 'effect';
import type { Page } from 'playwright-core';
import { BrowserService } from './browser-service.js';
import { Selectors, type SelectorKey } from './selectors.js';
import { fetchBusinessData } from './steps/extract-business.js';

// =============================================================================
// TYPES
// =============================================================================

export interface SelectorProbeResult {
	readonly key: SelectorKey;
	readonly status: 'passed' | 'degraded' | 'failed';
	/** Which selector matched (null if failed) */
	readonly matchedSelector: string | null;
	/** Index in the candidates array (0 = primary, >0 = degraded) */
	readonly matchedIndex: number | null;
	/** Time to probe in ms */
	readonly probeMs: number;
}

export interface SelectorHealthReport {
	readonly status: 'healthy' | 'degraded' | 'unhealthy';
	readonly selectors: SelectorProbeResult[];
	readonly passed: number;
	readonly degraded: number;
	readonly failed: number;
	readonly totalMs: number;
	readonly pagesProbed: readonly string[];
	readonly businessObjectAvailable: boolean;
	readonly timestamp: string;
}

// =============================================================================
// SELECTOR TIERS
// =============================================================================

/** Selectors available on the service selection page (no navigation needed) */
const SERVICE_PAGE_KEYS: SelectorKey[] = [
	'serviceList', 'serviceName', 'serviceBookButton',
	'serviceCategory', 'servicePrice', 'serviceDuration',
];

/** Selectors available on the calendar page (requires clicking Book) */
const CALENDAR_PAGE_KEYS: SelectorKey[] = [
	'calendar', 'calendarMonth', 'calendarDay',
	'calendarPrev', 'calendarNext',
];

// =============================================================================
// PROBE WITH DEGRADATION DETECTION
// =============================================================================

/**
 * Probe a single selector key, trying ALL candidates in order.
 * Detects degradation when primary (index 0) fails but a fallback works.
 */
const probeSelectorWithDegradation = (
	page: Page,
	key: SelectorKey,
): Effect.Effect<SelectorProbeResult, never> =>
	Effect.gen(function* () {
		const start = Date.now();
		const candidates = Selectors[key];

		for (let i = 0; i < candidates.length; i++) {
			const exists = yield* Effect.tryPromise({
				try: () => page.$(candidates[i]).then((el) => el !== null),
				catch: () => false,
			}).pipe(Effect.orElseSucceed(() => false));

			if (exists) {
				return {
					key,
					status: i === 0 ? 'passed' as const : 'degraded' as const,
					matchedSelector: candidates[i],
					matchedIndex: i,
					probeMs: Date.now() - start,
				};
			}
		}

		return {
			key,
			status: 'failed' as const,
			matchedSelector: null,
			matchedIndex: null,
			probeMs: Date.now() - start,
		};
	});

// =============================================================================
// REPORT BUILDER
// =============================================================================

const buildReport = (
	selectors: SelectorProbeResult[],
	pagesProbed: string[],
	businessObjectAvailable: boolean,
	startMs: number,
): SelectorHealthReport => {
	const passed = selectors.filter((s) => s.status === 'passed').length;
	const degraded = selectors.filter((s) => s.status === 'degraded').length;
	const failed = selectors.filter((s) => s.status === 'failed').length;

	const status: SelectorHealthReport['status'] =
		failed > 0 ? 'unhealthy' : degraded > 0 ? 'degraded' : 'healthy';

	return {
		status,
		selectors,
		passed,
		degraded,
		failed,
		totalMs: Date.now() - startMs,
		pagesProbed,
		businessObjectAvailable,
		timestamp: new Date().toISOString(),
	};
};

// =============================================================================
// TIERED HEALTH CHECK
// =============================================================================

/**
 * Run a selector health check at the specified depth.
 *
 * @param baseUrl - Acuity scheduling URL
 * @param depth - 0 = HTTP-only, 1 = service page, 2 = service + calendar
 */
export const selectorHealthCheck = (
	baseUrl: string,
	depth: 0 | 1 | 2 = 0,
): Effect.Effect<SelectorHealthReport, never, BrowserService | Scope.Scope> =>
	Effect.gen(function* () {
		const start = Date.now();
		const results: SelectorProbeResult[] = [];
		const pagesProbed: string[] = [];

		// Tier 0: BUSINESS object check (HTTP-only, no browser)
		const businessAvailable = yield* Effect.tryPromise({
			try: () => fetchBusinessData(baseUrl).then((b) => b !== null),
			catch: () => false,
		}).pipe(Effect.orElseSucceed(() => false));

		if (depth === 0) {
			return buildReport(results, pagesProbed, businessAvailable, start);
		}

		// Tier 1: Service page selectors
		const { acquirePage, config } = yield* BrowserService;
		const page = yield* acquirePage.pipe(Effect.orDie);

		yield* Effect.tryPromise({
			try: () => page.goto(config.baseUrl, { waitUntil: 'networkidle', timeout: config.timeout }),
			catch: () => null,
		}).pipe(Effect.ignore);

		for (const key of SERVICE_PAGE_KEYS) {
			results.push(yield* probeSelectorWithDegradation(page, key));
		}
		pagesProbed.push('service');

		if (depth < 2) {
			return buildReport(results, pagesProbed, businessAvailable, start);
		}

		// Tier 2: Calendar page (click first service's Book)
		const navigated = yield* Effect.tryPromise({
			try: async () => {
				const btn = await page.$(Selectors.serviceBookButton[0]);
				if (btn) {
					await btn.click();
					await page.waitForURL(/\/calendar\//, { timeout: 10000 });
					return true;
				}
				return false;
			},
			catch: () => false,
		}).pipe(Effect.orElseSucceed(() => false));

		if (navigated) {
			// Wait for calendar to render
			yield* Effect.tryPromise({
				try: () => page.waitForSelector(Selectors.calendar[0], { timeout: 10000 }),
				catch: () => null,
			}).pipe(Effect.ignore);

			for (const key of CALENDAR_PAGE_KEYS) {
				results.push(yield* probeSelectorWithDegradation(page, key));
			}
			pagesProbed.push('calendar');
		}

		return buildReport(results, pagesProbed, businessAvailable, start);
	});
