/**
 * Middleware HTTP Server
 *
 * Standalone Node.js HTTP server wrapping the Effect TS wizard programs.
 * Designed to run inside a Docker container with Playwright + Chromium
 * on Modal Labs, Fly.io, or any host.
 *
 * Endpoints:
 *   GET  /health                    - Health check
 *   GET  /services                  - List services (scraper)
 *   GET  /services/:id              - Get service by ID
 *   POST /availability/dates        - Available dates for a service
 *   POST /availability/slots        - Time slots for a date
 *   POST /availability/check        - Check if a slot is available
 *   POST /booking/create            - Create booking (standard)
 *   POST /booking/create-with-payment - Create booking with payment ref (coupon bypass)
 *
 * Environment variables:
 *   PORT                - Server port (default: 3001)
 *   ACUITY_BASE_URL     - Acuity scheduling URL
 *   ACUITY_BYPASS_COUPON - 100% coupon code
 *   AUTH_TOKEN           - Required Bearer token for all endpoints
 *   PLAYWRIGHT_HEADLESS  - Browser headless mode (default: true)
 *   PLAYWRIGHT_TIMEOUT   - Page timeout in ms (default: 30000)
 *
 * Usage:
 *   node --import tsx/esm src/middleware/server.ts
 *   # or after build:
 *   node dist/middleware/server.js
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Effect, Exit, Cause, Layer, Scope } from 'effect';
// Scraper removed — deprecated and caused esbuild bundling issues.
// Services are served from SERVICES_JSON env or BUSINESS object extraction.
import { BrowserService, BrowserServiceLive, type BrowserConfig, defaultBrowserConfig } from './browser-service.js';
import { WizardStepError, toSchedulingError, type MiddlewareError } from './errors.js';
import { ServiceResolver, ServiceResolverLive } from './service-resolver.js';
import { LoggerLive, ndjsonLog } from './logger.js';
import { selectorHealthCheck } from './selector-health.js';
import {
	navigateToBooking,
	fillFormFields,
	bypassPayment,
	generateCouponCode,
	submitBooking,
	extractConfirmation,
	toBooking,
	fetchBusinessData,
	businessToServices,
} from './steps/index.js';
import type {
	Booking,
	BookingRequest,
	Service,
	SchedulingError,
} from '../core/types.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const PORT = Number(process.env.PORT ?? 3001);
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const ACUITY_BASE_URL = process.env.ACUITY_BASE_URL ?? 'https://MassageIthaca.as.me';
const COUPON_CODE = process.env.ACUITY_BYPASS_COUPON;

const browserConfig: BrowserConfig = {
	...defaultBrowserConfig,
	baseUrl: ACUITY_BASE_URL,
	headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
	timeout: Number(process.env.PLAYWRIGHT_TIMEOUT ?? 30000),
	executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
	launchArgs: process.env.CHROMIUM_LAUNCH_ARGS?.split(','),
};

// scraperConfig removed — scraper deprecated, BUSINESS extraction replaces it

// =============================================================================
// RESPONSE HELPERS
// =============================================================================

interface SuccessResponse<T> {
	success: true;
	data: T;
}

interface ErrorResponse {
	success: false;
	error: {
		tag: string;
		code: string;
		message: string;
	};
}

const sendJson = (res: ServerResponse, status: number, body: SuccessResponse<unknown> | ErrorResponse) => {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
};

const sendSuccess = <T>(res: ServerResponse, data: T) =>
	sendJson(res, 200, { success: true, data });

const sendError = (res: ServerResponse, status: number, err: SchedulingError) =>
	sendJson(res, status, {
		success: false,
		error: {
			tag: err._tag,
			code: 'code' in err ? (err as { code: string }).code : err._tag,
			message: 'message' in err ? (err as { message: string }).message : 'Unknown error',
		},
	});

const parseBody = async (req: IncomingMessage): Promise<unknown> => {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}
	const raw = Buffer.concat(chunks).toString('utf8');
	return raw ? JSON.parse(raw) : {};
};

// =============================================================================
// EFFECT RUNNER
// =============================================================================

const layer = Layer.merge(BrowserServiceLive(browserConfig), ServiceResolverLive).pipe(
	Layer.provide(LoggerLive),
);

type Result<A> = { ok: true; value: A } | { ok: false; error: SchedulingError };

const runEffect = async <A>(
	effect: Effect.Effect<A, MiddlewareError, BrowserService | ServiceResolver | Scope.Scope>,
): Promise<Result<A>> => {
	const exit = await Effect.runPromiseExit(
		Effect.scoped(effect.pipe(Effect.provide(layer))),
	);
	if (Exit.isSuccess(exit)) {
		return { ok: true, value: exit.value };
	}
	const failure = Cause.failureOption(exit.cause);
	if (failure._tag === 'Some') {
		return { ok: false, error: toSchedulingError(failure.value) };
	}
	return { ok: false, error: { _tag: 'InfrastructureError', code: 'UNKNOWN', message: Cause.pretty(exit.cause) } };
};

/** Run a SchedulingResult (Effect) and return Result */
const runSchedulingEffect = async <A>(
	effect: Effect.Effect<A, SchedulingError>,
): Promise<Result<A>> => {
	const exit = await Effect.runPromiseExit(effect);
	if (Exit.isSuccess(exit)) {
		return { ok: true, value: exit.value };
	}
	const failure = Cause.failureOption(exit.cause);
	if (failure._tag === 'Some') {
		return { ok: false, error: failure.value };
	}
	return { ok: false, error: { _tag: 'InfrastructureError', code: 'UNKNOWN', message: Cause.pretty(exit.cause) } };
};

