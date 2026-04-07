/**
 * Acuity Adapter Module — Playwright-based Acuity scheduling automation
 *
 * This module provides the Effect TS-based browser automation for
 * puppeteering the Acuity booking wizard. It is a SEPARATE subpath
 * export and should NOT be imported in client-side code (it depends
 * on Playwright).
 *
 * @example
 * ```typescript
 * import { createWizardAdapter } from '@tummycrypt/scheduling-bridge/adapters/acuity';
 * import { createSchedulingKit } from '@tummycrypt/scheduling-kit';
 *
 * const scheduler = createWizardAdapter({
 *   baseUrl: process.env.ACUITY_BASE_URL,
 *   couponCode: process.env.ACUITY_BYPASS_COUPON,
 * });
 * ```
 */

// Adapter factories
export { createWizardAdapter, type WizardAdapterConfig } from './wizard.js';

// Scraper (deprecated — use BUSINESS extraction)
export { createScraperAdapter, AcuityScraper, type ScraperConfig } from './scraper.js';

// Error types and bridge
export {
	BrowserError,
	SelectorError,
	WizardStepError,
	CouponError,
	ServiceResolverError,
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

// Selector health check
export {
	selectorHealthCheck,
	type SelectorProbeResult,
	type SelectorHealthReport,
} from './selector-health.js';

// Service resolver (multi-strategy name matching)
export {
	ServiceResolver,
	ServiceResolverLive,
	ServiceResolverTest,
	normalize,
	tokenOverlap,
	levenshtein,
	fuzzyConfidence,
	type ServiceResolution,
	type ServiceResolverShape,
} from './service-resolver.js';

// Slot parser
export { parseSlotText, buildIsoDatetime } from './slot-parser.js';

// Calendar operations
export {
	MONTH_NAMES,
	getCurrentCalendarMonth,
	clickCalendarNav,
	navigateToMonth,
	selectDay,
} from './wizard-calendar.js';

// Service selection
export { clickServiceBook, type ServiceBookResult } from './wizard-service.js';

// Individual wizard steps (for advanced composition)
export {
	navigateToBooking,
	fillFormFields,
	bypassPayment,
	generateCouponCode,
	submitBooking,
	extractConfirmation,
	toBooking,
	readAvailableDates,
	readTimeSlots,
	extractBusinessFromPage,
	extractBusinessFromHtml,
	extractBusinessServices,
	fetchBusinessData,
	businessToServices,
	type NavigateParams,
	type NavigateResult,
	type FillFormParams,
	type FillFormResult,
	type BypassPaymentResult,
	type SubmitResult,
	type ConfirmationData,
	type ReadAvailabilityParams,
	type AvailableDateResult,
	type ReadSlotsParams,
	type SlotResult,
	type AcuityAppointmentType,
	type AcuityCalendar,
	type AcuityBusinessData,
} from './steps/index.js';
