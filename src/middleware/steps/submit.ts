/**
 * Wizard Step: Submit Booking
 *
 * Clicks the submit/complete button and waits for the confirmation page.
 * Handles the race between successful navigation to confirmation
 * and validation error display.
 */

import { Effect, Schedule } from 'effect';
import type { Page } from 'playwright-core';
import { BrowserService } from '../browser-service.js';
import { WizardStepError } from '../errors.js';
import { resolveSelector, probe, Selectors } from '../selectors.js';

// =============================================================================
// TYPES
// =============================================================================

export interface SubmitResult {
	readonly submitted: boolean;
	readonly confirmationPageReached: boolean;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Submit the booking form and wait for confirmation.
 */
export const submitBooking = () =>
	Effect.gen(function* () {
		const { acquirePage } = yield* BrowserService;
		const page: Page = yield* acquirePage;

		// Find submit button
		const submitBtn = yield* resolveSelector(page, Selectors.submitButton, 10000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new WizardStepError({
						step: 'submit',
						message: 'Submit button not found. The wizard may not have advanced to the final step.',
					}),
				),
			),
		);

		// Click submit
		yield* Effect.tryPromise({
			try: () => submitBtn.element.click(),
			catch: (e) =>
				new WizardStepError({
					step: 'submit',
					message: `Failed to click submit: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		// Wait for either confirmation page or error
		const outcome = yield* waitForOutcome(page);

		if (!outcome.confirmationPageReached) {
			return yield* Effect.fail(
				new WizardStepError({
					step: 'submit',
					message: outcome.errorMessage
						? `Booking submission failed: ${outcome.errorMessage}`
						: 'Booking submission did not reach confirmation page',
				}),
			);
		}

		return {
			submitted: true,
			confirmationPageReached: true,
		} satisfies SubmitResult;
	}).pipe(
		// Retry once on transient navigation failure
		Effect.retry({
			times: 1,
			schedule: Schedule.spaced('2 seconds'),
			while: (e) => e._tag === 'WizardStepError' && e.message.includes('did not reach'),
		}),
	);

// =============================================================================
// HELPERS
// =============================================================================

interface OutcomeCheck {
	confirmationPageReached: boolean;
	errorMessage: string | null;
}

/**
 * Race between confirmation page appearing and error message appearing.
 * Polls both conditions until one is met or timeout.
 */
const waitForOutcome = (page: Page): Effect.Effect<OutcomeCheck, WizardStepError> =>
	Effect.gen(function* () {
		const maxWait = 60000;
		const pollInterval = 1000;
		const start = Date.now();

		while (Date.now() - start < maxWait) {
			// Check for confirmation page via selectors
			const hasConfirmation = yield* probe(page, 'confirmationPage');
			if (hasConfirmation) {
				return { confirmationPageReached: true, errorMessage: null };
			}

			// Check for confirmation via URL pattern (Acuity redirects after booking)
			const url = page.url();
			if (/\/(confirmation|confirmed|thank-you|complete)/i.test(url)) {
				return { confirmationPageReached: true, errorMessage: null };
			}

			// Check for confirmation text anywhere on page
			const hasConfirmText = yield* Effect.tryPromise({
				try: () =>
					page
						.$eval(
							'body',
							(el) => {
								const text = el.textContent?.toLowerCase() ?? '';
								return text.includes('booking confirmed') ||
									text.includes('appointment confirmed') ||
									text.includes('successfully booked') ||
									text.includes('your appointment is scheduled');
							},
						)
						.catch(() => false),
				catch: () => false,
			}).pipe(Effect.orElseSucceed(() => false));

			if (hasConfirmText) {
				return { confirmationPageReached: true, errorMessage: null };
			}

			// Check for validation/submission errors
			const errorText = yield* Effect.tryPromise({
				try: () =>
					page
						.$eval(
							'.error-message, .validation-error, .form-error, .alert-danger',
							(el) => el.textContent?.trim() ?? null,
						)
						.catch(() => null),
				catch: () => null,
			}).pipe(Effect.orElseSucceed(() => null));

			if (errorText) {
				return { confirmationPageReached: false, errorMessage: errorText };
			}

			// Wait before next poll
			yield* Effect.tryPromise({
				try: () => page.waitForTimeout(pollInterval),
				catch: () =>
					new WizardStepError({ step: 'submit', message: 'Poll wait interrupted' }),
			});
		}

		return {
			confirmationPageReached: false,
			errorMessage: 'Timed out waiting for confirmation page',
		};
	});
