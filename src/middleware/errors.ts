/**
 * Middleware Error Types
 *
 * Effect TS error types for the Acuity wizard middleware.
 * Bridges to adapter-layer SchedulingError at the adapter boundary.
 */

import { Data } from 'effect';
import { Errors, type SchedulingError } from '../core/types.js';

// =============================================================================
// ERROR CLASSES
// =============================================================================

export class BrowserError extends Data.TaggedError('BrowserError')<{
	readonly reason:
		| 'PLAYWRIGHT_MISSING'
		| 'LAUNCH_FAILED'
		| 'PAGE_FAILED'
		| 'SCREENSHOT_FAILED'
		| 'NAVIGATION_FAILED';
	readonly cause?: unknown;
}> {}

export class SelectorError extends Data.TaggedError('SelectorError')<{
	readonly candidates: readonly string[];
	readonly message: string;
}> {}

export class WizardStepError extends Data.TaggedError('WizardStepError')<{
	readonly step: 'navigate' | 'fill-form' | 'bypass-payment' | 'submit' | 'extract' | 'read-availability' | 'read-slots' | 'extract-business';
	readonly message: string;
	readonly screenshot?: Buffer;
	readonly cause?: unknown;
}> {}

export class CouponError extends Data.TaggedError('CouponError')<{
	readonly code: string;
	readonly message: string;
}> {}

export class ServiceResolverError extends Data.TaggedError('ServiceResolverError')<{
	readonly serviceName: string;
	readonly strategies: readonly string[];
	readonly message: string;
}> {}

export type MiddlewareError = BrowserError | SelectorError | WizardStepError | CouponError | ServiceResolverError;

// =============================================================================
// BRIDGE: Effect middleware errors -> adapter-layer SchedulingError
// =============================================================================

/**
 * Convert Effect middleware errors to adapter-layer SchedulingError
 * for compatibility with the existing booking pipeline.
 */
export const toSchedulingError = (error: MiddlewareError): SchedulingError => {
	switch (error._tag) {
		case 'BrowserError':
			return Errors.infrastructure(
				error.reason === 'PLAYWRIGHT_MISSING' ? 'UNKNOWN' : 'NETWORK',
				`Browser error: ${error.reason}`,
				error.cause instanceof Error ? error.cause : undefined,
			);
		case 'SelectorError':
			return Errors.acuity('SCRAPE_FAILED', error.message);
		case 'WizardStepError':
			return Errors.acuity(
				'SCRAPE_FAILED',
				`Wizard step '${error.step}' failed: ${error.message}`,
			);
		case 'CouponError':
			return Errors.acuity('BOOKING_FAILED', `Coupon error: ${error.message}`);
		case 'ServiceResolverError':
			return Errors.acuity('SCRAPE_FAILED', `Service resolution failed: ${error.message}`);
	}
};
