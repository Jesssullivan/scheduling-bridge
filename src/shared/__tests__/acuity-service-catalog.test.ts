import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import {
	createAcuityServiceCatalog,
	parseStaticServicesJson,
	type AcuityServiceCatalogConfig,
	type ServiceCatalogLogger,
	type ServiceCatalogRedisL2,
} from '../acuity-service-catalog.js';
import type { Service } from '../../core/types.js';
import type { AcuityBusinessData } from '../../adapters/acuity/steps/index.js';

const services: Service[] = [
	{
		id: 'svc-1',
		name: 'Urgent Care Massage',
		duration: 60,
		price: 15500,
		currency: 'USD',
		category: 'Urgent Care',
		active: true,
	},
	{
		id: 'svc-2',
		name: 'TMD Tuneup',
		duration: 75,
		price: 18500,
		currency: 'USD',
		category: 'TMD',
		active: true,
	},
];

const makeLogger = (): Required<ServiceCatalogLogger> => ({
	log: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
});

describe('parseStaticServicesJson', () => {
	it('returns null and logs when SERVICES_JSON is invalid', () => {
		const logger = makeLogger();
		const result = parseStaticServicesJson('{not-json', logger);

		expect(result).toBeNull();
		expect(logger.error).toHaveBeenCalledTimes(1);
	});
});

describe('createAcuityServiceCatalog', () => {
	it('uses static services without touching live loaders', async () => {
		const fetchBusiness = vi.fn();
		const loadScraperServices = vi.fn();
		const catalog = createAcuityServiceCatalog({
			baseUrl: 'https://example.com',
			staticServices: services,
			fetchBusinessData: fetchBusiness,
			loadScraperServices,
			logger: makeLogger(),
		});

		await expect(catalog.getServices()).resolves.toEqual(services);
		await expect(catalog.getService('svc-2')).resolves.toEqual(services[1]);
		await expect(catalog.resolveServiceName('svc-1')).resolves.toBe('Urgent Care Massage');
		expect(fetchBusiness).not.toHaveBeenCalled();
		expect(loadScraperServices).not.toHaveBeenCalled();
	});

	it('deduplicates concurrent live loads and caches the result', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetchBusinessData = vi.fn(async () => {
			await gate;
			return {} as AcuityBusinessData;
		});
		const businessToServices = vi.fn(() => services);
		const loadScraperServices = vi.fn();
		const catalog = createAcuityServiceCatalog({
			baseUrl: 'https://example.com',
			fetchBusinessData,
			businessToServices,
			loadScraperServices,
			logger: makeLogger(),
		});

		const pending = Promise.all([catalog.getServices(), catalog.getServices()]);
		release();

		await expect(pending).resolves.toEqual([services, services]);
		expect(fetchBusinessData).toHaveBeenCalledTimes(1);
		expect(businessToServices).toHaveBeenCalledTimes(1);
		expect(loadScraperServices).not.toHaveBeenCalled();
		expect(catalog.getCachedService('svc-1')).toEqual(services[0]);
	});

	it('reuses the cached catalog within the TTL window', async () => {
		const fetchBusinessData = vi.fn(async () => ({} as AcuityBusinessData));
		const businessToServices = vi.fn(() => services);
		const catalog = createAcuityServiceCatalog({
			baseUrl: 'https://example.com',
			cacheTtlMs: 60_000,
			fetchBusinessData,
			businessToServices,
			logger: makeLogger(),
		});

		await expect(catalog.getServices()).resolves.toEqual(services);
		await expect(catalog.getServices()).resolves.toEqual(services);
		expect(fetchBusinessData).toHaveBeenCalledTimes(1);
		expect(businessToServices).toHaveBeenCalledTimes(1);
	});

	it('refreshes the catalog immediately when TTL is zero', async () => {
		const fetchBusinessData = vi.fn(async () => ({} as AcuityBusinessData));
		const businessToServices = vi.fn(() => services);
		const catalog = createAcuityServiceCatalog({
			baseUrl: 'https://example.com',
			cacheTtlMs: 0,
			fetchBusinessData,
			businessToServices,
			logger: makeLogger(),
		});

		await expect(catalog.getServices()).resolves.toEqual(services);
		await expect(catalog.getServices()).resolves.toEqual(services);
		expect(fetchBusinessData).toHaveBeenCalledTimes(2);
		expect(businessToServices).toHaveBeenCalledTimes(2);
	});

	it('falls back to scraper services when BUSINESS is unavailable', async () => {
		const loadScraperServices = vi.fn(async () => services);
		const catalog = createAcuityServiceCatalog({
			baseUrl: 'https://example.com',
			fetchBusinessData: vi.fn(async () => null),
			loadScraperServices,
			logger: makeLogger(),
		});

		await expect(catalog.getServices()).resolves.toEqual(services);
		await expect(catalog.resolveServiceName('svc-2')).resolves.toBe('TMD Tuneup');
		expect(loadScraperServices).toHaveBeenCalledTimes(1);
	});
});

