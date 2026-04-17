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
		// Prime the histogram so the text exposition includes bucket/sum/count
		// lines (empty histograms render with zero buckets only).
		metrics.pageOperationsDuration.observe({ operation: 'test' }, 0.5);
		const text = await renderMetrics();
		expect(text).toContain('# HELP acuity_browser_active_sessions');
		expect(text).toContain('# TYPE acuity_browser_active_sessions gauge');
		// Histogram exposition: per-bucket cumulative, total sum, total count.
		expect(text).toContain('acuity_page_operations_duration_seconds_bucket{');
		expect(text).toContain('acuity_page_operations_duration_seconds_sum');
		expect(text).toContain('acuity_page_operations_duration_seconds_count');
	});

	it('increments scrape counter with source label', async () => {
		// Delta assertion — registry is a module-level singleton so absolute
		// values accumulate across tests. Pin the +1 rather than trust state.
		const before =
			(await metrics.serviceCatalogScrapeTotal.get()).values.find(
				(v) => v.labels.source === 'lock_winner',
			)?.value ?? 0;
		metrics.serviceCatalogScrapeTotal.inc({ source: 'lock_winner' });
		const after =
			(await metrics.serviceCatalogScrapeTotal.get()).values.find(
				(v) => v.labels.source === 'lock_winner',
			)?.value ?? 0;
		expect(after).toBe(before + 1);
	});
});