// =============================================================================
// SCRAPER (cached)
// =============================================================================

let cachedServices: Service[] | null = null;

// Static services from SERVICES_JSON env var (avoids scraper dependency)
const STATIC_SERVICES: Service[] | null = (() => {
	const raw = process.env.SERVICES_JSON;
	if (!raw) return null;
	try {
		return JSON.parse(raw) as Service[];
	} catch (e) {
		ndjsonLog('ERROR', 'Failed to parse SERVICES_JSON', { error: String(e) });
		return null;
	}
})();

if (STATIC_SERVICES) {
	cachedServices = STATIC_SERVICES;
	ndjsonLog('INFO', 'Loaded static services from SERVICES_JSON', { count: STATIC_SERVICES.length });
}

// =============================================================================
// ROUTE HANDLERS
// =============================================================================

let requestCount = 0;
const startedAt = new Date().toISOString();

const handleHealth = async (req: IncomingMessage, res: ServerResponse) => {
	const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
	const depth = Number(url.searchParams.get('depth') ?? 0) as 0 | 1 | 2;

	const baseHealth = {
		status: 'ok',
		baseUrl: ACUITY_BASE_URL,
		hasCoupon: !!COUPON_CODE,
		headless: browserConfig.headless,
		staticServices: STATIC_SERVICES ? STATIC_SERVICES.length : 0,
		uptime: process.uptime(),
		startedAt,
		requestCount,
		timestamp: new Date().toISOString(),
	};

	if (depth === 0) {
		return sendSuccess(res, baseHealth);
	}

	// Tiered selector health check (requires browser)
	const result = await runEffect(selectorHealthCheck(ACUITY_BASE_URL, depth));
	if (!result.ok) {
		return sendSuccess(res, { ...baseHealth, selectorCheck: null, selectorError: 'probe failed' });
	}

	return sendSuccess(res, {
		...baseHealth,
		status: result.value.status,
		selectorCheck: result.value,
	});
};


const handleGetServices = async (_req: IncomingMessage, res: ServerResponse) => {
	// 1. Prefer static services from env (always reliable, no network needed)
	if (STATIC_SERVICES) {
		ndjsonLog('INFO', 'Services source: SERVICES_JSON env');
		cachedServices = STATIC_SERVICES;
		return sendSuccess(res, STATIC_SERVICES);
	}

	// 2. Extract from BUSINESS object (HTTP fetch + regex, no browser)
	try {
		const business = await fetchBusinessData(ACUITY_BASE_URL);
		if (business) {
			const services = businessToServices(business);
			if (services.length > 0) {
				ndjsonLog('INFO', 'Services source: BUSINESS object', { count: services.length });
				cachedServices = services;
				return sendSuccess(res, services);
			}
			ndjsonLog('WARN', 'BUSINESS object found but 0 active services');
		}
	} catch (e) {
		ndjsonLog('WARN', 'BUSINESS extraction failed', { error: e instanceof Error ? e.message : String(e) });
	}

	// No more fallbacks — return empty with warning
	ndjsonLog('ERROR', 'All service sources exhausted (SERVICES_JSON not set, BUSINESS extraction failed)');
	sendSuccess(res, []);
};