describe('AcuityServiceCatalog with Redis L2', () => {
	it('delegates single-flight to RedisL2.getCached when redisL2 provided', async () => {
		const mkGetCached = vi.fn(
			async (_k: string, _ttl: number, mk: Effect.Effect<unknown>) =>
				await Effect.runPromise(mk),
		);
		const mockL2 = {
			getCached: <A>(key: string, ttl: number, mk: Effect.Effect<A>) =>
				Effect.promise(() => mkGetCached(key, ttl, mk) as Promise<A>),
		};

		const fetchBusinessData = vi.fn(async () => null);
		const loadScraperServices = vi.fn(async () => services);

		const catalog = createAcuityServiceCatalog({
			baseUrl: 'https://x.as.me',
			staticServices: null,
			fetchBusinessData,
			loadScraperServices,
			redisL2: mockL2,
			logger: makeLogger(),
		});

		await catalog.getServices();
		await catalog.getServices();

		// L2 layer handles dedup; catalog calls it every time.
		expect(mkGetCached).toHaveBeenCalledTimes(2);
		// Key should be namespaced with baseUrl.
		const firstCallKey = mkGetCached.mock.calls[0]?.[0];
		expect(firstCallKey).toBe('acuity:services:v1:https://x.as.me');
	});

	it('falls back to in-process cache when redisL2 absent', async () => {
		const loadSpy = vi.fn(async () => services);
		const catalog = createAcuityServiceCatalog({
			baseUrl: 'https://x.as.me',
			staticServices: null,
			fetchBusinessData: async () => null,
			loadScraperServices: loadSpy,
			logger: makeLogger(),
		});

		await catalog.getServices();
		await catalog.getServices();

		// in-proc cache hit on second call.
		expect(loadSpy).toHaveBeenCalledTimes(1);
	});

	it('surfaces redisL2.getCached errors without falling back to L1', async () => {
		const boom = new Error('redis-down');
		const mkGetCached = vi.fn().mockImplementation(
			() => Effect.fail(boom as never) as Effect.Effect<Service[]>,
		);
		const fakeL2 = { getCached: mkGetCached } as ServiceCatalogRedisL2;

		const catalog = createAcuityServiceCatalog({
			baseUrl: 'https://x.as.me',
			redisL2: fakeL2,
			staticServices: null,
		} as unknown as AcuityServiceCatalogConfig);

		await expect(catalog.getServices()).rejects.toThrow();
		expect(mkGetCached).toHaveBeenCalledTimes(1);
	});

	it('increments scrape counter with source=lock_winner when L2 runs mk', async () => {
		const { metrics } = await import('../metrics.js');
		const winnerBefore =
			(await metrics.serviceCatalogScrapeTotal.get()).values.find(
				(v) => v.labels.source === 'lock_winner',
			)?.value ?? 0;

		const mockL2: ServiceCatalogRedisL2 = {
			getCached: <A>(_k: string, _ttl: number, mk: Effect.Effect<A>) =>
				Effect.tap(mk, () =>
					Effect.sync(() =>
						metrics.serviceCatalogScrapeTotal.inc({ source: 'lock_winner' }),
					),
				),
		};

		const catalog = createAcuityServiceCatalog({
			baseUrl: 'https://x.as.me',
			staticServices: null,
			fetchBusinessData: async () => null,
			loadScraperServices: async () => [
				{
					id: '1',
					name: 's',
					duration: 60,
					price: 0,
					currency: 'USD',
					category: 'test',
					active: true,
				},
			],
			redisL2: mockL2,
			logger: makeLogger(),
		});
		await catalog.getServices();

		const winnerAfter =
			(await metrics.serviceCatalogScrapeTotal.get()).values.find(
				(v) => v.labels.source === 'lock_winner',
			)?.value ?? 0;

		expect(winnerAfter).toBe(winnerBefore + 1);
	});
});
