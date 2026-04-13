/**
 * Middleware HTTP Server
 *
 * Standalone Node.js HTTP server wrapping the Effect TS wizard programs.
 * Designed to run inside a Docker container with Playwright + Chromium
 * on Modal Labs, Fly.io, or any host.
 *
 * Endpoints:
 *   GET  /health                    - Health check
 *   GET  /services                  - List services (static/BUSINESS/scraper)
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
 *   node --import tsx/esm src/server/handler.ts
 *   # or after build:
 *   node dist/server/handler.js
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Effect, Exit, Cause, ManagedRuntime, Scope } from 'effect';
import type { ScraperConfig } from '../adapters/acuity/scraper.js';
import {
	BrowserProcessLive,
	BrowserService,
	BrowserSessionLive,
	type BrowserConfig,
	defaultBrowserConfig,
} from '../shared/browser-service.js';
import {
	createAcuityServiceCatalog,
	parseStaticServicesJson,
} from '../shared/acuity-service-catalog.js';
import { toSchedulingError, type MiddlewareError } from '../adapters/acuity/errors.js';
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
} from '../adapters/acuity/steps/index.js';
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
const SERVICE_CACHE_TTL_MS = (() => {
	const parsed = Number(process.env.ACUITY_SERVICE_CACHE_TTL_MS ?? 5 * 60_000);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5 * 60_000;
})();

const browserConfig: BrowserConfig = {
	...defaultBrowserConfig,
	baseUrl: ACUITY_BASE_URL,
	headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
	timeout: Number(process.env.PLAYWRIGHT_TIMEOUT ?? 30000),
	executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
	launchArgs: process.env.CHROMIUM_LAUNCH_ARGS?.split(','),
};

const scraperConfig: ScraperConfig = {
	baseUrl: ACUITY_BASE_URL,
	headless: browserConfig.headless,
	timeout: browserConfig.timeout,
	userAgent: browserConfig.userAgent,
	executablePath: browserConfig.executablePath,
	launchArgs: browserConfig.launchArgs ? [...browserConfig.launchArgs] : undefined,
};

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

const browserRuntime = ManagedRuntime.make(BrowserProcessLive(browserConfig));

type Result<A> = { ok: true; value: A } | { ok: false; error: SchedulingError };

const runEffect = async <A>(
	effect: Effect.Effect<A, MiddlewareError | undefined, BrowserService | Scope.Scope>,
): Promise<Result<A>> => {
	const exit = await browserRuntime.runPromiseExit(
		Effect.scoped(effect.pipe(Effect.provide(BrowserSessionLive))),
	);
	if (Exit.isSuccess(exit)) {
		return { ok: true, value: exit.value };
	}
	const failure = Cause.failureOption(exit.cause);
	if (failure._tag === 'Some' && failure.value !== undefined) {
		return { ok: false, error: toSchedulingError(failure.value) };
	}
	return { ok: false, error: { _tag: 'InfrastructureError', code: 'UNKNOWN', message: Cause.pretty(exit.cause) } };
};

const serviceCatalog = createAcuityServiceCatalog({
	baseUrl: ACUITY_BASE_URL,
	cacheTtlMs: SERVICE_CACHE_TTL_MS,
	staticServices: parseStaticServicesJson(process.env.SERVICES_JSON),
	scraperConfig,
	logger: console,
});

const isSchedulingError = (error: unknown): error is SchedulingError =>
	typeof error === 'object' && error !== null && '_tag' in error;

const resolveServiceName = async (serviceId: string, serviceName?: string): Promise<string> => {
	try {
		return await serviceCatalog.resolveServiceName(serviceId, serviceName);
	} catch (error) {
		console.warn(
			`[middleware-server] Service name resolution failed for ${serviceId}:`,
			error,
		);
		return serviceName && !/^\d+$/.test(serviceName) ? serviceName : serviceId;
	}
};

// =============================================================================
// ROUTE HANDLERS
// =============================================================================

const handleHealth = (_req: IncomingMessage, res: ServerResponse) => {
	sendSuccess(res, {
		status: 'ok',
		baseUrl: ACUITY_BASE_URL,
		hasCoupon: !!COUPON_CODE,
		headless: browserConfig.headless,
		staticServices: serviceCatalog.staticServicesCount,
		serviceCacheTtlMs: SERVICE_CACHE_TTL_MS,
		timestamp: new Date().toISOString(),
	});
};


const handleGetServices = async (_req: IncomingMessage, res: ServerResponse) => {
	try {
		const services = await serviceCatalog.getServices();
		sendSuccess(res, services);
	} catch (error) {
		if (isSchedulingError(error)) {
			return sendError(res, 500, error);
		}
		return sendJson(res, 500, {
			success: false,
			error: {
				tag: 'InfrastructureError',
				code: 'UNKNOWN',
				message: error instanceof Error ? error.message : 'Service lookup failed',
			},
		});
	}
};

const handleGetService = async (serviceId: string, res: ServerResponse) => {
	try {
		const found = await serviceCatalog.getService(serviceId);
		if (!found) {
			return sendJson(res, 404, {
				success: false,
				error: { tag: 'AcuityError', code: 'NOT_FOUND', message: `Service ${serviceId} not found` },
			});
		}
		sendSuccess(res, found);
	} catch (error) {
		if (isSchedulingError(error)) {
			return sendError(res, 500, error);
		}
		return sendJson(res, 500, {
			success: false,
			error: {
				tag: 'InfrastructureError',
				code: 'UNKNOWN',
				message: error instanceof Error ? error.message : 'Service lookup failed',
			},
		});
	}
};

const handleAvailableDates = async (req: IncomingMessage, res: ServerResponse) => {
	const body = (await parseBody(req)) as { serviceId: string; serviceName?: string; startDate?: string };
	const serviceName = await resolveServiceName(body.serviceId, body.serviceName);
	console.log(`[availability/dates] serviceName="${serviceName}" from serviceId="${body.serviceId}"`);

	const result = await runEffect(
		readAvailableDates({
			serviceName,
			targetMonth: body.startDate?.slice(0, 7),
			monthsToScan: 2,
		}),
	);

	if (!result.ok) {
		const err = result.error;
		console.error(`[availability/dates] error:`, err);
		return sendJson(res, 500, {
			success: false,
			error: { tag: err._tag ?? 'InfrastructureError', code: 'code' in err ? (err as {code:string}).code : 'UNKNOWN', message: 'message' in err ? (err as {message:string}).message : 'Availability lookup failed' },
		});
	}
	sendSuccess(res, result.value);
};

const handleAvailableSlots = async (req: IncomingMessage, res: ServerResponse) => {
	const body = (await parseBody(req)) as { serviceId: string; serviceName?: string; date: string };
	const serviceName = await resolveServiceName(body.serviceId, body.serviceName);
	console.log(`[availability/slots] serviceName="${serviceName}" date="${body.date}"`);

	const result = await runEffect(
		readTimeSlots({
			serviceName,
			date: body.date,
		}),
	);

	if (!result.ok) {
		const err = result.error;
		console.error(`[availability/slots] error:`, err);
		return sendJson(res, 500, {
			success: false,
			error: { tag: err._tag ?? 'InfrastructureError', code: 'code' in err ? (err as {code:string}).code : 'UNKNOWN', message: 'message' in err ? (err as {message:string}).message : 'Slot lookup failed' },
		});
	}
	sendSuccess(res, result.value);
};

const handleCheckSlot = async (req: IncomingMessage, res: ServerResponse) => {
	const body = (await parseBody(req)) as { serviceId: string; serviceName?: string; datetime: string };
	const date = body.datetime.split('T')[0];
	const serviceName = await resolveServiceName(body.serviceId, body.serviceName);

	const result = await runEffect(
		readTimeSlots({
			serviceName,
			date,
		}),
	);

	if (!result.ok) {
		const err = result.error;
		return sendJson(res, 500, {
			success: false,
			error: { tag: err._tag ?? 'InfrastructureError', code: 'code' in err ? (err as {code:string}).code : 'UNKNOWN', message: 'message' in err ? (err as {message:string}).message : 'Slot check failed' },
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

	const serviceName = await resolveServiceName(request.serviceId);

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

	const serviceName = await resolveServiceName(request.serviceId);
	const service = serviceCatalog.getCachedService(request.serviceId);

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
		console.error(`[middleware-server] Unhandled error on ${method} ${path}:`, e);
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

let browserRuntimeDisposed = false;

const disposeBrowserRuntime = () => {
	if (browserRuntimeDisposed) return;
	browserRuntimeDisposed = true;
	void browserRuntime.dispose().catch((error) => {
		console.error('[middleware-server] Failed to dispose browser runtime:', error);
	});
};

server.on('close', disposeBrowserRuntime);

// Only start listening when this file is executed directly (not imported)
if (process.argv[1]?.match(/handler\.(ts|js|mjs)$/)) {
	server.listen(PORT, '0.0.0.0', () => {
		console.log(`[middleware-server] Listening on port ${PORT}`);
		console.log(`[middleware-server] Acuity URL: ${ACUITY_BASE_URL}`);
		console.log(`[middleware-server] Coupon: ${COUPON_CODE ? 'configured' : 'NOT SET'}`);
		console.log(`[middleware-server] Auth: ${AUTH_TOKEN ? 'enabled' : 'disabled'}`);
		console.log(`[middleware-server] Headless: ${browserConfig.headless}`);
	});
}

export { server };
