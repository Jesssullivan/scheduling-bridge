/**
 * Wizard Step: Extract Confirmation Data
 *
 * Reads the confirmation page to extract booking details:
 * appointment ID, confirmation code, service, date/time, provider.
 * Maps the scraped data to the Booking type.
 */

import { Effect } from 'effect';
import type { Page } from 'playwright-core';
import { BrowserService } from '../../../shared/browser-service.js';
import { WizardStepError } from '../errors.js';
import { probe, Selectors } from '../selectors.js';
import type { Booking, BookingRequest, ClientInfo } from '../../../core/types.js';

// =============================================================================
// TYPES
// =============================================================================

export interface ConfirmationData {
	readonly appointmentId: string | null;
	readonly confirmationCode: string | null;
	readonly serviceName: string | null;
	readonly datetime: string | null;
	readonly providerName: string | null;
	readonly rawText: string;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Extract booking confirmation data from the current page.
 * Assumes we're already on the confirmation page.
 */
export const extractConfirmation = () =>
	Effect.gen(function* () {
		const { acquirePage, screenshot, config } = yield* BrowserService;
		const page: Page = yield* acquirePage;

		// Verify we're on the confirmation page (check selectors, URL, and body text)
		const onConfirmation = yield* probe(page, 'confirmationPage');
		const urlMatch = /\/(confirmation|confirmed|thank-you|complete)/i.test(page.url());
		const bodyMatch = yield* Effect.tryPromise({
			try: () =>
				page.$eval('body', (el) => {
					const text = el.textContent?.toLowerCase() ?? '';
					return text.includes('booking confirmed') ||
						text.includes('appointment confirmed') ||
						text.includes('successfully booked') ||
						text.includes('your appointment is scheduled');
				}).catch(() => false),
			catch: () => false,
		}).pipe(Effect.orElseSucceed(() => false));

		if (!onConfirmation && !urlMatch && !bodyMatch) {
			return yield* Effect.fail(
				new WizardStepError({
					step: 'extract',
					message: 'Not on confirmation page - cannot extract booking data',
				}),
			);
		}

		// Extract each piece of data
		const appointmentId = yield* extractText(page, Selectors.confirmationId);
		const serviceName = yield* extractText(page, Selectors.confirmationService);
		const datetime = yield* extractText(page, Selectors.confirmationDatetime);

		// Get the full page text as fallback for parsing
		const rawText = yield* Effect.tryPromise({
			try: () => page.textContent('body').then((t) => t?.trim() ?? ''),
			catch: () => '',
		}).pipe(Effect.orElseSucceed(() => ''));

		// Try to extract confirmation code from raw text if not found via selector
		const confirmationCode =
			appointmentId ?? extractConfirmationFromText(rawText);

		// Take success screenshot for audit trail
		if (config.screenshotOnFailure) {
			yield* screenshot('booking-confirmation').pipe(Effect.ignore);
		}

		return {
			appointmentId,
			confirmationCode,
			serviceName,
			datetime,
			providerName: null, // Not extracted from confirmation page
			rawText,
		} satisfies ConfirmationData;
	});

// =============================================================================
// MAPPING
// =============================================================================

/**
 * Map extracted confirmation data + original request into a Booking object.
 */
export const toBooking = (
	confirmation: ConfirmationData,
	request: BookingRequest,
	paymentRef: string,
	paymentProcessor: string,
	service?: { name: string; duration: number; price: number; currency: string },
): Booking => ({
	id: confirmation.appointmentId ?? `wizard-${Date.now()}`,
	serviceId: request.serviceId,
	serviceName: confirmation.serviceName ?? service?.name ?? 'Unknown Service',
	providerId: request.providerId,
	providerName: confirmation.providerName ?? undefined,
	datetime: request.datetime,
	endTime: computeEndTime(request.datetime, service?.duration ?? 60),
	duration: service?.duration ?? 60,
	price: service?.price ?? 0,
	currency: service?.currency ?? 'USD',
	client: request.client,
	status: 'confirmed',
	confirmationCode: confirmation.confirmationCode ?? undefined,
	paymentStatus: 'paid',
	paymentRef: `[${paymentProcessor.toUpperCase()}] Transaction: ${paymentRef}`,
	createdAt: new Date().toISOString(),
});

// =============================================================================
// HELPERS
// =============================================================================

const extractText = (
	page: Page,
	candidates: readonly string[],
): Effect.Effect<string | null, never> =>
	Effect.gen(function* () {
		for (const selector of candidates) {
			const text = yield* Effect.tryPromise({
				try: () =>
					page.$eval(selector, (el) => el.textContent?.trim() ?? null).catch(() => null),
				catch: () => null,
			}).pipe(Effect.orElseSucceed(() => null));

			if (text) return text;
		}
		return null;
	});

const extractConfirmationFromText = (text: string): string | null => {
	// Look for patterns like "Confirmation #12345" or "Appointment ID: 12345"
	const patterns = [
		/confirmation\s*#?\s*(\w+)/i,
		/appointment\s*id\s*:?\s*(\w+)/i,
		/booking\s*#?\s*(\w+)/i,
		/reference\s*:?\s*(\w+)/i,
	];

	for (const pattern of patterns) {
		const match = text.match(pattern);
		if (match?.[1]) return match[1];
	}

	return null;
};

const computeEndTime = (datetime: string, durationMinutes: number): string => {
	try {
		const start = new Date(datetime);
		const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
		return end.toISOString();
	} catch {
		return datetime;
	}
};
