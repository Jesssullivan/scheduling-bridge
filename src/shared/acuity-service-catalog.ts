import { Cause, Effect, Exit } from 'effect';
import { createScraperAdapter, type ScraperConfig } from '../adapters/acuity/scraper.js';
import {
	businessToServices,
	fetchBusinessData,
	type AcuityBusinessData,
} from '../adapters/acuity/steps/index.js';
import { Errors, type SchedulingError, type Service } from '../core/types.js';
import { metrics } from './metrics.js';

export interface ServiceCatalogLogger {
	readonly log?: (...args: unknown[]) => void;
	readonly warn?: (...args: unknown[]) => void;
	readonly error?: (...args: unknown[]) => void;
}

export interface AcuityServiceCatalog {
	readonly staticServicesCount: number;
	readonly getServices: () => Promise<Service[]>;
	readonly getService: (serviceId: string) => Promise<Service | null>;
	readonly getCachedService: (serviceId: string) => Service | undefined;
	/** Returns the number of services currently held in the L1 in-process cache (0 = not yet populated). */
	readonly getCachedCount: () => number;
	readonly resolveServiceName: (serviceId: string, serviceName?: string) => Promise<string>;
}

/**
 * Minimal interface over `RedisL2.getCached` that the catalog depends on.
 *
 * Kept as a structural interface (not the concrete Effect service Tag) so that
 * the catalog stays usable from non-Effect callers and is trivially mockable
 * in tests. The wiring module (e.g. `src/server/handler.ts`) is responsible
 * for providing the `RedisL2` context that the real `getCached` needs.
 *
 * NOTE: this interface intentionally erases Effect error/context channels.
 * Callers wiring a real `RedisL2` instance must provide a
 * `(mk: Effect.Effect<A>) => ...` shim that handles `RedisError` /
 * `CacheTimeoutError` (or turns them into defects). Errors not handled
 * before `Effect.runPromise` below will reject as unknown defects.
 */
export interface ServiceCatalogRedisL2 {
	readonly getCached: <A>(
		key: string,
		ttlSeconds: number,
		mk: Effect.Effect<A>,
	) => Effect.Effect<A>;
}

export interface AcuityServiceCatalogConfig {
	readonly baseUrl: string;
	readonly staticServices?: readonly Service[] | null;
	readonly cacheTtlMs?: number;
	readonly scraperConfig?: ScraperConfig;
	readonly logger?: ServiceCatalogLogger;
	readonly fetchBusinessData?: (baseUrl: string) => Promise<AcuityBusinessData | null>;
	readonly businessToServices?: (business: AcuityBusinessData) => Service[];
	readonly loadScraperServices?: () => Promise<readonly Service[]>;
	readonly now?: () => number;
	/**
	 * Optional L2 (networked) cache. When provided, every `runRefresh()` call
	 * is delegated through `getCached`, which is expected to provide
	 * cross-pod single-flight + TTL semantics. The in-process `loadInFlight`
	 * dedup path is bypassed because L2 is the coordination boundary.
	 *
	 * The local `cachedServices` buffer is still maintained so that the
	 * synchronous `getCachedService()` accessor and `resolveServiceName()`
	 * fast path keep working.
	 */
	readonly redisL2?: ServiceCatalogRedisL2;
}

const cloneService = (service: Service): Service => ({ ...service });

const cloneServices = (services: readonly Service[]): Service[] =>
	services.map(cloneService);

const describeError = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export const parseStaticServicesJson = (
	raw: string | undefined,
	logger: ServiceCatalogLogger = console,
): Service[] | null => {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as Service[];
	} catch (error) {
		logger.error?.(
			`[acuity-service-catalog] Failed to parse SERVICES_JSON: ${describeError(error)}`,
		);
		return null;
	}
};

const isNonNumericServiceName = (serviceName?: string): serviceName is string =>
	!!serviceName && !/^\d+$/.test(serviceName);

