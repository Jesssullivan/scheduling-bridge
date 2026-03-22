/**
 * Middleware Module - Server-only Acuity wizard automation
 *
 * This module provides the Effect TS-based browser middleware for
 * puppeteering the Acuity scheduling wizard. It is a SEPARATE subpath
 * export (`@tummycrypt/scheduling-kit/middleware`) and should NOT be
 * imported in client-side code (it depends on Playwright).
 *
 * @example
 * ```typescript
 * import { createWizardAdapter } from '@tummycrypt/scheduling-kit/middleware';
 * import { createSchedulingKit } from '@tummycrypt/scheduling-kit';
 * import { createVenmoAdapter } from '@tummycrypt/scheduling-kit/payments';
 *
 * const scheduler = createWizardAdapter({
 *   baseUrl: process.env.ACUITY_BASE_URL,
 *   couponCode: process.env.ACUITY_BYPASS_COUPON,
 * });
 *
 * const venmo = createVenmoAdapter({ ... });
 * const kit = createSchedulingKit(scheduler, [venmo]);
 *
 * // Full booking with Venmo payment
 * const result = await kit.completeBooking(request, 'venmo')();
 * ```
 */

// Adapter factories
export { createWizardAdapter, type WizardAdapterConfig } from './acuity-wizard.js';
export { createRemoteWizardAdapter, type RemoteAdapterConfig } from './remote-adapter.js';

// Browser service (for custom Layer composition)
export {
	BrowserService,
	BrowserServiceLive,
	BrowserServiceTest,
	defaultBrowserConfig,
	type BrowserConfig,
	type BrowserServiceShape,
} from './browser-service.js';

// Error types and bridge
export {
	BrowserError,
	SelectorError,
	WizardStepError,
	CouponError,
	toSchedulingError,
	type MiddlewareError,
} from './errors.js';

// Selector registry
export {
	Selectors,
	resolveSelector,
	resolve,
	probeSelector,
	probe,
	healthCheck,
	type SelectorKey,
	type ResolvedSelector,
} from './selectors.js';

// Individual wizard steps (for advanced composition)
export {
	navigateToBooking,
	fillFormFields,
	bypassPayment,
	generateCouponCode,
	submitBooking,
	extractConfirmation,
	toBooking,
	type NavigateParams,
	type NavigateResult,
	type FillFormParams,
	type FillFormResult,
	type BypassPaymentResult,
	type SubmitResult,
	type ConfirmationData,
} from './steps/index.js';