const handleGetService = async (serviceId: string, res: ServerResponse) => {
	if (!cachedServices) {
		// Try BUSINESS extraction to populate cache
		try {
			const business = await fetchBusinessData(ACUITY_BASE_URL);
			if (business) cachedServices = businessToServices(business);
		} catch { /* ignore */ }
	}
	if (!cachedServices) cachedServices = [];
	const found = cachedServices.find((s) => s.id === serviceId);
	if (!found) {
		return sendJson(res, 404, {
			success: false,
			error: { tag: 'AcuityError', code: 'NOT_FOUND', message: `Service ${serviceId} not found` },
		});
	}
	sendSuccess(res, found);
};

/**
 * Navigate directly to a service's calendar via URL param, bypassing
 * category-based click navigation (which breaks with collapseCategories).
 *
 * This is the approach the original scraper used — ?appointmentType={id}
 * goes straight to the calendar page for that service.
 */
const readDatesViaUrl = (serviceId: string, targetMonth?: string) =>
	Effect.gen(function* () {
		const { acquirePage, config } = yield* BrowserService;
		const page = yield* acquirePage;

		const url = new URL(config.baseUrl);
		url.searchParams.set('appointmentType', serviceId);
		if (targetMonth) url.searchParams.set('month', targetMonth);

		yield* Effect.tryPromise({
			try: () => page.goto(url.toString(), { waitUntil: 'networkidle', timeout: config.timeout }),
			catch: (e) => new WizardStepError({ step: 'read-availability', message: `Navigation failed: ${e}` }),
		});

		// Read enabled calendar tiles
		const dates = yield* Effect.tryPromise({
			try: async () => {
				await page.waitForSelector('.react-calendar__tile, .scheduleday, [data-date]', { timeout: 10000 }).catch(() => {});
				return page.evaluate(() => {
					const results: Array<{ date: string; slots: number }> = [];
					// React calendar tiles that are NOT disabled
					document.querySelectorAll('.react-calendar__tile:not(:disabled):not(.react-calendar__tile--neighboringMonth)').forEach(tile => {
						const abbr = tile.querySelector('abbr');
						const date = abbr?.getAttribute('aria-label') || tile.getAttribute('data-date') || '';
						if (date) {
							// Parse "March 28, 2026" or "2026-03-28" format
							const d = new Date(date);
							if (!isNaN(d.getTime())) {
								results.push({ date: d.toISOString().slice(0, 10), slots: 1 });
							}
						}
					});
					return results;
				});
			},
			catch: (e) => new WizardStepError({ step: 'read-availability', message: `Calendar read failed: ${e}` }),
		});

		return dates;
	});

const readSlotsViaUrl = (serviceId: string, date: string) =>
	Effect.gen(function* () {
		const { acquirePage, config } = yield* BrowserService;
		const page = yield* acquirePage;

		const url = new URL(config.baseUrl);
		url.searchParams.set('appointmentType', serviceId);
		url.searchParams.set('date', date);

		yield* Effect.tryPromise({
			try: () => page.goto(url.toString(), { waitUntil: 'networkidle', timeout: config.timeout }),
			catch: (e) => new WizardStepError({ step: 'read-slots', message: `Navigation failed: ${e}` }),
		});

		// Click the target date on the calendar
		yield* Effect.tryPromise({
			try: async () => {
				await page.waitForSelector('.react-calendar__tile, [data-date]', { timeout: 10000 }).catch(() => {});
				// Find and click the tile for the target date
				const tiles = await page.$$('.react-calendar__tile');
				for (const tile of tiles) {
					const abbr = await tile.$('abbr');
					const label = await abbr?.getAttribute('aria-label');
					if (label) {
						const d = new Date(label);
						if (d.toISOString().slice(0, 10) === date) {
							await tile.click();
							break;
						}
					}
				}
				await page.waitForTimeout(2000);
			},
			catch: (e) => new WizardStepError({ step: 'read-slots', message: `Date click failed: ${e}` }),
		});

		// Read time slots
		const slots = yield* Effect.tryPromise({
			try: async () => {
				await page.waitForSelector('button.time-selection, [data-time]', { timeout: 10000 }).catch(() => {});
				return page.evaluate(() => {
					const results: Array<{ datetime: string; available: boolean }> = [];
					document.querySelectorAll('button.time-selection').forEach(btn => {
						const raw = btn.textContent?.trim() || '';
						const disabled = btn.hasAttribute('disabled');
						// Extract just the time portion, stripping "1 spot left" etc.
						const match = raw.match(/^(\d{1,2}:\d{2}\s*[AP]M)/i);
						const time = match ? match[1] : raw;
						if (time) {
							results.push({ datetime: time, available: !disabled });
						}
					});
					return results;
				});
			},
			catch: (e) => new WizardStepError({ step: 'read-slots', message: `Slots read failed: ${e}` }),
		});

		return slots;
	});