export const createAcuityServiceCatalog = (
	config: AcuityServiceCatalogConfig,
): AcuityServiceCatalog => {
	const logger = config.logger ?? console;
	const staticServices = config.staticServices ? cloneServices(config.staticServices) : null;
	const fetchBusinessDataImpl = config.fetchBusinessData ?? fetchBusinessData;
	const businessToServicesImpl = config.businessToServices ?? businessToServices;
	const injectedScraperLoader = config.loadScraperServices;
	const now = config.now ?? Date.now;
	const cacheTtlMs = Math.max(0, config.cacheTtlMs ?? 5 * 60_000);

	let scraper: ReturnType<typeof createScraperAdapter> | null = null;
	let cachedServices: Service[] | null = staticServices;
	let loadInFlight: Promise<Service[]> | null = null;
	let cacheUpdatedAt = staticServices ? now() : 0;

	if (staticServices) {
		logger.log?.(
			`[acuity-service-catalog] Loaded ${staticServices.length} static services`,
		);
	}

	const setCachedServices = (services: readonly Service[]): Service[] => {
		cachedServices = cloneServices(services);
		cacheUpdatedAt = now();
		return cachedServices;
	};

	const hasFreshCache = (): boolean =>
		cachedServices !== null && (staticServices !== null || now() - cacheUpdatedAt < cacheTtlMs);

	const loadBusinessServices = async (): Promise<Service[] | null> => {
		try {
			const business = await fetchBusinessDataImpl(config.baseUrl);
			if (!business) return null;

			const services = businessToServicesImpl(business);
			if (services.length === 0) {
				logger.warn?.(
					'[acuity-service-catalog] BUSINESS object found but 0 active services',
				);
				return null;
			}

			logger.log?.(
				`[acuity-service-catalog] Loaded ${services.length} services from BUSINESS`,
			);
			return cloneServices(services);
		} catch (error) {
			logger.warn?.(
				`[acuity-service-catalog] BUSINESS extraction failed: ${describeError(error)}`,
			);
			return null;
		}
	};

	const loadScraperServices = injectedScraperLoader
		? async () => cloneServices(await injectedScraperLoader())
		: async () => {
				if (!config.scraperConfig) {
					throw Errors.infrastructure(
						'UNKNOWN',
						'Scraper config is required when no loadScraperServices override is provided',
					);
				}

				if (!scraper) {
					scraper = createScraperAdapter(config.scraperConfig);
				}

				const exit = await Effect.runPromiseExit(scraper.getServices());
				if (Exit.isSuccess(exit)) {
					return cloneServices(exit.value);
				}

				const failure = Cause.failureOption(exit.cause);
				if (failure._tag === 'Some') {
					throw failure.value;
				}

				throw Errors.infrastructure('UNKNOWN', Cause.pretty(exit.cause));
			};

	const refreshServices = async (): Promise<Service[]> => {
		if (staticServices) {
			return cloneServices(staticServices);
		}

		const liveServices = await loadBusinessServices();
		if (liveServices) {
			return cloneServices(setCachedServices(liveServices));
		}

		const fallbackServices = await loadScraperServices();
		if (fallbackServices.length === 0) {
			logger.error?.(
				'[acuity-service-catalog] All service sources exhausted; returning empty catalog',
			);
		}
		return cloneServices(setCachedServices(fallbackServices));
	};

	const runRefresh = async (): Promise<Service[]> => {
		if (config.redisL2) {
			// L2 path: delegate single-flight + TTL to the networked cache.
			// Coordination across pods is only correct when every refresh goes
			// through L2, so we skip the in-process `loadInFlight` dedup here.
			// bump the "v1" suffix when Service shape changes to invalidate stale L2 entries across rolling deploys
			const cacheKey = `acuity:services:v1:${config.baseUrl}`;
			const ttlSeconds = Math.max(1, Math.floor(cacheTtlMs / 1000));
			const services = await Effect.runPromise(
				config.redisL2.getCached(
					cacheKey,
					ttlSeconds,
					Effect.promise(refreshServices),
				),
			);
			// Keep L1 buffer warm so `getCachedService()` and the
			// `resolveServiceName()` fast-path can serve synchronously.
			setCachedServices(services);
			return cloneServices(services);
		}

		// In-process Promise dedup: single-node deployments (or the fallback
		// path for tests / local dev without Redis).
		if (!loadInFlight) {
			loadInFlight = refreshServices().finally(() => {
				loadInFlight = null;
			});
		}
		return cloneServices(await loadInFlight);
	};

	const ensureServices = async (): Promise<Service[]> => {
		// When L2 is wired, every call goes through it — L2 is the freshness
		// authority, not the in-process `cachedServices` buffer. Static
		// services still short-circuit because they are the declared truth.
		// Hit/miss accounting for the L2 path is recorded inside
		// `redis-l2.ts::getCached` so we do not double-count here.
		if (config.redisL2 && !staticServices) {
			return runRefresh();
		}
		// L1-only path: a fresh in-process buffer counts as a cache hit, any
		// path that falls through to `runRefresh()` counts as a miss. Static
		// services are a declared configuration surface, not a cache, so they
		// are counted as hits for dashboard continuity.
		if (hasFreshCache()) {
			metrics.recordCacheHit();
			return cloneServices(cachedServices ?? []);
		}
		metrics.recordCacheMiss();
		return runRefresh();
	};

	return {
		staticServicesCount: staticServices?.length ?? 0,
		getServices: () => ensureServices(),
		getService: async (serviceId) => {
			const services = await ensureServices();
			return services.find((service) => service.id === serviceId) ?? null;
		},
		getCachedService: (serviceId) => {
			const service = cachedServices?.find((candidate) => candidate.id === serviceId);
			return service ? cloneService(service) : undefined;
		},
		getCachedCount: () => cachedServices?.length ?? 0,
		resolveServiceName: async (serviceId, serviceName) => {
			if (isNonNumericServiceName(serviceName)) {
				return serviceName;
			}

			const services = await ensureServices();
			return services.find((service) => service.id === serviceId)?.name ?? serviceId;
		},
	};
};
