/**
 * Remote Wizard Adapter
 *
 * SchedulingAdapter implementation backed by HTTP calls to a remote
 * middleware server running Playwright + Chromium (e.g., Modal Labs,
 * Fly.io, or any Docker host).
 *
 * This adapter is the client-side counterpart to `middleware/server.ts`.
 * It serializes requests, sends them over HTTP, and deserializes
 * responses back into fp-ts TaskEither types.
 *
 * @example
 * ```typescript
 * const adapter = createRemoteWizardAdapter({
 *   baseUrl: process.env.MODAL_MIDDLEWARE_URL,
 *   authToken: process.env.MODAL_AUTH_TOKEN,
 * });
 * const kit = createSchedulingKit(adapter, [venmoAdapter]);
 * ```
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import type { SchedulingAdapter } from '../adapters/types.js';
import type {
	Booking,
	BookingRequest,
	Service,
	Provider,
	TimeSlot,
	AvailableDate,
	SlotReservation,
	ClientInfo,
	SchedulingError,
	SchedulingResult,
} from '../core/types.js';
import { Errors } from '../core/types.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface RemoteAdapterConfig {
	/** Base URL of the middleware server (e.g., https://scheduling-middleware--org.modal.run) */
	readonly baseUrl: string;
	/** Auth token for the middleware server */
	readonly authToken?: string;
	/** Request timeout in ms (default: 60000 - wizard flow can take 30s+) */
	readonly timeout?: number;
	/** Coupon code for payment bypass */
	readonly couponCode?: string;
}

// =============================================================================
// HTTP HELPERS
// =============================================================================

interface RemoteResponse<T> {
	readonly success: boolean;
	readonly data?: T;
	readonly error?: {
		readonly tag: string;
		readonly code: string;
		readonly message: string;
	};
}

const makeRequest = <T>(
	config: RemoteAdapterConfig,
	path: string,
	method: 'GET' | 'POST',
	body?: unknown,
): SchedulingResult<T> =>
	TE.tryCatch(
		async () => {
			const url = `${config.baseUrl}${path}`;
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
			};
			if (config.authToken) {
				headers['Authorization'] = `Bearer ${config.authToken}`;
			}

			const response = await fetch(url, {
				method,
				headers,
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(config.timeout ?? 60000),
			});

			if (!response.ok) {
				const errorBody = await response.json().catch(() => ({})) as RemoteResponse<never>;
				throw Object.assign(new Error(errorBody.error?.message ?? `HTTP ${response.status}`), {
					tag: errorBody.error?.tag ?? 'InfrastructureError',
					code: errorBody.error?.code ?? 'NETWORK',
				});
			}

			const json = (await response.json()) as RemoteResponse<T>;

			if (!json.success && json.error) {
				throw Object.assign(new Error(json.error.message), {
					tag: json.error.tag,
					code: json.error.code,
				});
			}

			return json.data as T;
		},
		(e): SchedulingError => {
			if (e instanceof Error && 'tag' in e) {
				const tagged = e as Error & { tag: string; code: string };
				return mapRemoteError(tagged.tag, tagged.code, tagged.message);
			}
			if (e instanceof DOMException && e.name === 'TimeoutError') {
				return Errors.infrastructure('TIMEOUT', 'Middleware server request timed out');
			}
			return Errors.infrastructure(
				'NETWORK',
				`Middleware server error: ${e instanceof Error ? e.message : String(e)}`,
			);
		},
	);

const mapRemoteError = (tag: string, code: string, message: string): SchedulingError => {
	switch (tag) {
		case 'AcuityError':
			return Errors.acuity(code, message);
		case 'PaymentError':
			return Errors.payment(code, message, 'remote');
		case 'ValidationError':
			return Errors.validation(code, message);
		case 'ReservationError':
			return Errors.reservation(code as 'SLOT_TAKEN' | 'BLOCK_FAILED' | 'TIMEOUT', message);
		case 'InfrastructureError':
		default:
			return Errors.infrastructure(
				(code as 'NETWORK' | 'TIMEOUT' | 'REDIS' | 'UNKNOWN') ?? 'UNKNOWN',
				message,
			);
	}
};

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

/**
 * Create a SchedulingAdapter that proxies all operations to a remote
 * middleware server via HTTP. The remote server runs Playwright + Chromium
 * and executes the actual wizard automation.
 */
export const createRemoteWizardAdapter = (config: RemoteAdapterConfig): SchedulingAdapter => ({
	name: 'acuity-wizard-remote',

	// ---------------------------------------------------------------------------
	// Read operations - proxied to remote scraper
	// ---------------------------------------------------------------------------

	getServices: () =>
		makeRequest<Service[]>(config, '/services', 'GET'),

	getService: (serviceId) =>
		makeRequest<Service>(config, `/services/${encodeURIComponent(serviceId)}`, 'GET'),

	getProviders: () =>
		TE.right([{
			id: '1',
			name: 'Default Provider',
			email: 'provider@example.com',
			description: 'Primary provider',
			timezone: 'America/New_York',
		}]),

	getProvider: () =>
		TE.right({
			id: '1',
			name: 'Default Provider',
			email: 'provider@example.com',
			description: 'Primary provider',
			timezone: 'America/New_York',
		}),

	getProvidersForService: () =>
		TE.right([{
			id: '1',
			name: 'Default Provider',
			email: 'provider@example.com',
			description: 'Primary provider',
			timezone: 'America/New_York',
		}]),

	getAvailableDates: (params) =>
		makeRequest<AvailableDate[]>(config, '/availability/dates', 'POST', params),

	getAvailableSlots: (params) =>
		makeRequest<TimeSlot[]>(config, '/availability/slots', 'POST', params),

	checkSlotAvailability: (params) =>
		makeRequest<boolean>(config, '/availability/check', 'POST', params),

	// ---------------------------------------------------------------------------
	// Reservation - not supported (pipeline has graceful fallback)
	// ---------------------------------------------------------------------------

	createReservation: () =>
		TE.left(Errors.reservation('BLOCK_FAILED', 'Reservations not supported by remote wizard adapter')),

	releaseReservation: () => TE.right(undefined),

	// ---------------------------------------------------------------------------
	// Write operations - proxied to remote wizard
	// ---------------------------------------------------------------------------

	createBooking: (request) =>
		makeRequest<Booking>(config, '/booking/create', 'POST', {
			request,
			couponCode: config.couponCode,
		}),

	createBookingWithPaymentRef: (request, paymentRef, paymentProcessor) =>
		makeRequest<Booking>(config, '/booking/create-with-payment', 'POST', {
			request,
			paymentRef,
			paymentProcessor,
			couponCode: config.couponCode,
		}),

	getBooking: () =>
		TE.left(Errors.acuity('NOT_IMPLEMENTED', 'Get booking not yet supported via wizard')),

	cancelBooking: () =>
		TE.left(Errors.acuity('NOT_IMPLEMENTED', 'Cancel not yet supported via wizard')),

	rescheduleBooking: () =>
		TE.left(Errors.acuity('NOT_IMPLEMENTED', 'Reschedule not yet supported via wizard')),

	// ---------------------------------------------------------------------------
	// Client - pass-through
	// ---------------------------------------------------------------------------

	findOrCreateClient: (client) =>
		TE.right({ id: `local-${client.email}`, isNew: true }),

	getClientByEmail: () => TE.right(null),
});
