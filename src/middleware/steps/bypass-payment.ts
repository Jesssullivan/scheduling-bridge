/**
 * Wizard Step: Bypass Payment
 *
 * Applies a 100% gift certificate code on Acuity's payment page to bypass
 * the credit card requirement. This allows the booking to complete at $0,
 * since actual payment is handled by our Venmo/Cash adapters.
 *
 * Strategy: A pre-configured gift certificate in Acuity admin covers the full amount.
 * The certificate code is passed as ACUITY_BYPASS_COUPON env var.
 *
 * Acuity's payment page coupon flow (verified 2026-02-26):
 *   1. Page is at URL .../datetime/<ISO>/payment
 *   2. Click "Package, gift, or coupon code" toggle to expand the coupon section
 *   3. Enter the gift certificate code in the "Enter code" input
 *   4. Click "Apply" to validate the code
 *   5. Acuity calls POST /api/scheduling/v1/appointments/order-summary
 *      with certificateCode in the body; response includes discount and total
 *   6. If successful: order summary shows "Gift certificate [CODE] -$X.XX"
 *      and total drops to $0.00
 *   7. "PAY & CONFIRM" button can now be clicked without entering card details
 *
 * Note: There IS a separate payment page (URL ends in /payment).
 * The "Check Code Balance" modal on the client form is INFORMATIONAL ONLY.
 */

import { Effect } from 'effect';
import type { Page } from 'playwright-core';
import { BrowserService } from '../browser-service.js';
import { CouponError } from '../errors.js';
import { resolveSelector, Selectors } from '../selectors.js';

// =============================================================================
// TYPES
// =============================================================================

export interface BypassPaymentResult {
	readonly couponApplied: boolean;
	readonly code: string;
	readonly totalAfterCoupon: string | null;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Apply a gift certificate code on the payment page to bypass card entry.
 *
 * Prerequisite: The wizard must already be on the payment page
 * (URL contains /payment). Call after fillFormFields + advancePastForm.
 *
 * Flow: Expand "Package, gift, or coupon code" → enter code → click "Apply"
 */
export const bypassPayment = (couponCode: string) =>
	Effect.gen(function* () {
		const { acquirePage } = yield* BrowserService;
		const page: Page = yield* acquirePage;

		// Verify we're on the payment page
		const url = page.url();
		if (!url.includes('/payment')) {
			return yield* Effect.fail(
				new CouponError({
					code: couponCode,
					message:
						`Not on payment page (URL: ${url}). ` +
						'The wizard must advance past the client form first.',
				}),
			);
		}

		// Step 1: Click "Package, gift, or coupon code" to expand the coupon section
		const couponToggle = yield* resolveSelector(page, Selectors.paymentCouponToggle, 10000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new CouponError({
						code: couponCode,
						message:
							'"Package, gift, or coupon code" toggle not found on payment page.',
					}),
				),
			),
		);

		yield* Effect.tryPromise({
			try: async () => {
				await couponToggle.element.click();
				// Wait for the coupon input to appear after expansion
				await page.waitForSelector('input[placeholder="Enter code"]', { timeout: 5000 });
			},
			catch: (e) =>
				new CouponError({
					code: couponCode,
					message: `Failed to expand coupon section: ${e instanceof Error ? e.message : String(e)}`,
				}),
		});

		// Step 2: Enter the gift certificate code
		const couponInput = yield* resolveSelector(page, Selectors.paymentCouponInput, 5000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new CouponError({
						code: couponCode,
						message: 'Coupon code input not found after expanding section',
					}),
				),
			),
		);

		yield* Effect.tryPromise({
			try: async () => {
				await couponInput.element.click();
				await couponInput.element.fill(couponCode);
			},
			catch: (e) =>
				new CouponError({
					code: couponCode,
					message: `Failed to enter coupon code: ${e instanceof Error ? e.message : String(e)}`,
				}),
		});

		// Step 3: Click "Apply" to validate the code
		const applyBtn = yield* resolveSelector(page, Selectors.paymentCouponApply, 5000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new CouponError({
						code: couponCode,
						message: '"Apply" button not found in coupon section',
					}),
				),
			),
		);

		yield* Effect.tryPromise({
			try: () => applyBtn.element.click(),
			catch: (e) =>
				new CouponError({
					code: couponCode,
					message: `Failed to click "Apply": ${e instanceof Error ? e.message : String(e)}`,
				}),
		});

		// Step 4: Wait for the order-summary API response
		// Acuity calls POST /api/scheduling/v1/appointments/order-summary
		// with certificateCode in the body.
		yield* Effect.tryPromise({
			try: () => page.waitForTimeout(3000),
			catch: () =>
				new CouponError({ code: couponCode, message: 'Timeout waiting for coupon validation' }),
		});

		// Step 5: Check if the coupon was applied
		// On success: "Gift certificate [CODE]" and "-$X.XX" appear in order summary
		// On error: Acuity may show an error message or the total remains unchanged
		const result = yield* Effect.tryPromise({
			try: async () => {
				const bodyText = await page.evaluate(() => document.body.textContent ?? '');
				const hasGiftCert = bodyText.includes('Gift certificate') && bodyText.includes(couponCode);
				const hasDiscount = bodyText.includes('-$');
				const totalMatch = bodyText.match(/Total\s*\$?([\d.]+)/);
				const total = totalMatch ? totalMatch[1] : null;
				return { hasGiftCert, hasDiscount, total };
			},
			catch: () => ({ hasGiftCert: false, hasDiscount: false, total: null }),
		}).pipe(Effect.orElseSucceed(() => ({ hasGiftCert: false, hasDiscount: false, total: null })));

		if (!result.hasGiftCert) {
			// Check for error indicators
			const errorText = yield* Effect.tryPromise({
				try: async () => {
					const errs: string[] = [];
					const errEls = await page.$$('[class*="error"], [role="alert"]');
					for (const el of errEls) {
						const text = await el.textContent().catch(() => null);
						if (text && text.trim().length > 0) errs.push(text.trim());
					}
					return errs.join('; ') || null;
				},
				catch: () => null,
			}).pipe(Effect.orElseSucceed(() => null));

			if (errorText) {
				return yield* Effect.fail(
					new CouponError({
						code: couponCode,
						message: `Coupon rejected: ${errorText}`,
					}),
				);
			}
		}

		const totalAfterCoupon = result.total ? `$${result.total}` : null;

		return {
			couponApplied: result.hasGiftCert && result.hasDiscount,
			code: couponCode,
			totalAfterCoupon,
		} satisfies BypassPaymentResult;
	});

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Generate a unique coupon code for a payment reference.
 * Format: ALT-{PROCESSOR}-{SHORT_REF}
 *
 * Note: For MVP, we use a single reusable coupon code from env.
 * This function is here for future per-transaction coupon support.
 */
export const generateCouponCode = (
	_paymentRef: string,
	_processor: string,
	envCouponCode?: string,
): string => {
	// MVP: Use pre-configured reusable coupon
	if (envCouponCode) return envCouponCode;

	// Future: Generate per-transaction code
	// return `ALT-${processor.toUpperCase()}-${paymentRef.slice(0, 8)}`;
	throw new Error(
		'ACUITY_BYPASS_COUPON environment variable is required. ' +
			'Create a 100% gift certificate in Acuity admin and set this env var.',
	);
};
