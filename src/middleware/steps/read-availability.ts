/**
 * Wizard Step: Read Available Dates from Acuity Calendar
 *
 * Navigates to the service calendar via click-through (not query params)
 * and reads which calendar tiles are enabled (not disabled).
 *
 * Returns available dates for the currently visible month.
 * Callers should advance months if needed.
 *
 * NOTE: Service selection and calendar navigation use shared modules
 * (wizard-service.ts, wizard-calendar.ts) to avoid code duplication
 * with navigate.ts and read-slots.ts.
 */

import { Effect } from 'effect';
import type { Page } from 'playwright-core';
import { BrowserService } from '../browser-service.js';
import { WizardStepError } from '../errors.js';
import { resolveSelector, Selectors } from '../selectors.js';
import { getCurrentCalendarMonth, navigateToMonth } from '../wizard-calendar.js';
import { clickServiceBook } from '../wizard-service.js';

// =============================================================================
// TYPES
// =============================================================================

export interface ReadAvailabilityParams {
	/** Service name to match against the service list */
	readonly serviceName: string;
	/** Appointment type ID (used to verify correct service selected) */
	readonly appointmentTypeId?: string;
	/** Target month (YYYY-MM) — navigates calendar if provided */
	readonly targetMonth?: string;
	/** How many months ahead to scan (default 2) */
	readonly monthsToScan?: number;
}

export interface AvailableDateResult {
	readonly date: string; // YYYY-MM-DD
	readonly slots: number; // estimated (1 = available, we don't know exact count without clicking)
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Read available dates by navigating through the Acuity wizard to the calendar.
 *
 * Flow:
 * 1. Load service page → find service → click "Book"
 * 2. Land on calendar page
 * 3. Read enabled (non-disabled) tiles for current month
 * 4. Optionally advance to next months and read more
 */
export const readAvailableDates = (params: ReadAvailabilityParams) =>
	Effect.gen(function* () {
		const { acquirePage, config } = yield* BrowserService;
		const page: Page = yield* acquirePage;

		// Step 1: Load service page
		yield* Effect.tryPromise({
			try: () => page.goto(config.baseUrl, { waitUntil: 'networkidle', timeout: config.timeout }),
			catch: (e) =>
				new WizardStepError({
					step: 'read-availability',
					message: `Failed to load service page: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		// Step 2: Click the target service's "Book" button (shared)
		yield* clickServiceBook(params.serviceName, params.appointmentTypeId, 'read-availability');

		// Step 3: Read available dates from calendar
		const monthsToScan = params.monthsToScan ?? 2;
		const allDates: AvailableDateResult[] = [];

		// If a specific target month is requested, navigate to it first (shared)
		if (params.targetMonth) {
			const [yearStr, monthStr] = params.targetMonth.split('-');
			const targetYear = parseInt(yearStr, 10);
			const targetMonthIdx = parseInt(monthStr, 10) - 1;
			yield* navigateToMonth(page, targetMonthIdx, targetYear, 'read-availability');
		}

		for (let i = 0; i < monthsToScan; i++) {
			const dates = yield* readCalendarDates(page);
			allDates.push(...dates);

			// Advance to next month if more scanning needed
			if (i < monthsToScan - 1) {
				const advanced = yield* advanceMonth(page);
				if (!advanced) break; // No more months available
			}
		}

		return allDates;
	});

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Read all available (non-disabled) dates from the currently visible calendar month.
 */
const readCalendarDates = (page: Page): Effect.Effect<AvailableDateResult[], WizardStepError> =>
	Effect.gen(function* () {
		// Wait for calendar
		yield* resolveSelector(page, Selectors.calendar, 10000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new WizardStepError({
						step: 'read-availability',
						message: 'Calendar did not load',
					}),
				),
			),
		);

		// Get current month/year from calendar label (shared)
		const monthInfo = yield* getCurrentCalendarMonth(page).pipe(
			Effect.flatMap((info) =>
				info
					? Effect.succeed(info)
					: Effect.fail(new WizardStepError({
						step: 'read-availability',
						message: 'Could not determine calendar month after retries',
					})),
			),
		);

		// Read all non-disabled, non-neighboring-month tiles
		const dates = yield* Effect.tryPromise({
			try: async () => {
				const results: AvailableDateResult[] = [];
				const tiles = await page.$$(Selectors.calendarDay[0]);

				for (const tile of tiles) {
					const isDisabled = await tile.evaluate((el) => (el as HTMLButtonElement).disabled);
					if (isDisabled) continue;

					const classes = (await tile.getAttribute('class')) ?? '';
					if (classes.includes('neighboringMonth')) continue;

					const text = await tile.textContent();
					const dayNum = parseInt(text?.trim() ?? '', 10);
					if (isNaN(dayNum) || dayNum < 1 || dayNum > 31) continue;

					// Build YYYY-MM-DD from month info + day
					const dateStr = `${monthInfo.year}-${String(monthInfo.month + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
					results.push({ date: dateStr, slots: 1 });
				}

				return results;
			},
			catch: (e) =>
				new WizardStepError({
					step: 'read-availability',
					message: `Error reading calendar tiles: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		return dates;
	});

/**
 * Advance to the next month. Returns false if next button is not available.
 */
const advanceMonth = (page: Page): Effect.Effect<boolean, WizardStepError> =>
	Effect.gen(function* () {
		const btn = yield* Effect.tryPromise({
			try: () => page.$(Selectors.calendarNext[0]),
			catch: () => null,
		}).pipe(Effect.orElseSucceed(() => null));

		if (!btn) return false;

		const isDisabled = yield* Effect.tryPromise({
			try: () => btn.evaluate((el) => (el as HTMLButtonElement).disabled),
			catch: () => true,
		}).pipe(Effect.orElseSucceed(() => true));

		if (isDisabled) return false;

		yield* Effect.tryPromise({
			try: async () => {
				await btn.click();
				await page.waitForTimeout(500);
			},
			catch: (e) =>
				new WizardStepError({
					step: 'read-availability',
					message: `Failed to advance month: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		return true;
	});
