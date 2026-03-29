/**
 * Wizard Step: Navigate Through Acuity Booking Wizard
 *
 * Acuity's React SPA (2026) does NOT support deep-linking via query params.
 * Instead, we click through the 5-step wizard:
 *   1. Service page (massageithaca.as.me) → find service → click "Book"
 *   2. Calendar page → navigate to target month → click target day
 *   3. Time slots → click matching slot → "Select and continue"
 *   4. Land on client form (fields empty — filling is a separate step)
 *
 * URL progression:
 *   /schedule/<hash>
 *   /schedule/<hash>/appointment/<aptId>/calendar/<calId>
 *   /schedule/<hash>/appointment/<aptId>/calendar/<calId>/datetime/<ISO>
 *
 * NOTE: Service selection, calendar navigation, and day selection
 * use shared modules (wizard-service.ts, wizard-calendar.ts) to
 * avoid code duplication with read-availability.ts and read-slots.ts.
 */

import { Effect } from 'effect';
import type { Page } from 'playwright-core';
import { BrowserService } from '../browser-service.js';
import { WizardStepError } from '../errors.js';
import { resolveSelector, probe, Selectors } from '../selectors.js';
import { navigateToMonth, selectDay } from '../wizard-calendar.js';
import { clickServiceBook } from '../wizard-service.js';
import { parseSlotText } from '../slot-parser.js';
import type { ClientInfo } from '../../core/types.js';

// =============================================================================
// TYPES
// =============================================================================

export interface NavigateParams {
	/** Appointment type name (matched against .appointment-type-name text) */
	readonly serviceName: string;
	/** Target datetime in ISO 8601 (e.g. "2026-03-15T10:00:00-05:00") */
	readonly datetime: string;
	/** Client info (not used for navigation — kept for API compat) */
	readonly client: ClientInfo;
	/** Appointment type ID — if known, verified against URL after "Book" click */
	readonly appointmentTypeId?: string;
}

export interface NavigateResult {
	readonly url: string;
	readonly landingStep: 'client-form' | 'service-selection' | 'calendar' | 'time-slots' | 'unknown';
	readonly appointmentTypeId: string | null;
	readonly calendarId: string | null;
	readonly selectedDate: string;
	readonly selectedTime: string;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Navigate through the Acuity wizard to reach the client form.
 *
 * Flow: Service page → Book → Calendar → Time slot → Select and continue
 */
export const navigateToBooking = (params: NavigateParams) =>
	Effect.gen(function* () {
		const { acquirePage, config } = yield* BrowserService;
		const page: Page = yield* acquirePage;

		// Step 1: Load service selection page
		yield* Effect.tryPromise({
			try: () => page.goto(config.baseUrl, { waitUntil: 'networkidle', timeout: config.timeout }),
			catch: (e) =>
				new WizardStepError({
					step: 'navigate',
					message: `Failed to load service page: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		// Step 2: Find and click target service's "Book" button (shared)
		const { appointmentTypeId, calendarId } = yield* clickServiceBook(
			params.serviceName,
			params.appointmentTypeId,
			'navigate',
		);

		// Step 3: Navigate calendar to target date and click (shared)
		const targetDate = parseDate(params.datetime);
		yield* navigateToMonth(page, targetDate.getMonth(), targetDate.getFullYear(), 'navigate');
		yield* selectDay(page, targetDate.getDate(), 'navigate');

		// Step 4: Select matching time slot
		const targetTime = parseTime(params.datetime);
		yield* selectTimeSlot(page, targetTime);

		// Step 5: Click "Select and continue" → land on client form
		yield* clickSelectAndContinue(page);

		// Verify we landed on the client form
		const landingStep = yield* detectLandingStep(page);

		return {
			url: page.url(),
			landingStep,
			appointmentTypeId,
			calendarId,
			selectedDate: targetDate.toISOString().split('T')[0],
			selectedTime: targetTime,
		} satisfies NavigateResult;
	});

// =============================================================================
// STEP 4: TIME SLOT SELECTION
// =============================================================================

/**
 * Click the time slot matching our target time.
 * Uses parseSlotText to extract clean time from "10:00 AM1 spot left".
 */
const selectTimeSlot = (page: Page, targetTime: string) =>
	Effect.gen(function* () {
		const clicked = yield* Effect.tryPromise({
			try: async () => {
				const slots = await page.$$(Selectors.timeSlot[0]);
				for (const slot of slots) {
					const text = await slot.textContent();
					if (!text) continue;

					const parsed = parseSlotText(text);
					if (parsed && parsed.time.includes(targetTime)) {
						await slot.click();
						return true;
					}

					// Fallback: raw text includes check
					if (text.includes(targetTime)) {
						await slot.click();
						return true;
					}
				}
				return false;
			},
			catch: (e) =>
				new WizardStepError({
					step: 'navigate',
					message: `Error selecting time slot: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		if (!clicked) {
			return yield* Effect.fail(
				new WizardStepError({
					step: 'navigate',
					message: `Time slot "${targetTime}" not available`,
				}),
			);
		}

		// Wait for the selection menu to appear
		yield* Effect.tryPromise({
			try: () => page.waitForTimeout(1000),
			catch: () =>
				new WizardStepError({ step: 'navigate', message: 'Timeout after time slot click' }),
		});
	});

// =============================================================================
// STEP 5: "SELECT AND CONTINUE"
// =============================================================================

/**
 * Click the "Select and continue" menu item.
 * This is an <li role="menuitem">, NOT a button.
 * After clicking, waits for URL to include /datetime/.
 */
const clickSelectAndContinue = (page: Page): Effect.Effect<void, WizardStepError> =>
	Effect.gen(function* () {
		const menuItem = yield* resolveSelector(page, Selectors.selectAndContinue, 5000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new WizardStepError({
						step: 'navigate',
						message: '"Select and continue" option not found after selecting time slot',
					}),
				),
			),
		);

		yield* Effect.tryPromise({
			try: async () => {
				await menuItem.element.click();
				// Wait for navigation to client form page
				await page.waitForURL(/\/datetime\//, { timeout: 10000 });
			},
			catch: (e) =>
				new WizardStepError({
					step: 'navigate',
					message: `Failed to advance to client form: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});
	});

// =============================================================================
// HELPERS
// =============================================================================

const detectLandingStep = (page: Page) =>
	Effect.gen(function* () {
		const hasClientForm = yield* probe(page, 'firstNameInput');
		if (hasClientForm) return 'client-form' as const;

		const hasTimeSlots = yield* probe(page, 'timeSlot');
		if (hasTimeSlots) return 'time-slots' as const;

		const hasCalendar = yield* probe(page, 'calendarDay');
		if (hasCalendar) return 'calendar' as const;

		const hasServiceList = yield* probe(page, 'serviceList');
		if (hasServiceList) return 'service-selection' as const;

		return 'unknown' as const;
	});

/**
 * Parse a Date from ISO 8601 datetime string.
 */
const parseDate = (datetime: string): Date => {
	const d = new Date(datetime);
	if (isNaN(d.getTime())) {
		throw new Error(`Invalid datetime: ${datetime}`);
	}
	return d;
};

/**
 * Extract formatted time from ISO 8601 for matching against slot text.
 * Returns "10:00 AM" format to match Acuity's "10:00 AM1 spot left" text.
 */
const parseTime = (datetime: string): string => {
	const d = new Date(datetime);
	const hours = d.getHours();
	const minutes = d.getMinutes();
	const ampm = hours >= 12 ? 'PM' : 'AM';
	const h = hours % 12 || 12;
	const m = minutes.toString().padStart(2, '0');
	return `${h}:${m} ${ampm}`;
};
