import { Effect, Layer } from 'effect';
import IORedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Redis as IORedis } from 'ioredis';
import { getCached, RedisL2 } from './redis-l2.js';

/**
 * JSON round-trip contract: values pass through `JSON.stringify`/`JSON.parse`.
 * Date objects are NOT revived — callers that need Date semantics should parse
 * ISO strings on read. Plain objects, arrays, primitives, nested structures all
 * survive the round-trip.
 */

// Helper: inject a pre-instantiated ioredis-mock as the RedisL2 service.
// We cast through `unknown` — ioredis-mock is structurally compatible with
// the subset of ioredis (`get`/`set`/`eval`) used by redis-l2.
const mockLayer = (mock: IORedisMock) =>
	Layer.succeed(RedisL2, mock as unknown as IORedis);

const run = <A>(
	mock: IORedisMock,
	eff: Effect.Effect<A, unknown, RedisL2>,
): Promise<A> =>
	Effect.runPromise(
		eff.pipe(Effect.provide(mockLayer(mock))) as Effect.Effect<A, unknown, never>,
	);

describe('RedisL2.getCached', () => {
	let mock: IORedisMock;

	beforeEach(() => {
		mock = new IORedisMock();
	});

	it('returns cached value on hit without calling mk', async () => {
		await mock.set('k', JSON.stringify({ hello: 'world' }));
		const mk = vi.fn(async () => ({ hello: 'fresh' }));

		const out = await run(mock, getCached('k', 60, mk));
		expect(out).toEqual({ hello: 'world' });
		expect(mk).not.toHaveBeenCalled();
	});

	it('miss -> winner: mk called exactly once, cache written with ~ttl, lock released', async () => {
		const mk = vi.fn(async () => ({ computed: 42 }));

		const out = await run(mock, getCached('k', 90, mk));
		expect(out).toEqual({ computed: 42 });
		expect(mk).toHaveBeenCalledTimes(1);

		// Cache populated
		const cached = await mock.get('k');
		expect(JSON.parse(cached!)).toEqual({ computed: 42 });

		// TTL ~90s (wide tolerance — ioredis-mock uses real timers)
		const ttlMs = await mock.pttl('k');
		expect(ttlMs).toBeGreaterThan(80_000);
		expect(ttlMs).toBeLessThanOrEqual(90_000);

		// Lock released
		const lock = await mock.get('lock:k');
		expect(lock).toBeNull();
	});

	it('single-flight: only one of N concurrent callers runs mk; others read cache', async () => {
		let calls = 0;
		const mk = async () => {
			calls += 1;
			// simulate modest work so concurrent callers race into loser path
			await new Promise((r) => setTimeout(r, 120));
			return { id: calls };
		};

		const results = await Promise.all(
			Array.from({ length: 5 }, () => run(mock, getCached('shared', 60, mk))),
		);

		expect(calls).toBe(1);
		for (const r of results) expect(r).toEqual({ id: 1 });
	});

	it('loser polls at ~50ms cadence and resolves when winner writes', async () => {
		// Pre-seat the lock so the next caller becomes a loser.
		await mock.set('lock:late', 'winner-token', 'PX', 30_000, 'NX');

		// After 200ms, "winner" writes the cache value.
		setTimeout(() => {
			void mock.set('late', JSON.stringify({ ok: true }), 'EX', 60);
		}, 200);

		const mk = vi.fn(async () => ({ wrong: true }));

		const start = Date.now();
		const out = await run(mock, getCached('late', 60, mk));
		const elapsed = Date.now() - start;

		expect(out).toEqual({ ok: true });
		expect(mk).not.toHaveBeenCalled();
		// Poll cadence is 50ms; should observe within ~300ms of winner writing.
		expect(elapsed).toBeLessThan(1000);
		// Must have actually polled (waited for winner) — > poll interval.
		expect(elapsed).toBeGreaterThanOrEqual(150);
	});

	it(
		'loser times out at 10s and falls through to run mk independently',
		async () => {
			// Pre-seat the lock with a long TTL and never write the cache.
			await mock.set('lock:stuck', 'ghost-token', 'PX', 60_000, 'NX');

			const mk = vi.fn(async () => ({ fallback: true }));

			const start = Date.now();
			const out = await run(mock, getCached('stuck', 60, mk));
			const elapsed = Date.now() - start;

			// Degraded single-flight: loser falls through and runs mk itself.
			expect(out).toEqual({ fallback: true });
			expect(mk).toHaveBeenCalledTimes(1);
			// Must have waited roughly MAX_WAIT_MS (10s) before falling through.
			expect(elapsed).toBeGreaterThanOrEqual(9_500);
			expect(elapsed).toBeLessThan(12_000);
		},
		{ timeout: 15_000 },
	);

	it('lock TTL expires after its window; second caller acquires new lock', async () => {
		// Simulate a "stuck winner": another process is holding the lock but
		// will never finish. Use a short artificial lock TTL to avoid making
		// the test run 30s — we set the lock manually with a 200ms TTL.
		await mock.set('lock:slow', 'dead-winner', 'PX', 200, 'NX');

		// Sanity: another caller cannot re-acquire while the lock is live.
		const blocked = await mock.set('lock:slow', 'me', 'PX', 200, 'NX');
		expect(blocked).toBeNull();

		// Wait past the lock TTL.
		await new Promise((r) => setTimeout(r, 250));

		// A fresh getCached should become the NEW winner and populate cache.
		const mk = vi.fn(async () => ({ second: true }));
		const out = await run(mock, getCached('slow', 60, mk));

		expect(out).toEqual({ second: true });
		expect(mk).toHaveBeenCalledTimes(1);

		// Cache populated by the second caller.
		expect(JSON.parse((await mock.get('slow'))!)).toEqual({ second: true });
	});

	it("Lua CAS release does not delete a successor's lock", async () => {
		// Simulate: winner A held lock with tokenA but its lock expired.
		// Successor B acquired a fresh lock with tokenB. If A later attempts
		// to release using tokenA, the Lua CAS must NOT delete B's lock.
		await mock.set('lock:cas', 'tokenB', 'PX', 60_000, 'NX');

		// A's Lua release attempt with its stale tokenA (identical to redis-l2.ts).
		const LUA_CAS_DEL = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`;
		const result = await mock.eval(LUA_CAS_DEL, 1, 'lock:cas', 'tokenA');
		expect(result).toBe(0);

		// B's lock is still there.
		expect(await mock.get('lock:cas')).toBe('tokenB');
	});

	it('round-trips JSON values (objects, arrays, ISO strings)', async () => {
		const value = {
			list: [1, 2, 3],
			nested: { a: { b: 'c' } },
			iso: '2026-04-17T12:00:00.000Z',
			nullable: null,
			bool: true,
		};
		const mk = vi.fn(async () => value);

		const out = await run(mock, getCached('json', 60, mk));
		expect(out).toEqual(value);

		// Second call is a cache hit — mk not called again.
		const out2 = await run(mock, getCached('json', 60, mk));
		expect(out2).toEqual(value);
		expect(mk).toHaveBeenCalledTimes(1);
	});
});
