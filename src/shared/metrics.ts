import {
	Counter,
	Gauge,
	Histogram,
	Registry,
	collectDefaultMetrics,
} from 'prom-client';

/**
 * Prometheus metrics registry for the acuity-middleware bridge.
 *
 * Scope: Kubernetes phase 1.0 observability. SLIs are the canonical set
 * enumerated in spec §6.1 — do not extend this list without a spec update.
 *
 * The `Registry` is a module-level singleton. In tests, a shared registry
 * means counters accumulate across files — assertions should be written as
 * deltas (e.g. `after - before === 1`) rather than absolute values.
 */

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'acuity_' });

const browserActiveSessions = new Gauge({
	name: 'acuity_browser_active_sessions',
	help: 'Current number of open Playwright browser contexts',
	registers: [registry],
});

const pageOperationsDuration = new Histogram({
	name: 'acuity_page_operations_duration_seconds',
	help: 'Duration of Playwright page operations',
	labelNames: ['operation'],
	buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
	registers: [registry],
});

const cacheHitRatio = new Gauge({
	name: 'acuity_cache_hit_ratio',
	help: 'Derived: l1_hits / (l1_hits + l2_hits + misses)',
	registers: [registry],
});

const serviceCatalogScrapeTotal = new Counter({
	name: 'acuity_service_catalog_scrape_total',
	help: 'Service catalog scrapes, labelled by whether this pod was the lock winner',
	labelNames: ['source'],
	registers: [registry],
});

const serviceCatalogRefreshDuration = new Histogram({
	name: 'acuity_service_catalog_refresh_duration_seconds',
	help: 'Wall time to scrape Acuity service catalog',
	buckets: [0.5, 1, 2, 5, 10, 30, 60],
	registers: [registry],
});

export const metrics = {
	registry,
	browserActiveSessions,
	pageOperationsDuration,
	cacheHitRatio,
	serviceCatalogScrapeTotal,
	serviceCatalogRefreshDuration,
};

export const renderMetrics = (): Promise<string> => registry.metrics();
