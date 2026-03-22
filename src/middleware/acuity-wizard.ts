/**
 * Acuity Wizard Adapter
 *
 * Full SchedulingAdapter implementation that uses Effect TS middleware
 * to puppeteer the Acuity booking wizard.
 *
 * Read operations:
 * - getServices: returns static service catalog (if provided) or falls back to scraper
 * - getAvailableDates: Effect program navigates wizard calendar (verified selectors)
 * - getAvailableSlots: Effect program clicks day tile and reads time buttons
 *
 * Write operations:
 * - createBooking/createBookingWithPaymentRef: Effect TS middleware via Playwright
 *
 * This is the bridge between Effect TS (middleware layer) and
 * fp-ts (pipeline/adapter layer).
 */

import { Effect, Scope, Exit, Cause } from 'effect';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';

import type { SchedulingAdapter } from '../adapters/types.js';
import { createScraperAdapter, type ScraperConfig } from '../adapters/acuity-scraper.js';
import type {
	Booking,
	BookingRequest,
	Service,
	SchedulingResult,
} from '../core/types.js';
import { Errors } from '../core/types.js';
import { BrowserServiceLive, type BrowserConfig, defaultBrowserConfig } from './browser-service.js';
import { toSchedulingError, type MiddlewareError } from './errors.js';
import { createRemoteWizardAdapter, type RemoteAdapterConfig } from './remote-adapter.js';
import {
	navigateToBooking,
	fillFormFields,
	bypassPayment,
	generateCouponCode,
	submitBooking,
	extractConfirmation,
	toBooking,
	readAvailableDates,
	readTimeSlots,
	type NavigateResult,
	type ConfirmationData,
} from './steps/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface WizardAdapterConfig extends Partial<BrowserConfig> {
	/** Base URL for the Acuity scheduling page */
	baseUrl: string;
	/** Pre-configured coupon code for payment bypass (from ACUITY_BYPASS_COUPON env) */
	couponCode?: string;
	/**
	 * Execution mode:
	 * - 'local': Run Playwright in-process (default, requires Chromium installed)
	 * - 'remote': Proxy all operations to a remote middleware server via HTTP
	 */
	mode?: 'local' | 'remote';
	/** Remote adapter config (required when mode is 'remote') */
	remote?: RemoteAdapterConfig;
	/**
	 * Static service catalog. If provided, getServices() returns this list
	 * without launching a browser. Recommended for known service sets to avoid
	 * expensive browser launches for read-only operations.
	 */
	services?: readonly Service[];
}

// =============================================================================
// EFFECT PROGRAMS
// =============================================================================

/**
 * Full booking creation via the Acuity wizard.
 *
 * Flow:
 * 1. Click through wizard: service → Book → calendar → time → continue
 * 2. Fill client form (standard + intake fields) → "Continue to Payment" → /payment page
 * 3. Apply 100% gift certificate on payment page (coupon toggle → enter code → Apply)
 * 4. Click "PAY & CONFIRM" at $0 total
 * 5. Extract confirmation data
 */
const createBookingWithPaymentRefProgram = (
	request: BookingRequest,
	paymentRef: string,
	paymentProcessor: string,
	couponCode: string,
	service?: Service,
) =>
	Effect.scoped(
		Effect.gen(function* () {
			// Step 1: Navigate through wizard to client form
			const serviceName = service?.name ?? request.serviceId;
			const nav: NavigateResult = yield* navigateToBooking({
				serviceName,
				datetime: request.datetime,
				client: request.client,
			});

			if (nav.landingStep !== 'client-form') {
				return yield* Effect.fail({
					_tag: 'WizardStepError' as const,
					step: 'navigate' as const,
					message: `Wizard landed on '${nav.landingStep}' instead of client form. Service or datetime may be unavailable.`,
				});
			}

			// Step 2: Fill form fields (standard + intake) and advance to /payment page
			yield* fillFormFields({
				client: request.client,
				customFields: request.client.customFields,
			});

			// Step 3: Apply gift certificate on the payment page (total → $0)
			yield* bypassPayment(couponCode);

			// Step 4: Click "PAY & CONFIRM" at $0 total
			yield* submitBooking();

			// Step 5: Extract confirmation
			const confirmation: ConfirmationData = yield* extractConfirmation();

			return toBooking(
				confirmation,
				request,
				paymentRef,
				paymentProcessor,
				service
					? {
							name: service.name,
							duration: service.duration,
							price: service.price,
							currency: service.currency,
						}
					: undefined,
			);
		}),
	);

/**
 * Simple booking creation (no payment bypass needed).
 * For card payments that go through Acuity's normal flow.
 */
