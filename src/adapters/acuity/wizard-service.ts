/**
 * Wizard Service Selection (shared)
 *
 * Consolidated clickServiceBook that uses ServiceResolver for
 * resilient service name matching, previously duplicated across
 * navigate.ts, read-availability.ts, read-slots.ts.
 */

import { Effect, Scope } from 'effect';
import type { Page } from 'playwright-core';
import { WizardStepError } from './errors.js';
import { resolveSelector, Selectors } from './selectors.js';
import { ServiceResolver } from './service-resolver.js';
import { BrowserService } from '../../shared/browser-service.js';

// =============================================================================
// TYPES
// =============================================================================

export interface ServiceBookResult {
	/** Acuity appointment type ID extracted from URL */
	readonly appointmentTypeId: string | null;
	/** Acuity calendar ID extracted from URL */
	readonly calendarId: string | null;
}

// =============================================================================
// CLICK SERVICE BOOK
// =============================================================================

/**
 * Find a service on the Acuity scheduling page and click its "Book" button.
 *
 * Uses ServiceResolver for resilient multi-strategy matching.
 * Waits for the calendar page to load after clicking Book.
 * Returns extracted IDs from the URL.
 *
 * @param serviceName - The service name to search for
 * @param appointmentTypeId - Optional Acuity numeric ID for ID-based matching
 * @param step - Step label for error messages (e.g., 'navigate', 'read-availability')
 */
export const clickServiceBook = (
	serviceName: string,
	appointmentTypeId?: string,
	step = 'navigate',
): Effect.Effect<ServiceBookResult, WizardStepError, BrowserService | ServiceResolver | Scope.Scope> =>
	Effect.gen(function* () {
		const { acquirePage } = yield* BrowserService;
		const page = yield* acquirePage.pipe(
			Effect.mapError((e) => new WizardStepError({
				step: step as WizardStepError['step'],
				message: `Browser error: ${e._tag}`,
				cause: e,
			})),
		);
		const resolver = yield* ServiceResolver;

		// Wait for service list to load
		yield* resolveSelector(page, Selectors.serviceList, 10000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(new WizardStepError({
					step: step as WizardStepError['step'],
					message: 'Service list did not load within timeout',
				})),
			),
		);

		// Resolve service using multi-strategy matching
		const resolution = yield* resolver.resolve(page, serviceName, appointmentTypeId).pipe(
			Effect.mapError((e) => new WizardStepError({
				step: step as WizardStepError['step'],
				message: e.message,
			})),
		);

		yield* Effect.logInfo('Service matched').pipe(
			Effect.annotateLogs({
				step,
				matchedName: resolution.matchedName,
				strategy: resolution.strategy,
				confidence: resolution.confidence.toFixed(2),
			}),
		);

		// Find and click the "Book" button within the matched element
		const bookBtn = yield* Effect.tryPromise({
			try: () => resolution.element.$(Selectors.serviceBookButton[0]),
			catch: (e) => new WizardStepError({
				step: step as WizardStepError['step'],
				message: `Error finding Book button: ${e}`,
			}),
		});

		if (!bookBtn) {
			return yield* Effect.fail(new WizardStepError({
				step: step as WizardStepError['step'],
				message: `"Book" button not found for service "${resolution.matchedName}"`,
			}));
		}

		// Click and wait for navigation to calendar
		yield* Effect.tryPromise({
			try: async () => {
				await bookBtn.click();
				await page.waitForURL(/\/appointment\/\d+\/calendar\/\d+/, { timeout: 10000 });
			},
			catch: (e) => new WizardStepError({
				step: step as WizardStepError['step'],
				message: `Failed to navigate after clicking Book: ${e}`,
			}),
		});

		// Extract IDs from URL
		const url = page.url();
		const aptMatch = url.match(/\/appointment\/(\d+)/);
		const calMatch = url.match(/\/calendar\/(\d+)/);

		// Verify appointment type ID if expected
		if (appointmentTypeId && aptMatch && aptMatch[1] !== appointmentTypeId) {
			yield* Effect.logWarning('Appointment type ID mismatch').pipe(
			Effect.annotateLogs({ step, expected: appointmentTypeId, actual: aptMatch[1] }),
		);
		}

		return {
			appointmentTypeId: aptMatch?.[1] ?? null,
			calendarId: calMatch?.[1] ?? null,
		};
	});
