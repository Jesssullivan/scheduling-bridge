/**
 * Middleware HTTP Server
 *
 * Standalone Node.js HTTP server wrapping the Effect TS wizard programs.
 * Designed to run inside a Docker container with Playwright + Chromium
 * on K8s, Modal Labs, Fly.io, or any container host.
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
import { randomUUID } from 'node:crypto';
import { Effect, Exit, Cause, ManagedRuntime, Scope } from 'effect';
import { Redis as IORedisImpl } from 'ioredis';
import type { Redis as IORedis } from 'ioredis';
import type { ScraperConfig } from '../adapters/acuity/scraper.js';
import {
	BrowserProcessLive,
	BrowserProcess,
	BrowserService,
	BrowserSessionLive,
	type BrowserConfig,
	defaultBrowserConfig,
} from '../shared/browser-service.js';
import {
	createAcuityServiceCatalog,
	parseStaticServicesJson,
	type ServiceCatalogRedisL2,
} from '../shared/acuity-service-catalog.js';
import { getCached as redisL2GetCached, RedisL2 } from '../shared/redis-l2.js';
import { metrics, renderMetrics } from '../shared/metrics.js';
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
import {
	readDatesViaUrl,
	readSlotsViaUrl,
} from '../adapters/acuity/steps/read-via-url.js';
import { buildHealthPayload } from './health.js';
import { handleReady as _handleReady } from './ready.js';
import { ndjsonLog } from '../shared/logger.js';
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

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

interface RequestContext {
	readonly requestId: string;
	readonly method: string;
	readonly path: string;
	readonly startedAt: number;
}

const runtimeLogFields = () => ({
	flowOwner: 'scheduling-bridge',
	backend: 'acuity',
	transport: 'http-json',
	runtimeEnvironment: process.env.DEPLOYMENT_ENVIRONMENT ?? process.env.MODAL_ENVIRONMENT,
	releaseSha: process.env.MIDDLEWARE_RELEASE_SHA,
	releaseVersion: process.env.MIDDLEWARE_RELEASE_VERSION ?? process.env.npm_package_version,
});

const logEvent = (
	level: LogLevel,
	msg: string,
	data?: Record<string, unknown>,
) => {
	ndjsonLog(level, msg, {
		...runtimeLogFields(),
		...data,
	});
};

const logRequestEvent = (
	level: LogLevel,
	msg: string,
	context: RequestContext,
	data?: Record<string, unknown>,
) => {
	logEvent(level, msg, {
		event: 'request',
		requestId: context.requestId,
		method: context.method,
		path: context.path,
		...data,
	});
};

const describeLogValue = (value: unknown): string => {
	if (typeof value === 'string') return value;
	if (value instanceof Error) return value.message;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

const createServiceCatalogLogger = () => ({
	log: (...args: unknown[]) =>
		logEvent('INFO', 'Service catalog event', {
			event: 'service_catalog',
			detail: args.map(describeLogValue).join(' '),
		}),
	warn: (...args: unknown[]) =>
		logEvent('WARN', 'Service catalog warning', {
			event: 'service_catalog',
			detail: args.map(describeLogValue).join(' '),
		}),
	error: (...args: unknown[]) =>
		logEvent('ERROR', 'Service catalog error', {
			event: 'service_catalog',
			detail: args.map(describeLogValue).join(' '),
		}),
});

const createSlotReadTelemetryContext = (
	context: RequestContext,
	endpoint: string,
) => ({
	requestId: context.requestId,
	endpoint,
	...runtimeLogFields(),
});

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

// =============================================================================
// REDIS L2 CLIENT + ADAPTER SHIM
// =============================================================================
//
// `RedisL2.getCached` (from `shared/redis-l2.ts`) expects `mk: () => Promise<A>`
// because its Effect.gen generator internally calls `Effect.tryPromise({ try:
// () => mk(), ... })`. But `ServiceCatalogRedisL2.getCached` (the structural
// interface the catalog depends on) takes `mk: Effect.Effect<A>` so that
// non-Node callers and tests stay Effect-native.
//
// This shim bridges the two: the catalog hands us an Effect, we wrap it as a
// Promise via `Effect.runPromise`, pass it into the real `getCached`, and
// provide the `RedisL2` service via a module-level singleton ioredis client.
//
// If REDIS_URL is missing (local dev), `redisL2` stays `undefined` and the
// catalog falls back to its in-process single-flight path.

const REDIS_URL = process.env.REDIS_URL;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;

const redisClient: IORedis | null = REDIS_URL
	? new IORedisImpl(REDIS_URL, {
			password: REDIS_PASSWORD,
			maxRetriesPerRequest: 3,
		})
	: null;

// Declare which cache tier is active at boot so operators can diagnose silent
// L1-only degradation (e.g. REDIS_URL accidentally unset in prod) from logs
// alone, without having to probe the running process.
logEvent('INFO', 'Cache mode selected', {
	event: 'cache_mode_selected',
	mode: redisClient ? 'l1+l2' : 'l1-only',
	redisConfigured: Boolean(process.env.REDIS_URL),
});

if (redisClient) {
	redisClient.on('error', (e) => {
		logEvent('ERROR', 'Redis L2 client error', {
			event: 'redis_client_error',
			error: describeLogValue(e),
		});
	});
}

const serviceCatalogRedisL2: ServiceCatalogRedisL2 | undefined = redisClient
	? {
			getCached: <A>(
				key: string,
				ttlSeconds: number,
				mk: Effect.Effect<A>,
			): Effect.Effect<A> => {
				const mkPromise = (): Promise<A> => Effect.runPromise(mk);
				// Provide the RedisL2 service for the real `getCached`, then erase
				// the `RedisError | CacheTimeoutError` channel so the result fits
				// the `Effect.Effect<A>` shape expected by the catalog. Defects
				// propagate as rejections through `Effect.runPromise` in the
				// catalog, preserving the error-surface contract documented in
				// `acuity-service-catalog.ts`.
				return redisL2GetCached(key, ttlSeconds, mkPromise).pipe(
					Effect.provideService(RedisL2, redisClient),
					Effect.orDie,
				);
			},
		}
	: undefined;

const serviceCatalog = createAcuityServiceCatalog({
	baseUrl: ACUITY_BASE_URL,
	cacheTtlMs: SERVICE_CACHE_TTL_MS,
	staticServices: parseStaticServicesJson(process.env.SERVICES_JSON),
	scraperConfig,
	logger: createServiceCatalogLogger(),
	redisL2: serviceCatalogRedisL2,
});

const isSchedulingError = (error: unknown): error is SchedulingError =>
	typeof error === 'object' && error !== null && '_tag' in error;

const resolveServiceName = async (serviceId: string, serviceName?: string): Promise<string> => {
	try {
		return await serviceCatalog.resolveServiceName(serviceId, serviceName);
	} catch (error) {
		logEvent('WARN', 'Service name resolution failed', {
			event: 'service_name_resolution_failed',
			serviceId,
			serviceName,
			error: describeLogValue(error),
		});
		return serviceName && !/^\d+$/.test(serviceName) ? serviceName : serviceId;
	}
};

const isAcuityAppointmentTypeId = (serviceId: string): boolean => /^\d+$/.test(serviceId);

// =============================================================================
// ROUTE HANDLERS
// =============================================================================

/** The L2 Redis key used by the service catalog (must match acuity-service-catalog.ts). */
const CATALOG_REDIS_KEY = `acuity:services:v1:${ACUITY_BASE_URL}`;

