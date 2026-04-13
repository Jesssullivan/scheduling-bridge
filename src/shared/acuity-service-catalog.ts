import { Cause, Effect, Exit } from 'effect';
import { createScraperAdapter, type ScraperConfig } from '../adapters/acuity/scraper.js';
import {
	businessToServices,
	fetchBusinessData,
	type AcuityBusinessData,
} from '../adapters/acuity/steps/index.js';
import { Errors, type SchedulingError, type Service } from '../core/types.js';

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
	readonly resolveServiceName: (serviceId: string, serviceName?: string) => Promise<string>;
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
		if (!loadInFlight) {
			loadInFlight = refreshServices().finally(() => {
				loadInFlight = null;
			});
		}
		return cloneServices(await loadInFlight);
	};

	const ensureServices = async (): Promise<Service[]> =>
		hasFreshCache() ? cloneServices(cachedServices ?? []) : runRefresh();

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
		resolveServiceName: async (serviceId, serviceName) => {
			if (isNonNumericServiceName(serviceName)) {
				return serviceName;
			}

			const services = await ensureServices();
			return services.find((service) => service.id === serviceId)?.name ?? serviceId;
		},
	};
};
