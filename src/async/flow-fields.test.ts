/**
 * Additive planHash?/flowVersion? on BridgeJobRecord (design §4/§5 plan-hash
 * pinning): pinned at enqueue via EnqueueBridgeJobOptions, round-tripped through
 * all three stores, and absent-but-harmless on records enqueued without them.
 * New file — existing store suites are intentionally untouched (0.6.0 invariant).
 *
 * Postgres is exercised against a fake pg.Pool injected via vi.mock (no Postgres
 * service exists in CI; the reusable workflow template owns runners). The fake
 * implements exactly the enqueue insert and getJob select the store issues.
 */

import IORedisMock from 'ioredis-mock';
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryBridgeAsyncStore } from './store.js';
import { createRedisBridgeAsyncStore } from './redis-store.js';
import {
	BRIDGE_ASYNC_SCHEMA_SQL,
	createPostgresBridgeAsyncStore,
} from './postgres-store.js';
import type { BridgeJobCommand } from './types.js';

const fakePg = vi.hoisted(() => {
	interface FakeJobRow {
		operation_id: string;
		kind: string;
		status: string;
		command: unknown;
		idempotency_key: string | null;
		attempts: number;
		created_at: Date;
		updated_at: Date;
		leased_by: string | null;
		leased_until: Date | null;
		result: unknown;
		failure: unknown;
		plan_hash: string | null;
		flow_version: string | null;
	}
	const rows: FakeJobRow[] = [];
	const pool = {
		async query(text: string, values?: unknown[]) {
			if (text.includes('insert into bridge_jobs')) {
				const v = values as unknown[];
				const idempotencyKey = (v[3] as string | null) ?? null;
				if (idempotencyKey) {
					const existing = rows.find(
						(r) => r.idempotency_key === idempotencyKey,
					);
					if (existing) return { rows: [existing] };
				}
				const row: FakeJobRow = {
					operation_id: v[0] as string,
					kind: v[1] as string,
					status: 'queued',
					command: JSON.parse(v[2] as string),
					idempotency_key: idempotencyKey,
					attempts: 0,
					created_at: new Date(),
					updated_at: new Date(),
					leased_by: null,
					leased_until: null,
					result: null,
					failure: null,
					plan_hash: (v[4] as string | null) ?? null,
					flow_version: (v[5] as string | null) ?? null,
				};
				rows.push(row);
				return { rows: [row] };
			}
			if (text.includes('select * from bridge_jobs where operation_id')) {
				const operationId = (values as unknown[])[0] as string;
				return { rows: rows.filter((r) => r.operation_id === operationId) };
			}
			throw new Error(`fake bridge_jobs pool: unexpected query ${text}`);
		},
		async end() {},
	};
	return { pool };
});

vi.mock('pg', () => ({
	default: {
		Pool: class FakePoolFacade {
			constructor() {
				// Returning an object from a constructor substitutes it for `this`.
				return fakePg.pool as never;
			}
		},
	},
}));

const profile = {
	backend: 'acuity' as const,
	baseUrl: 'https://example.as.me',
};

const datesJob: BridgeJobCommand = {
	kind: 'availability_dates_refresh',
	command: {
		serviceId: '53178494',
		month: '2026-06',
		adapterProfile: profile,
	},
};

const PLAN_HASH = 'b'.repeat(64);
const FLOW_VERSION = '1.0.0';

describe('memory store planHash/flowVersion round-trip', () => {
	it('pins the fields at enqueue and preserves them through lease and completion', async () => {
		const store = createInMemoryBridgeAsyncStore();
		const record = await store.enqueueJob(datesJob, {
			planHash: PLAN_HASH,
			flowVersion: FLOW_VERSION,
		});
		expect(record.planHash).toBe(PLAN_HASH);
		expect(record.flowVersion).toBe(FLOW_VERSION);

		const fetched = await store.getJob(record.operationId);
		expect(fetched).toMatchObject({
			planHash: PLAN_HASH,
			flowVersion: FLOW_VERSION,
		});

		const running = await store.markJobRunning(record.operationId, {
			workerId: 'worker-a',
			leasedUntil: new Date(Date.now() + 60_000),
		});
		expect(running).toMatchObject({
			planHash: PLAN_HASH,
			flowVersion: FLOW_VERSION,
		});

		const done = await store.completeJob(record.operationId, {
			kind: 'availability_dates_refresh',
			dates: [],
		});
		expect(done).toMatchObject({
			planHash: PLAN_HASH,
			flowVersion: FLOW_VERSION,
		});
	});

	it('keeps records enqueued without the fields working, fields absent', async () => {
		const store = createInMemoryBridgeAsyncStore();
		const record = await store.enqueueJob(datesJob);
		expect(record.planHash).toBeUndefined();
		expect(record.flowVersion).toBeUndefined();
		const fetched = await store.getJob(record.operationId);
		expect(fetched?.planHash).toBeUndefined();
		expect(fetched?.flowVersion).toBeUndefined();
	});
});

