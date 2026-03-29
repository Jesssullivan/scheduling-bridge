/**
 * Wizard Step: Read Time Slots from Acuity Calendar
 *
 * Navigates to the service calendar via click-through,
 * advances to the target date, clicks the day tile,
 * and reads all available time slot buttons.
 *
 * NOTE: Service selection, calendar navigation, and day selection
 * use shared modules (wizard-service.ts, wizard-calendar.ts) to
 * avoid code duplication with navigate.ts and read-availability.ts.
 */

import { Effect } from 'effect';
import type { Page } from 'playwright-core';
import { BrowserService } from '../browser-service.js';
import { WizardStepError } from '../errors.js';
import { Selectors } from '../selectors.js';
import { navigateToMonth, selectDay } from '../wizard-calendar.js';
import { clickServiceBook } from '../wizard-service.js';
import { parseSlotText, buildIsoDatetime } from '../slot-parser.js';

// =============================================================================
// TYPES
// =============================================================================

export interface ReadSlotsParams {
	/** Service name to match against the service list */
	readonly serviceName: string;
	/** Appointment type ID (used to verify correct service selected) */
	readonly appointmentTypeId?: string;
	/** Target date (YYYY-MM-DD) */
	readonly date: string;
}

export interface SlotResult {
	readonly datetime: string; // ISO 8601
	readonly available: boolean;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Read time slots for a specific date by navigating the Acuity wizard.
 *
 * Flow:
 * 1. Load service page → find service → click "Book"
 * 2. Navigate calendar to target month
 * 3. Click target day tile
 * 4. Read all time slot buttons
 */
export const readTimeSlots = (params: ReadSlotsParams) =>
	Effect.gen(function* () {
		const { acquirePage, config } = yield* BrowserService;
		const page: Page = yield* acquirePage;

		// Step 1: Load service page
		yield* Effect.tryPromise({
			try: () => page.goto(config.baseUrl, { waitUntil: 'networkidle', timeout: config.timeout }),
			catch: (e) =>
				new WizardStepError({
					step: 'read-slots',
					message: `Failed to load service page: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		// Step 2: Click the target service's "Book" button (shared)
		yield* clickServiceBook(params.serviceName, params.appointmentTypeId, 'read-slots');

		// Step 3: Navigate to the target month (shared)
		const targetDate = new Date(params.date + 'T12:00:00');
		yield* navigateToMonth(
			page,
			targetDate.getMonth(),
			targetDate.getFullYear(),
			'read-slots',
		);

		// Step 4: Click the target day (shared)
		yield* selectDay(page, targetDate.getDate(), 'read-slots');

		// Step 5: Read time slots
		const slots = yield* readSlotButtons(page, params.date);

		return slots;
	});

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Read all time slot buttons and return structured data.
 * Uses parseSlotText to properly extract time from "10:00 AM1 spot left".
 */
const readSlotButtons = (
	page: Page,
	dateStr: string,
): Effect.Effect<SlotResult[], WizardStepError> =>
	Effect.tryPromise({
		try: async () => {
			const results: SlotResult[] = [];
			const slots = await page.$$(Selectors.timeSlot[0]);

			for (const slot of slots) {
				const text = await slot.textContent();
				if (!text) continue;

				const parsed = parseSlotText(text);
				if (!parsed) continue;

				const datetime = buildIsoDatetime(dateStr, parsed.time);
				results.push({ datetime, available: true });
			}

			return results;
		},
		catch: (e) =>
			new WizardStepError({
				step: 'read-slots',
				message: `Error reading slots: ${e instanceof Error ? e.message : String(e)}`,
				cause: e,
			}),
	});
