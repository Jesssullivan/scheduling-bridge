import { describe, expect, it } from 'vitest';
import { createPageConcurrencyLimiter } from './browser-service.js';

describe('createPageConcurrencyLimiter', () => {
	it('queues page acquisition beyond the configured per-process cap', async () => {
		const limiter = createPageConcurrencyLimiter();
		const releaseFirst = await limiter.acquire(1, 1000);
		let secondAcquired = false;

		const second = limiter.acquire(1, 1000).then((release) => {
			secondAcquired = true;
			return release;
		});

		await Promise.resolve();
		expect(secondAcquired).toBe(false);
		expect(limiter.active()).toBe(1);
		expect(limiter.queued()).toBe(1);

		releaseFirst();
		const releaseSecond = await second;
		expect(secondAcquired).toBe(true);
		expect(limiter.active()).toBe(1);
		expect(limiter.queued()).toBe(0);

		releaseSecond();
		expect(limiter.active()).toBe(0);
	});

	it('times out queued page acquisition without leaking queue state', async () => {
		const limiter = createPageConcurrencyLimiter();
		const releaseFirst = await limiter.acquire(1, 1000);

		await expect(limiter.acquire(1, 5)).rejects.toThrow(
			'Timed out waiting for bridge browser page slot',
		);

		expect(limiter.active()).toBe(1);
		expect(limiter.queued()).toBe(0);
		releaseFirst();
		expect(limiter.active()).toBe(0);
	});
});
