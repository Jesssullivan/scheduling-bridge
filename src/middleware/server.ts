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
import { Effect, Scope } from 'effect';
import * as E from 'fp-ts/Either';
import { createScraperAdapter, type ScraperConfig } from '../adapters/acuity-scraper.js';
import { BrowserService, BrowserServiceLive, type BrowserConfig, defaultBrowserConfig } from './browser-service.js';
import { toSchedulingError, type MiddlewareError } from './errors.js';
import {
	navigateToBooking,
	fillFormFields,
	bypassPayment,
	generateCouponCode,
	submitBooking,
	extractConfirmation,
	toBooking,
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

const layer = BrowserServiceLive(browserConfig);

const runEffect = async <A>(
	effect: Effect.Effect<A, MiddlewareError, BrowserService | Scope.Scope>,
): Promise<E.Either<SchedulingError, A>> => {
	try {
		const result = await Effect.runPromise(
			Effect.scoped(effect.pipe(Effect.provide(layer))),
		);
		return E.right(result);
	} catch (e) {
		return E.left(toSchedulingError(e as MiddlewareError));
	}
};

// =============================================================================
// SCRAPER (cached)
// =============================================================================

let scraper: ReturnType<typeof createScraperAdapter> | null = null;

const getScraper = () => {
	if (!scraper) {
		scraper = createScraperAdapter(scraperConfig);
	}
	return scraper;
};

let cachedServices: Service[] | null = null;

// =============================================================================
// ROUTE HANDLERS
// =============================================================================

const handleHealth = (_req: IncomingMessage, res: ServerResponse) => {
	sendSuccess(res, {
		status: 'ok',
		baseUrl: ACUITY_BASE_URL,
		hasCoupon: !!COUPON_CODE,
		headless: browserConfig.headless,
		timestamp: new Date().toISOString(),
	});
};


const handleGetServices = async (_req: IncomingMessage, res: ServerResponse) => {
	const result = await getScraper().getServices()();
	if (E.isLeft(result)) return sendError(res, 500, result.left);
	cachedServices = result.right;
	sendSuccess(res, result.right);
};

const handleGetService = async (serviceId: string, res: ServerResponse) => {
	if (!cachedServices) {
		const all = await getScraper().getServices()();
		if (E.isLeft(all)) return sendError(res, 500, all.left);
		cachedServices = all.right;
	}
	const found = cachedServices.find((s) => s.id === serviceId);
	if (!found) {
		return sendJson(res, 404, {
			success: false,
			error: { tag: 'AcuityError', code: 'NOT_FOUND', message: `Service ${serviceId} not found` },
		});
	}
	sendSuccess(res, found);
};

const handleAvailableDates = async (req: IncomingMessage, res: ServerResponse) => {
	const body = (await parseBody(req)) as { serviceId: string; startDate?: string };
	const result = await getScraper().getAvailableDates(
		body.serviceId,
		body.startDate?.slice(0, 7),
	)();
	if (E.isLeft(result)) return sendError(res, 500, result.left);
	sendSuccess(res, result.right.map((d) => ({ date: d, slots: 1 })));
};

const handleAvailableSlots = async (req: IncomingMessage, res: ServerResponse) => {
	const body = (await parseBody(req)) as { serviceId: string; date: string };
	const result = await getScraper().getTimeSlots(body.serviceId, body.date)();
	if (E.isLeft(result)) return sendError(res, 500, result.left);
	sendSuccess(res, result.right);
};

const handleCheckSlot = async (req: IncomingMessage, res: ServerResponse) => {
	const body = (await parseBody(req)) as { serviceId: string; datetime: string };
	const date = body.datetime.split('T')[0];
	const result = await getScraper().getTimeSlots(body.serviceId, date)();
	if (E.isLeft(result)) return sendError(res, 500, result.left);
	const available = result.right.some((s) => s.datetime === body.datetime && s.available);
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

	if (E.isLeft(result)) return sendError(res, 500, result.left);
	sendSuccess(res, result.right);
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

	if (E.isLeft(result)) return sendError(res, 500, result.left);
	sendSuccess(res, result.right);
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

// Only start listening when this file is executed directly (not imported)
if (process.argv[1]?.match(/server\.(ts|js|mjs)$/)) {
	server.listen(PORT, '0.0.0.0', () => {
		console.log(`[middleware-server] Listening on port ${PORT}`);
		console.log(`[middleware-server] Acuity URL: ${ACUITY_BASE_URL}`);
		console.log(`[middleware-server] Coupon: ${COUPON_CODE ? 'configured' : 'NOT SET'}`);
		console.log(`[middleware-server] Auth: ${AUTH_TOKEN ? 'enabled' : 'disabled'}`);
		console.log(`[middleware-server] Headless: ${browserConfig.headless}`);
	});
}

export { server };
