/**
 * @tummycrypt/scheduling-bridge
 *
 * Backend-agnostic scheduling adapter hub.
 * Currently bridges Acuity Scheduling via Playwright automation.
 */

// Core types
export type {
	Service,
	Provider,
	TimeSlot,
	AvailableDate,
	Booking,
	BookingRequest,
	ClientInfo,
	SchedulingError,
	SchedulingResult,
	BookingStatus,
	PaymentStatus,
} from './core/types.js';
export { Errors } from './core/types.js';

// Adapter interface
export type { SchedulingAdapter } from './adapters/types.js';

// Acuity adapter
export {
	createWizardAdapter,
	type WizardAdapterConfig,
} from './adapters/acuity/wizard.js';

// Shared: remote adapter (HTTP client for remote mode)
export {
	createRemoteWizardAdapter,
	type RemoteAdapterConfig,
} from './shared/remote-adapter.js';

// Shared: browser service (Playwright lifecycle)
export {
	BrowserService,
	BrowserServiceLive,
	BrowserServiceTest,
	defaultBrowserConfig,
	type BrowserConfig,
	type BrowserServiceShape,
} from './shared/browser-service.js';

// Acuity error types
export {
	BrowserError,
	SelectorError,
	WizardStepError,
	CouponError,
	toSchedulingError,
	type MiddlewareError,
} from './adapters/acuity/errors.js';

// Acuity selector registry
export {
	Selectors,
	resolveSelector,
	resolve,
	probeSelector,
	probe,
	healthCheck,
	type SelectorKey,
	type ResolvedSelector,
} from './adapters/acuity/selectors.js';

// Scraper
export {
	createScraperAdapter,
	AcuityScraper,
	type ScraperConfig,
} from './adapters/acuity/scraper.js';

// Server
export { server } from './server/handler.js';