describe('redis store planHash/flowVersion round-trip', () => {
	const createStore = (redis: IORedisMock) =>
		createRedisBridgeAsyncStore({
			client: redis as never,
			keyPrefix: `test-bridge-async:flow-fields:${Date.now()}:${Math.random()}`,
		});

	it('pins the fields at enqueue (idempotent and plain) and round-trips them', async () => {
		const store = createStore(new IORedisMock());
		const plain = await store.enqueueJob(datesJob, {
			planHash: PLAN_HASH,
			flowVersion: FLOW_VERSION,
		});
		expect(plain).toMatchObject({
			planHash: PLAN_HASH,
			flowVersion: FLOW_VERSION,
		});
		await expect(store.getJob(plain.operationId)).resolves.toMatchObject({
			planHash: PLAN_HASH,
			flowVersion: FLOW_VERSION,
		});

		const idempotent = await store.enqueueJob(datesJob, {
			idempotencyKey: 'flow-fields:dates:2026-06',
			planHash: PLAN_HASH,
			flowVersion: FLOW_VERSION,
		});
		expect(idempotent).toMatchObject({
			planHash: PLAN_HASH,
			flowVersion: FLOW_VERSION,
		});
		// Dedup returns the winner's pinned hash, not the loser's.
		const deduped = await store.enqueueJob(datesJob, {
			idempotencyKey: 'flow-fields:dates:2026-06',
			planHash: 'c'.repeat(64),
			flowVersion: '9.9.9',
		});
		expect(deduped.operationId).toBe(idempotent.operationId);
		expect(deduped.planHash).toBe(PLAN_HASH);
		expect(deduped.flowVersion).toBe(FLOW_VERSION);
	});

	it('preserves the fields through lease/requeue read-modify-write cycles', async () => {
		const store = createStore(new IORedisMock());
		const record = await store.enqueueJob(datesJob, {
			planHash: PLAN_HASH,
			flowVersion: FLOW_VERSION,
		});
		const running = await store.markJobRunning(record.operationId, {
			workerId: 'worker-a',
			leasedUntil: new Date(Date.now() + 60_000),
		});
		expect(running).toMatchObject({
			planHash: PLAN_HASH,
			flowVersion: FLOW_VERSION,
		});
		const requeued = await store.requeueJob(record.operationId);
		expect(requeued).toMatchObject({
			planHash: PLAN_HASH,
			flowVersion: FLOW_VERSION,
		});
	});

	it('leaves the fields absent for records enqueued without them', async () => {
		const store = createStore(new IORedisMock());
		const record = await store.enqueueJob(datesJob);
		expect(record.planHash).toBeUndefined();
		const fetched = await store.getJob(record.operationId);
		expect(fetched?.planHash).toBeUndefined();
		expect(fetched?.flowVersion).toBeUndefined();
	});
});

describe('postgres store planHash/flowVersion round-trip', () => {
	it('adds the columns additively (existing tables upgraded in place)', () => {
		expect(BRIDGE_ASYNC_SCHEMA_SQL).toContain(
			'alter table bridge_jobs add column if not exists plan_hash text',
		);
		expect(BRIDGE_ASYNC_SCHEMA_SQL).toContain(
			'alter table bridge_jobs add column if not exists flow_version text',
		);
	});

	it('binds the fields at enqueue and maps them back from rows (null -> undefined)', async () => {
		const store = createPostgresBridgeAsyncStore({
			connectionString: 'postgres://fake-pool-via-vi-mock',
			migrate: false,
		});

		const record = await store.enqueueJob(datesJob, {
			planHash: PLAN_HASH,
			flowVersion: FLOW_VERSION,
		});
		expect(record.planHash).toBe(PLAN_HASH);
		expect(record.flowVersion).toBe(FLOW_VERSION);
		await expect(store.getJob(record.operationId)).resolves.toMatchObject({
			planHash: PLAN_HASH,
			flowVersion: FLOW_VERSION,
		});

		const bare = await store.enqueueJob(datesJob);
		expect(bare.planHash).toBeUndefined();
		expect(bare.flowVersion).toBeUndefined();
		const bareFetched = await store.getJob(bare.operationId);
		expect(bareFetched?.planHash).toBeUndefined();
		expect(bareFetched?.flowVersion).toBeUndefined();

		// Idempotent dedup keeps the winner's pinned fields.
		const winner = await store.enqueueJob(datesJob, {
			idempotencyKey: 'pg-flow-fields:dates:2026-06',
			planHash: PLAN_HASH,
			flowVersion: FLOW_VERSION,
		});
		const loser = await store.enqueueJob(datesJob, {
			idempotencyKey: 'pg-flow-fields:dates:2026-06',
			planHash: 'c'.repeat(64),
			flowVersion: '9.9.9',
		});
		expect(loser.operationId).toBe(winner.operationId);
		expect(loser.planHash).toBe(PLAN_HASH);
		expect(loser.flowVersion).toBe(FLOW_VERSION);
	});
});