const handleAvailableDates = async (req: IncomingMessage, res: ServerResponse) => {
	const body = (await parseBody(req)) as { serviceId: string; serviceName?: string; startDate?: string };
	// Use Acuity numeric ID for direct URL navigation (bypasses collapsed categories)
	const serviceId = body.serviceId;
	ndjsonLog('INFO', 'availability/dates', { serviceId, startDate: body.startDate });

	const result = await runEffect(
		readDatesViaUrl(serviceId, body.startDate?.slice(0, 7)),
	);

	if (!result.ok) {
		ndjsonLog('ERROR', 'availability/dates failed', { error: result.error });
		return sendJson(res, 500, {
			success: false,
			error: { tag: 'InfrastructureError', code: 'AVAILABILITY_FAILED', message: 'message' in result.error ? result.error.message : 'Availability lookup failed' },
		});
	}
	sendSuccess(res, result.value);
};

const handleAvailableSlots = async (req: IncomingMessage, res: ServerResponse) => {
	const body = (await parseBody(req)) as { serviceId: string; serviceName?: string; date: string };
	ndjsonLog('INFO', 'availability/slots', { serviceId: body.serviceId, date: body.date });

	const result = await runEffect(
		readSlotsViaUrl(body.serviceId, body.date),
	);

	if (!result.ok) {
		ndjsonLog('ERROR', 'availability/slots failed', { error: result.error });
		return sendJson(res, 500, {
			success: false,
			error: { tag: 'InfrastructureError', code: 'SLOTS_FAILED', message: 'message' in result.error ? result.error.message : 'Slot lookup failed' },
		});
	}
	sendSuccess(res, result.value);
};

const handleCheckSlot = async (req: IncomingMessage, res: ServerResponse) => {
	const body = (await parseBody(req)) as { serviceId: string; serviceName?: string; datetime: string };
	const date = body.datetime.split('T')[0];

	const result = await runEffect(
		readSlotsViaUrl(body.serviceId, date),
	);

	if (!result.ok) {
		return sendJson(res, 500, {
			success: false,
			error: { tag: 'InfrastructureError', code: 'CHECK_FAILED', message: 'message' in result.error ? result.error.message : 'Slot check failed' },
		});
	}
	const available = result.value.some((s: { datetime: string; available: boolean }) =>
		s.datetime === body.datetime && s.available
	);
	sendSuccess(res, available);
};

const handleCreateBooking = async (req: IncomingMessage, res: ServerResponse) => {
	const body = (await parseBody(req)) as { request: BookingRequest; couponCode?: string };
	const { request } = body;

	const serviceName = cachedServices?.find((s) => s.id === request.serviceId)?.name;

	const result = await runEffect(
		Effect.gen(function* () {
			yield* navigateToBooking({
				serviceName: serviceName ?? request.serviceId,
				datetime: request.datetime,
				client: request.client,
				appointmentTypeId: request.serviceId,
			});
			yield* fillFormFields({ client: request.client, customFields: request.client.customFields });
			yield* submitBooking();
			const confirmation = yield* extractConfirmation();
			return toBooking(confirmation, request, '', 'acuity');
		}),
	);

	if (!result.ok) return sendError(res, 500, result.error);
	sendSuccess(res, result.value);
};

