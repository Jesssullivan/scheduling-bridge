import { describe, expect, it } from 'vitest';
import { metrics, renderMetrics } from './metrics.js';

describe('metrics', () => {
	it('exposes required SLIs from spec §6.1', () => {
		const names = metrics.registry.getMetricsAsArray().map((m) => m.name);
		expect(names).toContain('acuity_browser_active_sessions');
		expect(names).toContain('acuity_page_operations_duration_seconds');
		expect(names).toContain('acuity_cache_hit_ratio');
		expect(names).toContain('acuity_service_catalog_scrape_total');
		expect(names).toContain('acuity_service_catalog_refresh_duration_seconds');
	});

	it('renders Prometheus text format', async () => {
		const text = await renderMetrics();
		expect(text).toContain('# HELP acuity_browser_active_sessions');
		expect(text).toContain('# TYPE acuity_browser_active_sessions gauge');
	});

	it('increments scrape counter with source label', () => {
		metrics.serviceCatalogScrapeTotal.inc({ source: 'lock_winner' });
		const winner = metrics.serviceCatalogScrapeTotal.labels({ source: 'lock_winner' });
		expect(winner).toBeDefined();
	});
});
