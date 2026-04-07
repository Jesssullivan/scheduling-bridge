/**
 * Wizard Steps: URL-Parameter-Based Availability Reading
 *
 * Navigate directly to a service's calendar via ?appointmentType={id}
 * query parameter, bypassing click-through category navigation
 * (which breaks with collapseCategories: true).
 *
 * These are the primary codepath for /availability/dates and
 * /availability/slots endpoints on the middleware server.
 */

import { Effect, Scope } from 'effect';
import { BrowserService } from '../../../shared/browser-service.js';
import { WizardStepError } from '../errors.js';
import { Selectors } from '../selectors.js';
import { parseSlotText, buildIsoDatetime } from '../slot-parser.js';

// =============================================================================
// TYPES
// =============================================================================

export interface UrlDateResult {
	readonly date: string;  // YYYY-MM-DD
	readonly slots: number; // 1 = available (exact count unknown without clicking)
}

export interface UrlSlotResult {
	readonly datetime: string; // time string like "4:00 PM"
	readonly available: boolean;
}

// =============================================================================
// READ DATES VIA URL PARAM
// =============================================================================

/**
 * Read available dates by navigating directly to a service's calendar
 * via ?appointmentType={id} URL parameter.
 *
 * @param serviceId - Acuity numeric appointment type ID
 * @param targetMonth - Optional YYYY-MM to navigate to specific month
 */
export const readDatesViaUrl = (
	serviceId: string,
	targetMonth?: string,
): Effect.Effect<UrlDateResult[], WizardStepError, BrowserService | Scope.Scope> =>
	Effect.gen(function* () {
		const { acquirePage, config } = yield* BrowserService;
		const page = yield* acquirePage.pipe(
			Effect.mapError((e) => new WizardStepError({ step: 'read-availability', message: `Browser error: ${e._tag}` })),
		);

		const url = new URL(config.baseUrl);
		url.searchParams.set('appointmentType', serviceId);
		if (targetMonth) url.searchParams.set('month', targetMonth);

		yield* Effect.tryPromise({
			try: () => page.goto(url.toString(), { waitUntil: 'networkidle', timeout: config.timeout }),
			catch: (e) => new WizardStepError({ step: 'read-availability', message: `Navigation failed: ${e}` }),
		});

		// Wait for calendar tiles using the Selectors registry
		const calendarSelector = Selectors.calendarDay.join(', ');
		yield* Effect.tryPromise({
			try: () => page.waitForSelector(calendarSelector, { timeout: 10000 }),
			catch: () => null,
		}).pipe(Effect.ignore);

		// Read enabled calendar tiles
		const tileSelector = Selectors.calendarDay[0]; // .react-calendar__tile
		const dates = yield* Effect.tryPromise({
			try: () => page.evaluate((sel) => {
				const results: Array<{ date: string; slots: number }> = [];
				const neighboringClass = 'react-calendar__tile--neighboringMonth';
				document.querySelectorAll(sel).forEach(tile => {
					if ((tile as HTMLButtonElement).disabled) return;
					if (tile.classList.contains(neighboringClass)) return;

					const abbr = tile.querySelector('abbr');
					const label = abbr?.getAttribute('aria-label') || tile.getAttribute('data-date') || '';
					if (label) {
						const d = new Date(label);
						if (!isNaN(d.getTime())) {
							results.push({ date: d.toISOString().slice(0, 10), slots: 1 });
						}
					}
				});
				return results;
			}, tileSelector),
			catch: (e) => new WizardStepError({ step: 'read-availability', message: `Calendar read failed: ${e}` }),
		});

		return dates;
	});

// =============================================================================
// READ SLOTS VIA URL PARAM
// =============================================================================

/**
 * Read time slots by navigating directly to a service's calendar
 * via ?appointmentType={id}&date={YYYY-MM-DD} URL parameters,
 * then clicking the target date tile.
 *
 * @param serviceId - Acuity numeric appointment type ID
 * @param date - Target date in YYYY-MM-DD format
 */
export const readSlotsViaUrl = (
	serviceId: string,
	date: string,
): Effect.Effect<UrlSlotResult[], WizardStepError, BrowserService | Scope.Scope> =>
	Effect.gen(function* () {
		const { acquirePage, config } = yield* BrowserService;
		const page = yield* acquirePage.pipe(
			Effect.mapError((e) => new WizardStepError({ step: 'read-slots', message: `Browser error: ${e._tag}` })),
		);

		const url = new URL(config.baseUrl);
		url.searchParams.set('appointmentType', serviceId);
		url.searchParams.set('date', date);

		yield* Effect.tryPromise({
			try: () => page.goto(url.toString(), { waitUntil: 'networkidle', timeout: config.timeout }),
			catch: (e) => new WizardStepError({ step: 'read-slots', message: `Navigation failed: ${e}` }),
		});

		// Click the target date on the calendar
		const tileSelector = Selectors.calendarDay[0];
		yield* Effect.tryPromise({
			try: async () => {
				await page.waitForSelector(tileSelector, { timeout: 10000 }).catch(() => {});
				const tiles = await page.$$(tileSelector);
				for (const tile of tiles) {
					const abbr = await tile.$('abbr');
					const label = await abbr?.getAttribute('aria-label');
					if (label) {
						const d = new Date(label);
						if (d.toISOString().slice(0, 10) === date) {
							await tile.click();
							break;
						}
					}
				}
				await page.waitForTimeout(2000);
			},
			catch: (e) => new WizardStepError({ step: 'read-slots', message: `Date click failed: ${e}` }),
		});

		// Read time slots using the Selectors registry
		const slotSelector = Selectors.timeSlot[0]; // button.time-selection
		const fallbackSelector = Selectors.timeSlot.join(', ');
		yield* Effect.tryPromise({
			try: () => page.waitForSelector(fallbackSelector, { timeout: 10000 }),
			catch: () => null,
		}).pipe(Effect.ignore);

		const slots = yield* Effect.tryPromise({
			try: () => page.evaluate((sel) => {
				const results: Array<{ datetime: string; available: boolean }> = [];
				document.querySelectorAll(sel).forEach(btn => {
					const raw = btn.textContent?.trim() || '';
					const disabled = btn.hasAttribute('disabled');
					if (raw) {
						results.push({ datetime: raw, available: !disabled });
					}
				});
				return results;
			}, slotSelector),
			catch: (e) => new WizardStepError({ step: 'read-slots', message: `Slots read failed: ${e}` }),
		});

		// Parse slot text and build full ISO datetime (e.g., "4:00 PM" → "2026-04-01T16:00:00")
		return slots.map(s => {
			const parsed = parseSlotText(s.datetime);
			return {
				datetime: parsed ? buildIsoDatetime(date, parsed.time) : s.datetime,
				available: s.available,
			};
		});
	});