const handleCreateBookingWithPayment = async (req: IncomingMessage, res: ServerResponse) => {
	const body = (await parseBody(req)) as {
		request: BookingRequest;
		paymentRef: string;
		paymentProcessor: string;
		couponCode?: string;
	};
	const { request, paymentRef, paymentProcessor } = body;
	const coupon = body.couponCode ?? COUPON_CODE;

	if (!coupon) {
		return sendJson(res, 400, {
			success: false,
			error: { tag: 'ValidationError', code: 'couponCode', message: 'Coupon code is required for payment bypass' },
		});
	}

	// Try to get service details for richer booking data
	const service = cachedServices?.find((s) => s.id === request.serviceId);
	const serviceName = service?.name ?? request.serviceId;

	const result = await runEffect(
		Effect.gen(function* () {
			yield* navigateToBooking({
				serviceName,
				datetime: request.datetime,
				client: request.client,
				appointmentTypeId: request.serviceId,
			});
			yield* fillFormFields({ client: request.client, customFields: request.client.customFields });
			yield* bypassPayment(coupon);
			yield* submitBooking();
			const confirmation = yield* extractConfirmation();
			return toBooking(
				confirmation,
				request,
				paymentRef,
				paymentProcessor,
				service ? { name: service.name, duration: service.duration, price: service.price, currency: service.currency } : undefined,
			);
		}),
	);

	if (!result.ok) return sendError(res, 500, result.error);
	sendSuccess(res, result.value);
};

// =============================================================================
// SERVER
// =============================================================================

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
	const path = url.pathname;
	const method = req.method?.toUpperCase() ?? 'GET';
	requestCount++;

	// Auth check (skip health endpoint)
	if (AUTH_TOKEN && path !== '/health') {
		const auth = req.headers.authorization;
		if (auth !== `Bearer ${AUTH_TOKEN}`) {
			return sendJson(res, 401, {
				success: false,
				error: { tag: 'InfrastructureError', code: 'UNAUTHORIZED', message: 'Invalid auth token' },
			});
		}
	}

	try {
		// Route matching
		if (path === '/health' && method === 'GET') {
			return handleHealth(req, res);
		}
		if (path === '/services' && method === 'GET') {
			return await handleGetServices(req, res);
		}
		if (path.startsWith('/services/') && method === 'GET') {
			const serviceId = decodeURIComponent(path.slice('/services/'.length));
			return await handleGetService(serviceId, res);
		}
		if (path === '/availability/dates' && method === 'POST') {
			return await handleAvailableDates(req, res);
		}
		if (path === '/availability/slots' && method === 'POST') {
			return await handleAvailableSlots(req, res);
		}
		if (path === '/availability/check' && method === 'POST') {
			return await handleCheckSlot(req, res);
		}
		if (path === '/booking/create' && method === 'POST') {
			return await handleCreateBooking(req, res);
		}
		if (path === '/booking/create-with-payment' && method === 'POST') {
			return await handleCreateBookingWithPayment(req, res);
		}

		sendJson(res, 404, {
			success: false,
			error: { tag: 'InfrastructureError', code: 'NOT_FOUND', message: `Unknown route: ${method} ${path}` },
		});
	} catch (e) {
		ndjsonLog('ERROR', 'Unhandled error', { method, path, error: e instanceof Error ? e.message : String(e) });
		sendJson(res, 500, {
			success: false,
			error: {
				tag: 'InfrastructureError',
				code: 'UNKNOWN',
				message: e instanceof Error ? e.message : 'Internal server error',
			},
		});
	}
});

// Only start listening when this file is executed directly (not imported)
if (process.argv[1]?.match(/server\.(ts|js|mjs)$/)) {
	server.listen(PORT, '0.0.0.0', () => {
		ndjsonLog('INFO', 'Middleware server started', {
			port: PORT,
			baseUrl: ACUITY_BASE_URL,
			coupon: COUPON_CODE ? 'configured' : 'NOT SET',
			auth: AUTH_TOKEN ? 'enabled' : 'disabled',
			headless: browserConfig.headless,
		});
	});
}

export { server };
