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

// Middleware exports
export {
	createWizardAdapter,
	type WizardAdapterConfig,
} from './middleware/acuity-wizard.js';

export {
	createRemoteWizardAdapter,
	type RemoteAdapterConfig,
} from './middleware/remote-adapter.js';

export {
	BrowserService,
	BrowserServiceLive,
	BrowserServiceTest,
	defaultBrowserConfig,
	type BrowserConfig,
	type BrowserServiceShape,
} from './middleware/browser-service.js';

export {
	BrowserError,
	SelectorError,
	WizardStepError,
	CouponError,
	toSchedulingError,
	type MiddlewareError,
} from './middleware/errors.js';

export {
	Selectors,
	resolveSelector,
	resolve,
	probeSelector,
	probe,
	healthCheck,
	type SelectorKey,
	type ResolvedSelector,
} from './middleware/selectors.js';

// Scraper
export {
	createScraperAdapter,
	AcuityScraper,
	type ScraperConfig,
} from './adapters/acuity-scraper.js';

// Server
export { server } from './middleware/server.js';
