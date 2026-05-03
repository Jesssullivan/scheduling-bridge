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
import type { Page } from 'playwright-core';
import { BrowserService } from '../../../shared/browser-service.js';
import { ndjsonLog } from '../../../shared/logger.js';
import { observePageOpEffect } from '../../../shared/metrics.js';
import { WizardStepError } from '../errors.js';
import { Selectors } from '../selectors.js';
import { parseSlotText, buildIsoDatetime } from '../slot-parser.js';
import { navigateToMonth, parseYearMonthKey } from '../wizard-calendar.js';
import {
	buildSlotReadProfileEvent,
	createSlotReadProfile,
	getSlotReadProfileConfig,
	type SlotReadProfileContext,
	shouldLogSlotReadProfile,
} from './slot-read-profile.js';

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

const navigateForUrlRead = async (page: Page, url: URL, timeout: number): Promise<void> => {
	// Acuity can leave background requests open long after the calendar DOM is
	// useful. Bound the network-idle wait so empty days do not become 30s 500s.
	await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout });
	await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 5000) }).catch(() => {});
};

const postClickSlotSettleMs = (): number => {
	const raw = Number(process.env.ACUITY_POST_CLICK_SLOT_SETTLE_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 900;
};

const waitForSlotUiAfterDateClick = async (
	page: Page,
	slotSelector: string,
	timeout: number,
): Promise<void> => {
	const waitMs = Math.min(timeout, postClickSlotSettleMs());
	if (waitMs <= 0) return;

	await Promise.race([
		page.waitForSelector(slotSelector, { timeout: waitMs }).then(() => undefined),
		page.waitForLoadState('networkidle', { timeout: waitMs }).then(() => undefined).catch(() => undefined),
		page.waitForTimeout(waitMs).then(() => undefined),
	]).catch(() => undefined);
};

const navigateToServiceCalendar = (
	page: Page,
	url: URL,
	timeout: number,
	step: 'read-availability' | 'read-slots',
): Effect.Effect<void, WizardStepError> =>
	Effect.tryPromise({
		try: () => navigateForUrlRead(page, url, timeout),
		catch: (e) => new WizardStepError({ step, message: `Navigation failed: ${e}` }),
	});

const navigateToTargetMonth = (
	page: Page,
	targetMonth: string | undefined,
	step: 'read-availability' | 'read-slots',
): Effect.Effect<void, WizardStepError> => {
	if (!targetMonth) return Effect.void;

	const parsed = parseYearMonthKey(targetMonth);
	if (!parsed) {
		return Effect.fail(new WizardStepError({
			step,
			message: `Invalid target month: ${targetMonth}`,
		}));
	}

	return navigateToMonth(page, parsed.month, parsed.year, step);
};

const readEnabledCalendarDates = (
	page: Page,
	tileSelector: string,
): Effect.Effect<UrlDateResult[], WizardStepError> =>
	Effect.tryPromise({
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
	observePageOpEffect('availability_dates', Effect.gen(function* () {
		const { acquirePage, config } = yield* BrowserService;
		const page = yield* acquirePage.pipe(
			Effect.mapError((e) => new WizardStepError({ step: 'read-availability', message: `Browser error: ${e._tag}` })),
		);

		const url = new URL(config.baseUrl);
		url.searchParams.set('appointmentType', serviceId);

		yield* navigateToServiceCalendar(page, url, config.timeout, 'read-availability');
		yield* navigateToTargetMonth(page, targetMonth, 'read-availability');

		// Wait for calendar tiles using the Selectors registry
		const calendarSelector = Selectors.calendarDay.join(', ');
		yield* Effect.tryPromise({
			try: () => page.waitForSelector(calendarSelector, { timeout: 10000 }),
			catch: () => null,
		}).pipe(Effect.ignore);

		const tileSelector = Selectors.calendarDay[0]; // .react-calendar__tile
		let dates = yield* readEnabledCalendarDates(page, tileSelector);
		if (dates.length > 0) {
			return dates;
		}

		// Acuity occasionally paints the calendar shell before enabled dates are attached.
		// Give the same page a short second chance before treating the month as empty.
		yield* Effect.tryPromise({
			try: () => page.waitForTimeout(750),
			catch: () => null,
		}).pipe(Effect.ignore);

		dates = yield* readEnabledCalendarDates(page, tileSelector);
		if (dates.length > 0) {
			return dates;
		}

		// Final fallback: reload once and retry the DOM read. This is still cheaper
		// than returning a false-empty month to the app and stranding the calendar.
		yield* Effect.tryPromise({
			try: () => navigateForUrlRead(page, url, config.timeout),
			catch: (e) => new WizardStepError({ step: 'read-availability', message: `Retry navigation failed: ${e}` }),
		});
		yield* navigateToTargetMonth(page, targetMonth, 'read-availability');
		yield* Effect.tryPromise({
			try: () => page.waitForSelector(calendarSelector, { timeout: 10000 }),
			catch: () => null,
		}).pipe(Effect.ignore);

		return yield* readEnabledCalendarDates(page, tileSelector);
	}));

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
	context?: SlotReadProfileContext,
): Effect.Effect<UrlSlotResult[], WizardStepError, BrowserService | Scope.Scope> =>
	observePageOpEffect('availability_slots', Effect.gen(function* () {
		const { acquirePage, config } = yield* BrowserService;
		const profileConfig = getSlotReadProfileConfig();
		const page = yield* acquirePage.pipe(
			Effect.mapError((e) => new WizardStepError({ step: 'read-slots', message: `Browser error: ${e._tag}` })),
		);

		let navigationMs = 0;
		let calendarReadyMs = 0;
		let dateSelectMs = 0;
		let postClickSettleMs = 0;
		let slotWaitMs = 0;
		let slotDomReadMs = 0;
		let parseMs = 0;
		let calendarTileCount = 0;
		let matchedDateFound = false;

		const url = new URL(config.baseUrl);
		url.searchParams.set('appointmentType', serviceId);
		url.searchParams.set('date', date);
		const targetMonth = date.slice(0, 7);
		const slotSelector = Selectors.timeSlot[0]; // button.time-selection
		const fallbackSelector = Selectors.timeSlot.join(', ');

		const navigationStartedAt = Date.now();
		yield* navigateToServiceCalendar(page, url, config.timeout, 'read-slots');
		yield* navigateToTargetMonth(page, targetMonth, 'read-slots');
		navigationMs = Date.now() - navigationStartedAt;

		// Click the target date on the calendar. Disabled dates are a valid
		// "no availability" result, not a scrape failure.
		const tileSelector = Selectors.calendarDay[0];
		const clickedTargetDate = yield* Effect.tryPromise({
			try: async () => {
				const calendarReadyStartedAt = Date.now();
				await page.waitForSelector(tileSelector, { timeout: 10000 }).catch(() => {});
				calendarReadyMs = Date.now() - calendarReadyStartedAt;

				const dateSelectStartedAt = Date.now();
				const tiles = await page.$$(tileSelector);
				calendarTileCount = tiles.length;
				for (const tile of tiles) {
					const abbr = await tile.$('abbr');
					const label = await abbr?.getAttribute('aria-label');
					if (label) {
						const d = new Date(label);
						if (d.toISOString().slice(0, 10) === date) {
							matchedDateFound = true;
							const disabled = await tile.evaluate((el) => {
								const button = el as HTMLButtonElement;
								return (
									button.disabled ||
									button.getAttribute('aria-disabled') === 'true' ||
									button.classList.contains('react-calendar__tile--disabled')
								);
							});
							if (disabled) {
								dateSelectMs = Date.now() - dateSelectStartedAt;
								return false;
							}
								await tile.click({ timeout: Math.min(config.timeout, 5000) });
								dateSelectMs = Date.now() - dateSelectStartedAt;

								const settleStartedAt = Date.now();
								await waitForSlotUiAfterDateClick(page, fallbackSelector, config.timeout);
								postClickSettleMs = Date.now() - settleStartedAt;
								return true;
							}
					}
				}
				dateSelectMs = Date.now() - dateSelectStartedAt;
				return false;
			},
			catch: (e) => new WizardStepError({ step: 'read-slots', message: `Date click failed: ${e}` }),
		});

		if (!clickedTargetDate) {
			const profile = createSlotReadProfile({
				serviceId,
				date,
				thresholdMs: profileConfig.thresholdMs,
				calendarTileCount,
				matchedDateFound,
				slotCount: 0,
				parsedSlotCount: 0,
				phases: {
					navigationMs,
					calendarReadyMs,
					dateSelectMs,
					postClickSettleMs,
					slotWaitMs,
					slotDomReadMs,
					parseMs,
				},
				context,
			});

			if (shouldLogSlotReadProfile(profile, profileConfig)) {
				ndjsonLog('INFO', 'Slot read profile', { ...buildSlotReadProfileEvent(profile) });
			}

			return [];
		}

			// Read time slots using the Selectors registry
			const slotWaitStartedAt = Date.now();
		yield* Effect.tryPromise({
			try: () => page.waitForSelector(fallbackSelector, { timeout: 10000 }),
			catch: () => null,
		}).pipe(Effect.ignore);
		slotWaitMs = Date.now() - slotWaitStartedAt;

		const slotDomReadStartedAt = Date.now();
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
		slotDomReadMs = Date.now() - slotDomReadStartedAt;

		// Parse slot text and build full ISO datetime (e.g., "4:00 PM" → "2026-04-01T16:00:00")
		const parseStartedAt = Date.now();
		let parsedSlotCount = 0;
		const parsedSlots = slots.map(s => {
			const parsed = parseSlotText(s.datetime);
			if (parsed) parsedSlotCount += 1;
			return {
				datetime: parsed ? buildIsoDatetime(date, parsed.time) : s.datetime,
				available: s.available,
			};
		});
		parseMs = Date.now() - parseStartedAt;
		const profile = createSlotReadProfile({
			serviceId,
			date,
			thresholdMs: profileConfig.thresholdMs,
			calendarTileCount,
			matchedDateFound,
			slotCount: slots.length,
			parsedSlotCount,
			phases: {
				navigationMs,
				calendarReadyMs,
				dateSelectMs,
				postClickSettleMs,
				slotWaitMs,
				slotDomReadMs,
				parseMs,
			},
			context,
		});

		if (shouldLogSlotReadProfile(profile, profileConfig)) {
			ndjsonLog('INFO', 'Slot read profile', { ...buildSlotReadProfileEvent(profile) });
		}

		return parsedSlots;
	}));