const createBookingProgram = (request: BookingRequest, serviceName?: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const nav: NavigateResult = yield* navigateToBooking({
				serviceName: serviceName ?? request.serviceId,
				datetime: request.datetime,
				client: request.client,
			});

			if (nav.landingStep !== 'client-form') {
				return yield* Effect.fail({
					_tag: 'WizardStepError' as const,
					step: 'navigate' as const,
					message: `Wizard landed on '${nav.landingStep}' instead of client form.`,
				});
			}

			yield* fillFormFields({
				client: request.client,
				customFields: request.client.customFields,
			});

			// No payment bypass - form fills and advances to payment page
			// where Acuity handles card payment normally
			yield* submitBooking();
			const confirmation: ConfirmationData = yield* extractConfirmation();

			return toBooking(confirmation, request, '', 'acuity');
		}),
	);

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

/**
 * Create a full SchedulingAdapter that puppeteers the Acuity wizard.
 *
 * Read operations delegate to the existing scraper.
 * Write operations use Effect TS middleware via Playwright.
 */
export const createWizardAdapter = (config: WizardAdapterConfig): SchedulingAdapter => {
	// Remote mode: delegate everything to the middleware server
	if (config.mode === 'remote') {
		if (!config.remote) {
			throw new Error('WizardAdapterConfig.remote is required when mode is "remote"');
		}
		return createRemoteWizardAdapter({
			...config.remote,
			couponCode: config.remote.couponCode ?? config.couponCode,
		});
	}

	// Local mode: run Playwright in-process
	const browserConfig: BrowserConfig = {
		...defaultBrowserConfig,
		...config,
	};

	const layer = BrowserServiceLive(browserConfig);

	// Helper: run an Effect program and convert to fp-ts TaskEither.
	// Uses runPromiseExit to properly access the typed error E without
	// dealing with FiberFailure wrappers from runPromise.
	const runEffect = <A>(
		effect: Effect.Effect<A, MiddlewareError>,
	): SchedulingResult<A> =>
		() =>
			Effect.runPromiseExit(effect.pipe(Effect.provide(layer))).then(
				(exit) => {
					if (Exit.isSuccess(exit)) {
						return E.right(exit.value) as E.Either<never, A>;
					}
					// Extract the first failure from the cause
					const failure = Cause.failureOption(exit.cause);
					if (failure._tag === 'Some') {
						return E.left(toSchedulingError(failure.value));
					}
					// Defect (unexpected error) — convert cause to string
					const pretty = Cause.pretty(exit.cause);
					console.error('[runEffect] Defect:', pretty);
					return E.left(
						Errors.infrastructure(
							'UNKNOWN',
							`Effect defect: ${pretty}`,
						),
					);
				},
			);

	// Static services from config (avoids browser launch for service listing)
	const staticServices: Service[] | null = config.services ? [...config.services] : null;

	// Scraper fallback for services if no static list provided
	const scraperConfig: ScraperConfig = {
		baseUrl: config.baseUrl,
		headless: browserConfig.headless,
		timeout: browserConfig.timeout,
		userAgent: browserConfig.userAgent,
		executablePath: browserConfig.executablePath,
		launchArgs: browserConfig.launchArgs ? [...browserConfig.launchArgs] : undefined,
	};
	const scraper = createScraperAdapter(scraperConfig);

	// Cache services for getService lookups
	let cachedServices: Service[] | null = staticServices;

	// Helper: resolve service name from ID using cached services
	const resolveServiceName = (serviceId: string): string | undefined =>
		cachedServices?.find((s) => s.id === serviceId)?.name;

	return {
		name: 'acuity-wizard',

		// -----------------------------------------------------------------------
		// Read operations
		// -----------------------------------------------------------------------

		getServices: () => {
			if (staticServices) {
				return TE.right(staticServices);
			}
			// Fallback to scraper (may fail with broken selectors)
			return pipe(
				scraper.getServices(),
				TE.tap((services) =>
					TE.fromIO(() => {
						cachedServices = services;
					}),
				),
			);
		},

		getService: (serviceId: string) => {
			if (cachedServices) {
				const found = cachedServices.find((s) => s.id === serviceId);
				return found
					? TE.right(found)
					: TE.left(Errors.acuity('NOT_FOUND', `Service ${serviceId} not found`));
			}
			return pipe(
				scraper.getServices(),
				TE.chain((services) => {
					cachedServices = services;
					const found = services.find((s) => s.id === serviceId);
					return found
						? TE.right(found)
						: TE.left(Errors.acuity('NOT_FOUND', `Service ${serviceId} not found`));
				}),
			);
		},

		getProviders: () =>
			TE.right([
				{
					id: '1',
					name: 'Default Provider',
					email: 'provider@example.com',
					description: 'Primary provider',
					timezone: 'America/New_York',
				},
			]),

		getProvider: () =>
			TE.right({
				id: '1',
				name: 'Default Provider',
				email: 'provider@example.com',
				description: 'Primary provider',
				timezone: 'America/New_York',
			}),

		getProvidersForService: () =>
			TE.right([
				{
					id: '1',
					name: 'Default Provider',
					email: 'provider@example.com',
					description: 'Primary provider',
					timezone: 'America/New_York',
				},
			]),

		getAvailableDates: (params) => {
			const serviceName = resolveServiceName(params.serviceId);
			if (!serviceName) {
				return TE.left(
					Errors.acuity('NOT_FOUND', `Cannot resolve service name for ID ${params.serviceId}. Provide static services in config.`),
				);
			}
			return runEffect(
				Effect.scoped(
					readAvailableDates({
						serviceName,
						// Don't pass appointmentTypeId — our internal IDs don't match Acuity URL IDs
						targetMonth: params.startDate?.slice(0, 7),
						monthsToScan: 2,
					}),
				) as Effect.Effect<Array<{ date: string; slots: number }>, MiddlewareError>,
			);
		},

		getAvailableSlots: (params) => {
			const serviceName = resolveServiceName(params.serviceId);
			if (!serviceName) {
				return TE.left(
					Errors.acuity('NOT_FOUND', `Cannot resolve service name for ID ${params.serviceId}. Provide static services in config.`),
				);
			}
			return runEffect(
				Effect.scoped(
					readTimeSlots({
						serviceName,
						date: params.date,
					}),
				) as Effect.Effect<Array<{ datetime: string; available: boolean }>, MiddlewareError>,
			);
		},

		checkSlotAvailability: (params) => {
			const serviceName = resolveServiceName(params.serviceId);
			if (!serviceName) {
				return TE.left(
					Errors.acuity('NOT_FOUND', `Cannot resolve service name for ID ${params.serviceId}`),
				);
			}
			return pipe(
				runEffect(
					Effect.scoped(
						readTimeSlots({
							serviceName,
							date: params.datetime.split('T')[0],
						}),
					) as Effect.Effect<Array<{ datetime: string; available: boolean }>, MiddlewareError>,
				),
				TE.map((slots) => {
					// Slots return local time (no TZ suffix: "2026-03-07T14:00:00").
					// Request datetime should also be local, but normalize both by
					// stripping any trailing Z or offset for comparison.
					const normalize = (dt: string) => dt.replace(/([+-]\d{2}:\d{2}|Z)$/, '');
					const requestNorm = normalize(params.datetime);
					return slots.some((s) => s.available && normalize(s.datetime) === requestNorm);
				}),
			);
		},

		// -----------------------------------------------------------------------
		// Reservation - not supported (pipeline has graceful fallback)
		// -----------------------------------------------------------------------

		createReservation: () =>
			TE.left(
				Errors.reservation(
					'BLOCK_FAILED',
					'Reservations not supported by wizard adapter',
				),
			),

		releaseReservation: () => TE.right(undefined),

		// -----------------------------------------------------------------------
		// Write operations - Effect TS middleware
		// -----------------------------------------------------------------------

		createBooking: (request) => {
			const serviceName = cachedServices?.find((s) => s.id === request.serviceId)?.name;
			return runEffect(
				createBookingProgram(request, serviceName) as Effect.Effect<Booking, MiddlewareError>,
			);
		},

		createBookingWithPaymentRef: (request, paymentRef, paymentProcessor) => {
			const coupon = config.couponCode ?? generateCouponCode(paymentRef, paymentProcessor);
			const service = cachedServices?.find((s) => s.id === request.serviceId);

			return runEffect(
				createBookingWithPaymentRefProgram(
					request,
					paymentRef,
					paymentProcessor,
					coupon,
					service,
				) as Effect.Effect<Booking, MiddlewareError>,
			);
		},

		getBooking: () =>
			TE.left(Errors.acuity('NOT_IMPLEMENTED', 'Get booking not yet supported via wizard')),

		cancelBooking: () =>
			TE.left(Errors.acuity('NOT_IMPLEMENTED', 'Cancel not yet supported via wizard')),

		rescheduleBooking: () =>
			TE.left(
				Errors.acuity('NOT_IMPLEMENTED', 'Reschedule not yet supported via wizard'),
			),

		// -----------------------------------------------------------------------
		// Client - pass-through (client data comes from our form, not Acuity)
		// -----------------------------------------------------------------------

		findOrCreateClient: (client) =>
			TE.right({ id: `local-${client.email}`, isNew: true }),

		getClientByEmail: () => TE.right(null),
	};
};