/**
 * Real-liveness readiness handler wired to the module-level singletons.
 *
 * Checks (in parallel, under ~3 s combined budget):
 *  1. Redis ping
 *  2. Browser pool `isConnected()` via BrowserProcess Effect service
 *  3. Catalog has data in L1 (getCachedCount) or L2 (Redis EXISTS)
 *
 * Returns HTTP 200 when all pass; 503 otherwise.
 */
const handleReady = (res: ServerResponse) =>
	_handleReady(res, {
		redisPing: redisClient ? () => redisClient!.ping() : null,
		browserConnected: () =>
			browserRuntime.runPromise(
				BrowserProcess.pipe(Effect.map(({ browser }) => browser.isConnected())),
			),
		catalogL1Count: () => serviceCatalog.getCachedCount(),
		catalogL2Exists: redisClient
			? () => redisClient!.exists(CATALOG_REDIS_KEY)
			: null,
	});

const handleHealth = (_req: IncomingMessage, res: ServerResponse) => {
	sendSuccess(
		res,
		buildHealthPayload({
			baseUrl: ACUITY_BASE_URL,
			hasCoupon: !!COUPON_CODE,
			headless: browserConfig.headless,
			staticServices: serviceCatalog.staticServicesCount,
			serviceCacheTtlMs: SERVICE_CACHE_TTL_MS,
			releaseSha: process.env.MIDDLEWARE_RELEASE_SHA,
			releaseRef: process.env.MIDDLEWARE_RELEASE_REF,
			releaseVersion: process.env.MIDDLEWARE_RELEASE_VERSION ?? process.env.npm_package_version,
			releaseBuiltAt: process.env.MIDDLEWARE_RELEASE_BUILT_AT ?? process.env.MIDDLEWARE_BUILD_TIMESTAMP,
			runtimeEnvironment: process.env.DEPLOYMENT_ENVIRONMENT ?? process.env.MODAL_ENVIRONMENT,
		}),
	);
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

const handleAvailableDates = async (req: IncomingMessage, res: ServerResponse, context: RequestContext) => {
	const body = (await parseBody(req)) as { serviceId: string; serviceName?: string; startDate?: string };
	logRequestEvent('INFO', 'Availability dates requested', context, {
		event: 'availability_dates_requested',
		serviceId: body.serviceId,
		serviceName: body.serviceName,
		startDate: body.startDate,
	});
	const result = isAcuityAppointmentTypeId(body.serviceId)
		? await runEffect(readDatesViaUrl(body.serviceId, body.startDate?.slice(0, 7)))
		: await (async () => {
				const serviceName = await resolveServiceName(body.serviceId, body.serviceName);
				logRequestEvent('INFO', 'Availability dates resolved service name', context, {
					event: 'availability_dates_resolved_service',
					serviceId: body.serviceId,
					serviceName,
					startDate: body.startDate,
				});
				return runEffect(
					readAvailableDates({
						serviceName,
						targetMonth: body.startDate?.slice(0, 7),
						monthsToScan: 2,
					}),
				);
			})();

	if (!result.ok) {
		const err = result.error;
		logRequestEvent('ERROR', 'Availability dates request failed', context, {
			event: 'availability_dates_failed',
			serviceId: body.serviceId,
			startDate: body.startDate,
			errorTag: err._tag,
			errorCode: 'code' in err ? (err as { code: string }).code : 'UNKNOWN',
			errorMessage: 'message' in err ? (err as { message: string }).message : 'Availability lookup failed',
		});
		return sendJson(res, 500, {
			success: false,
			error: { tag: err._tag ?? 'InfrastructureError', code: 'code' in err ? (err as {code:string}).code : 'UNKNOWN', message: 'message' in err ? (err as {message:string}).message : 'Availability lookup failed' },
		});
	}
	sendSuccess(res, result.value);
};

const handleAvailableSlots = async (req: IncomingMessage, res: ServerResponse, context: RequestContext) => {
	const body = (await parseBody(req)) as { serviceId: string; serviceName?: string; date: string };
	logRequestEvent('INFO', 'Availability slots requested', context, {
		event: 'availability_slots_requested',
		serviceId: body.serviceId,
		serviceName: body.serviceName,
		date: body.date,
	});
	const result = isAcuityAppointmentTypeId(body.serviceId)
		? await runEffect(
				readSlotsViaUrl(
					body.serviceId,
					body.date,
					createSlotReadTelemetryContext(context, 'availability_slots'),
				),
			)
		: await (async () => {
				const serviceName = await resolveServiceName(body.serviceId, body.serviceName);
				logRequestEvent('INFO', 'Availability slots resolved service name', context, {
					event: 'availability_slots_resolved_service',
					serviceId: body.serviceId,
					serviceName,
					date: body.date,
				});
				return runEffect(
					readTimeSlots({
						serviceName,
						date: body.date,
					}),
				);
			})();

	if (!result.ok) {
		const err = result.error;
		logRequestEvent('ERROR', 'Availability slots request failed', context, {
			event: 'availability_slots_failed',
			serviceId: body.serviceId,
			date: body.date,
			errorTag: err._tag,
			errorCode: 'code' in err ? (err as { code: string }).code : 'UNKNOWN',
			errorMessage: 'message' in err ? (err as { message: string }).message : 'Slot lookup failed',
		});
		return sendJson(res, 500, {
			success: false,
			error: { tag: err._tag ?? 'InfrastructureError', code: 'code' in err ? (err as {code:string}).code : 'UNKNOWN', message: 'message' in err ? (err as {message:string}).message : 'Slot lookup failed' },
		});
	}
	sendSuccess(res, result.value);
};

const handleCheckSlot = async (req: IncomingMessage, res: ServerResponse, context: RequestContext) => {
	const body = (await parseBody(req)) as { serviceId: string; serviceName?: string; datetime: string };
	const date = body.datetime.split('T')[0];
	logRequestEvent('INFO', 'Availability check requested', context, {
		event: 'availability_check_requested',
		serviceId: body.serviceId,
		serviceName: body.serviceName,
		datetime: body.datetime,
	});
	const result = isAcuityAppointmentTypeId(body.serviceId)
		? await runEffect(
				readSlotsViaUrl(
					body.serviceId,
					date,
					createSlotReadTelemetryContext(context, 'availability_check'),
				),
			)
		: await (async () => {
				const serviceName = await resolveServiceName(body.serviceId, body.serviceName);
				return runEffect(
					readTimeSlots({
						serviceName,
						date,
					}),
				);
			})();

	if (!result.ok) {
		const err = result.error;
		logRequestEvent('ERROR', 'Availability check failed', context, {
			event: 'availability_check_failed',
			serviceId: body.serviceId,
			datetime: body.datetime,
			errorTag: err._tag,
			errorCode: 'code' in err ? (err as { code: string }).code : 'UNKNOWN',
			errorMessage: 'message' in err ? (err as { message: string }).message : 'Slot check failed',
		});
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

const handleCreateBooking = async (req: IncomingMessage, res: ServerResponse, context: RequestContext) => {
	const body = (await parseBody(req)) as { request: BookingRequest; couponCode?: string };
	const { request } = body;

	const serviceName = await resolveServiceName(request.serviceId);
	logRequestEvent('INFO', 'Booking create requested', context, {
		event: 'booking_create_requested',
		serviceId: request.serviceId,
		datetime: request.datetime,
	});

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

	if (!result.ok) {
		logRequestEvent('ERROR', 'Booking create failed', context, {
			event: 'booking_create_failed',
			serviceId: request.serviceId,
			datetime: request.datetime,
			errorTag: result.error._tag,
			errorCode: 'code' in result.error ? result.error.code : 'UNKNOWN',
			errorMessage: 'message' in result.error ? result.error.message : 'Booking create failed',
		});
		return sendError(res, 500, result.error);
	}
	sendSuccess(res, result.value);
};

const handleCreateBookingWithPayment = async (
	req: IncomingMessage,
	res: ServerResponse,
	context: RequestContext,
) => {
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
	logRequestEvent('INFO', 'Booking create with payment requested', context, {
		event: 'booking_create_with_payment_requested',
		serviceId: request.serviceId,
		datetime: request.datetime,
		paymentProcessor,
	});

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

	if (!result.ok) {
		logRequestEvent('ERROR', 'Booking create with payment failed', context, {
			event: 'booking_create_with_payment_failed',
			serviceId: request.serviceId,
			datetime: request.datetime,
			paymentProcessor,
			errorTag: result.error._tag,
			errorCode: 'code' in result.error ? result.error.code : 'UNKNOWN',
			errorMessage:
				'message' in result.error ? result.error.message : 'Booking create with payment failed',
		});
		return sendError(res, 500, result.error);
	}
	sendSuccess(res, result.value);
};

// =============================================================================
// SERVER
// =============================================================================

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
	const path = url.pathname;
	const method = req.method?.toUpperCase() ?? 'GET';
	const context: RequestContext = {
		requestId:
			typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].length > 0
				? req.headers['x-request-id']
				: randomUUID(),
		method,
		path,
		startedAt: Date.now(),
	};

	res.setHeader('x-request-id', context.requestId);
	logRequestEvent('INFO', 'Request started', context, {
		event: 'request_started',
	});
	res.on('finish', () => {
		logRequestEvent('INFO', 'Request completed', context, {
			event: 'request_completed',
			statusCode: res.statusCode,
			durationMs: Date.now() - context.startedAt,
		});
	});

	// Auth check (skip health + observability endpoints)
	const unauthenticatedPaths = new Set(['/health', '/ready', '/metrics']);
	if (AUTH_TOKEN && !unauthenticatedPaths.has(path)) {
		const auth = req.headers.authorization;
		if (auth !== `Bearer ${AUTH_TOKEN}`) {
			logRequestEvent('WARN', 'Unauthorized request rejected', context, {
				event: 'request_rejected',
				reason: 'invalid_auth_token',
			});
			return sendJson(res, 401, {
				success: false,
				error: { tag: 'InfrastructureError', code: 'UNAUTHORIZED', message: 'Invalid auth token' },
			});
		}
	}

	try {
		// Observability endpoints are matched BEFORE the main dispatch so the
		// Prometheus scraper and k8s readiness probe never race with auth or
		// business-logic errors.
		if (path === '/metrics' && method === 'GET') {
			const body = await renderMetrics();
			res.writeHead(200, { 'Content-Type': metrics.registry.contentType });
			res.end(body);
			return;
		}

		if (path === '/ready' && method === 'GET') {
			return handleReady(res);
		}

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
			return await handleAvailableDates(req, res, context);
		}
		if (path === '/availability/slots' && method === 'POST') {
			return await handleAvailableSlots(req, res, context);
		}
		if (path === '/availability/check' && method === 'POST') {
			return await handleCheckSlot(req, res, context);
		}
		if (path === '/booking/create' && method === 'POST') {
			return await handleCreateBooking(req, res, context);
		}
		if (path === '/booking/create-with-payment' && method === 'POST') {
			return await handleCreateBookingWithPayment(req, res, context);
		}

		logRequestEvent('WARN', 'Unknown route requested', context, {
			event: 'request_not_found',
		});
		sendJson(res, 404, {
			success: false,
			error: { tag: 'InfrastructureError', code: 'NOT_FOUND', message: `Unknown route: ${method} ${path}` },
		});
	} catch (e) {
		logRequestEvent('ERROR', 'Unhandled request error', context, {
			event: 'request_failed',
			error: describeLogValue(e),
		});
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
		logEvent('ERROR', 'Failed to dispose browser runtime', {
			event: 'runtime_dispose_failed',
			error: describeLogValue(error),
		});
	});
};

const disposeRedisClient = () => {
	if (!redisClient) return;
	void redisClient.quit().catch(() => undefined);
};

server.on('close', disposeBrowserRuntime);
server.on('close', disposeRedisClient);

// Only start listening when this file is executed directly (not imported)
if (process.argv[1]?.match(/handler\.(ts|js|mjs)$/)) {
	server.listen(PORT, '0.0.0.0', () => {
		logEvent('INFO', 'Middleware server listening', {
			event: 'runtime_started',
			port: PORT,
			acuityBaseUrl: ACUITY_BASE_URL,
			couponConfigured: !!COUPON_CODE,
			authEnabled: !!AUTH_TOKEN,
			headless: browserConfig.headless,
		});
	});
}

export { server };
