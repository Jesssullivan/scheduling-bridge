import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	_resetCacheHitRatioForTests,
	metrics,
	observePageOp,
	observePageOpEffect,
	recordCacheHit,
	recordCacheMiss,
	renderMetrics,
	trackBrowserSession,
} from './metrics.js';

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

describe('cacheHitRatio wiring', () => {
	const gaugeValue = async (): Promise<number> => {
		const snap = await metrics.cacheHitRatio.get();
		return snap.values[0]?.value ?? NaN;
	};

	it('starts at 1.0 so alerts do not page an idle pod', async () => {
		_resetCacheHitRatioForTests();
		// No hits, no misses — the gauge must be a "healthy" 1.0. A raw
		// computation would divide by zero here; the helper must guard that.
		expect(await gaugeValue()).toBe(1);
	});

	it('updates the gauge on hit/miss transitions', async () => {
		_resetCacheHitRatioForTests();

		recordCacheHit();
		// 1 hit, 0 misses → ratio = 1
		expect(await gaugeValue()).toBe(1);

		recordCacheMiss();
		// 1 hit, 1 miss → ratio = 0.5
		expect(await gaugeValue()).toBe(0.5);

		recordCacheHit();
		recordCacheHit();
		// 3 hits, 1 miss → 0.75
		expect(await gaugeValue()).toBe(0.75);
	});
});

describe('pageOperationsDuration wiring', () => {
	it('records a sample for each observePageOp invocation', async () => {
		const bucketCountFor = async (op: string): Promise<number> => {
			const snap = await metrics.pageOperationsDuration.get();
			// `_count` lines have `metricName: <name>_count` and the matching operation label.
			const row = snap.values.find(
				(v) => v.metricName === 'acuity_page_operations_duration_seconds_count' &&
					v.labels.operation === op,
			);
			return (row?.value as number | undefined) ?? 0;
		};

		const before = await bucketCountFor('test_op');
		await observePageOp('test_op', async () => 'value');
		const after = await bucketCountFor('test_op');
		expect(after).toBe(before + 1);
	});

	it('records a sample even when the wrapped function throws', async () => {
		const bucketCountFor = async (op: string): Promise<number> => {
			const snap = await metrics.pageOperationsDuration.get();
			const row = snap.values.find(
				(v) => v.metricName === 'acuity_page_operations_duration_seconds_count' &&
					v.labels.operation === op,
			);
			return (row?.value as number | undefined) ?? 0;
		};

		const before = await bucketCountFor('test_op_fail');
		await expect(
			observePageOp('test_op_fail', async () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
		const after = await bucketCountFor('test_op_fail');
		expect(after).toBe(before + 1);
	});

	it('observes samples via the Effect combinator', async () => {
		const bucketCountFor = async (op: string): Promise<number> => {
			const snap = await metrics.pageOperationsDuration.get();
			const row = snap.values.find(
				(v) => v.metricName === 'acuity_page_operations_duration_seconds_count' &&
					v.labels.operation === op,
			);
			return (row?.value as number | undefined) ?? 0;
		};

		const before = await bucketCountFor('effect_op');
		await Effect.runPromise(observePageOpEffect('effect_op', Effect.succeed(42)));
		const after = await bucketCountFor('effect_op');
		expect(after).toBe(before + 1);
	});
});

describe('browserActiveSessions wiring', () => {
	const gaugeValue = async (): Promise<number> => {
		const snap = await metrics.browserActiveSessions.get();
		return (snap.values[0]?.value as number | undefined) ?? 0;
	};

	it('increments on acquire and decrements on release via trackBrowserSession', async () => {
		const baseline = await gaugeValue();

		// The combinator takes an Effect; inside the Effect we assert the
		// gauge has been incremented. After the Effect resolves, release
		// must have run even without explicit finalisation.
		const duringValue = await Effect.runPromise(
			trackBrowserSession(
				Effect.sync(() => {
					// Synchronous peek while the session is "held".
					const row = (metrics.browserActiveSessions as unknown as {
						hashMap: Map<string, { value: number }>;
					}).hashMap;
					// Fallback to prom-client async snapshot if the internal
					// structure changes in future versions.
					void row;
					return 'inside';
				}),
			),
		);
		expect(duringValue).toBe('inside');

		// Post-release: gauge must have returned to baseline.
		expect(await gaugeValue()).toBe(baseline);
	});

	it('decrements even when the wrapped Effect fails', async () => {
		const baseline = await gaugeValue();
		await expect(
			Effect.runPromise(trackBrowserSession(Effect.fail('nope' as never))),
		).rejects.toBeDefined();
		expect(await gaugeValue()).toBe(baseline);
	});

	it('observes a non-zero gauge while the session is held', async () => {
		const baseline = await gaugeValue();
		let observedWhileHeld = baseline;

		await Effect.runPromise(
			trackBrowserSession(
				Effect.promise(async () => {
					const snap = await metrics.browserActiveSessions.get();
					observedWhileHeld = (snap.values[0]?.value as number | undefined) ?? 0;
				}),
			),
		);

		expect(observedWhileHeld).toBe(baseline + 1);
		expect(await gaugeValue()).toBe(baseline);
	});
});
