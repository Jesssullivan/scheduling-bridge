/**
 * FlowJournal conformance — one suite, three stores (design §11 "Journal
 * conformance", §4 storage layout, risk 1). Mirrors the existing store test
 * pattern: memory directly, Redis via ioredis-mock (its fengari Lua executes the
 * LLEN+RPUSH append script atomically, like real Redis), Postgres via a fake pg
 * pool that emulates the READ COMMITTED race the PK-conflict retry exists for —
 * the fake yields between computing `max(seq)+1` and the uniqueness check, so
 * racing appends genuinely collide on `(operation_id, seq)` and exercise the
 * 23505 retry path.
 */

import { randomUUID } from 'node:crypto';
import IORedisMock from 'ioredis-mock';
import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import type pg from 'pg';
import {
	JournalError,
	createInMemoryFlowJournal,
	type FlowCheckpoint,
	type FlowJournalShape,
} from '../journal.js';
import {
	DEFAULT_FLOW_JOURNAL_KEY_PREFIX,
	createRedisFlowJournal,
} from '../redis-journal.js';
import {
	FLOW_JOURNAL_SCHEMA_SQL,
	createPostgresFlowJournal,
	ensureFlowJournalSchema,
} from '../postgres-journal.js';
import { DEFAULT_FLOW_JOURNAL_TTL_SECONDS } from '../journal-config.js';

const baseRow = (
	operationId: string,
	stepId: string,
	overrides: Partial<Omit<FlowCheckpoint, 'seq'>> = {},
): Omit<FlowCheckpoint, 'seq'> => ({
	operationId,
	flowId: 'booking_create_with_payment',
	flowVersion: '1.0.0',
	planHash: 'a'.repeat(64),
	stepId,
	attempt: 1,
	status: 'started',
	at: '2026-06-12T00:00:00.000Z',
	...overrides,
});

/** Every optional FlowCheckpoint field populated, for encode/decode fidelity. */
const fullRow = (operationId: string): Omit<FlowCheckpoint, 'seq'> =>
	baseRow(operationId, 'acuity/navigate', {
		status: 'rerouted',
		landing: {
			expected: ['acuity:client-form'],
			observed: 'acuity:service-selection',
			confidence: 0.85,
			evidence: [
				{ kind: 'selector', key: 'client-form-root', matched: false },
				{ kind: 'url', key: 'service-selection-url', matched: true },
			],
		},
		resolutions: [
			{
				value: { label: 'Massage 60', ref: '53178494' },
				confidence: 0.95,
				strategy: 'normalized-exact',
				matchedLabel: 'Massage 60',
				threshold: 0.8,
				alternates: [{ label: 'Massage 90', confidence: 0.62 }],
			},
		],
		stateDelta: { navResult: 'service-selection', nested: { ok: true } },
		idempotencyToken: 'ALT-VENMO-abc123',
		reroute: { to: 'acuity/navigate', remaining: 0 },
		error: {
			code: 'LANDING_DIVERGED',
			message: 'expected client-form, observed service-selection',
			retryable: true,
		},
	});

const append = (journal: FlowJournalShape, cp: Omit<FlowCheckpoint, 'seq'>) =>
	Effect.runPromise(journal.append(cp));
const read = (journal: FlowJournalShape, operationId: string) =>
	Effect.runPromise(journal.read(operationId));

// ---------------------------------------------------------------------------
// Fake pg pool for flow_checkpoints (no Postgres service exists in CI; the
// reusable template owns runners). It implements exactly the statements the
// journal issues, stores snake_case rows, enforces the composite PK with a
// pg-style `code: '23505'` error, and inserts an event-loop yield between the
// max(seq) read and the conflict check to emulate two READ COMMITTED
// statements racing — the scenario PRIMARY KEY (operation_id, seq) resolves.
// ---------------------------------------------------------------------------
interface FakeCheckpointRow {
	operation_id: string;
	seq: number;
	flow_id: string;
	flow_version: string;
	plan_hash: string;
	step_id: string;
	attempt: number;
	status: string;
	at: string;
	landing: unknown;
	resolutions: unknown;
	state_delta: unknown;
	idempotency_token: string | null;
	reroute: unknown;
	error: unknown;
}

const createFakeFlowCheckpointsPool = () => {
	const rows: FakeCheckpointRow[] = [];
	let ddlRuns = 0;
	let conflicts = 0;
	const pool = {
		async query(text: string, values?: unknown[]) {
			if (text.includes('create table if not exists flow_checkpoints')) {
				ddlRuns += 1;
				return { rows: [] };
			}
			if (text.includes('insert into flow_checkpoints')) {
				const v = values as unknown[];
				const operationId = v[0] as string;
				const seq =
					rows
						.filter((r) => r.operation_id === operationId)
						.reduce((max, r) => Math.max(max, r.seq), -1) + 1;
				// Yield: lets a concurrent append compute the same seq before we
				// commit, exactly like two single-statement inserts under READ
				// COMMITTED both reading the pre-insert max.
				await new Promise((resolve) => setTimeout(resolve, 0));
				if (
					rows.some((r) => r.operation_id === operationId && r.seq === seq)
				) {
					conflicts += 1;
					const error = new Error(
						'duplicate key value violates unique constraint "flow_checkpoints_pkey"',
					);
					(error as Error & { code: string }).code = '23505';
					throw error;
				}
				const parse = (raw: unknown): unknown =>
					raw === null || raw === undefined
						? null
						: JSON.parse(raw as string);
				const row: FakeCheckpointRow = {
					operation_id: operationId,
					seq,
					flow_id: v[1] as string,
					flow_version: v[2] as string,
					plan_hash: v[3] as string,
					step_id: v[4] as string,
					attempt: v[5] as number,
					status: v[6] as string,
					at: v[7] as string,
					landing: parse(v[8]),
					resolutions: parse(v[9]),
					state_delta: parse(v[10]),
					idempotency_token: (v[11] as string | null) ?? null,
					reroute: parse(v[12]),
					error: parse(v[13]),
				};
				rows.push(row);
				return { rows: [row] };
			}
			if (
				text.includes('from flow_checkpoints') &&
				text.includes('order by seq')
			) {
				const operationId = (values as unknown[])[0] as string;
				return {
					rows: rows
						.filter((r) => r.operation_id === operationId)
						.sort((a, b) => a.seq - b.seq),
				};
			}
			throw new Error(`fake flow_checkpoints pool: unexpected query ${text}`);
		},
		async end() {},
	};
	return {
		pool: pool as unknown as pg.Pool,
		stats: {
			get ddlRuns() {
				return ddlRuns;
			},
			get conflicts() {
				return conflicts;
			},
		},
	};
};

// ---------------------------------------------------------------------------
// Shared conformance matrix
// ---------------------------------------------------------------------------
interface JournalHarness {
	readonly name: string;
	readonly make: () => FlowJournalShape;
}

const harnesses: readonly JournalHarness[] = [
	{ name: 'memory', make: () => createInMemoryFlowJournal() },
	{
		name: 'redis',
		make: () =>
			createRedisFlowJournal({
				client: new IORedisMock() as never,
				keyPrefix: `test:flow:journal:${Date.now()}:${Math.random()}`,
			}),
	},
	{
		name: 'postgres',
		make: () =>
			createPostgresFlowJournal({
				pool: createFakeFlowCheckpointsPool().pool,
			}),
	},
];

describe.each(harnesses)('FlowJournal conformance: $name', ({ make }) => {
	it('assigns monotonic, gapless seq per operation starting at 0', async () => {
		const journal = make();
		const operationId = randomUUID();
		const first = await append(journal, baseRow(operationId, 'navigate'));
		const second = await append(journal, baseRow(operationId, 'fill'));
		const third = await append(journal, baseRow(operationId, 'submit'));
		expect([first.seq, second.seq, third.seq]).toEqual([0, 1, 2]);
		const rows = await read(journal, operationId);
		expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);
		expect(rows.map((r) => r.stepId)).toEqual(['navigate', 'fill', 'submit']);
	});

	it('keeps seq gapless and list-ordered under racing concurrent appends', async () => {
		const journal = make();
		const operationId = randomUUID();
		const racers = 16;
		const appended = await Promise.all(
			Array.from({ length: racers }, (_, i) =>
				append(journal, baseRow(operationId, `step-${i}`, { attempt: i })),
			),
		);
		// Every append got a unique seq covering 0..racers-1 with no gaps.
		expect(new Set(appended.map((cp) => cp.seq)).size).toBe(racers);
		expect([...appended.map((cp) => cp.seq)].sort((a, b) => a - b)).toEqual(
			Array.from({ length: racers }, (_, i) => i),
		);
		// Storage order must equal seq order (the invariant a separate INCR
		// counter would break under lease-expiry interleaving).
		const rows = await read(journal, operationId);
		expect(rows.map((r) => r.seq)).toEqual(
			Array.from({ length: racers }, (_, i) => i),
		);
		// And each row's payload travels with the seq it was stamped with.
		for (const cp of appended) {
			expect(rows[cp.seq]).toMatchObject({
				stepId: cp.stepId,
				attempt: cp.attempt,
			});
		}
	});

	it('isolates operations from each other', async () => {
		const journal = make();
		const opA = randomUUID();
		const opB = randomUUID();
		await append(journal, baseRow(opA, 'navigate'));
		await append(journal, baseRow(opA, 'fill'));
		const b = await append(journal, baseRow(opB, 'navigate'));
		expect(b.seq).toBe(0);
		expect((await read(journal, opA)).map((r) => r.seq)).toEqual([0, 1]);
		expect(await read(journal, opB)).toHaveLength(1);
		expect(await read(journal, randomUUID())).toEqual([]);
	});

	it('round-trips full FlowCheckpoint fidelity (landing/resolutions/stateDelta/reroute/error)', async () => {
		const journal = make();
		const operationId = randomUUID();
		const cp = fullRow(operationId);
		const appended = await append(journal, cp);
		expect(appended).toEqual({ ...cp, seq: 0 });
		const rows = await read(journal, operationId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({ ...cp, seq: 0 });
	});

	it('round-trips sparse checkpoints without optional fields', async () => {
		const journal = make();
		const operationId = randomUUID();
		const cp = baseRow(operationId, 'navigate');
		await append(journal, cp);
		const rows = await read(journal, operationId);
		expect(rows[0]).toEqual({ ...cp, seq: 0 });
		expect(rows[0].landing).toBeUndefined();
		expect(rows[0].stateDelta).toBeUndefined();
		expect(rows[0].reroute).toBeUndefined();
		expect(rows[0].error).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Redis-specific: TTL retention knob, separate keyspace, error mapping
// ---------------------------------------------------------------------------
describe('Redis FlowJournal specifics', () => {
	it('applies the retention TTL to the journal key and refreshes it per append', async () => {
		const redis = new IORedisMock();
		const keyPrefix = 'test:flow:journal:ttl';
		const journal = createRedisFlowJournal({
			client: redis as never,
			keyPrefix,
			ttlSeconds: 60,
		});
		const operationId = randomUUID();
		await append(journal, baseRow(operationId, 'navigate'));
		const key = `${keyPrefix}:${operationId}`;
		const firstTtl = await redis.pttl(key);
		expect(firstTtl).toBeGreaterThan(0);
		expect(firstTtl).toBeLessThanOrEqual(60_000);
		await append(journal, baseRow(operationId, 'fill'));
		const refreshed = await redis.pttl(key);
		expect(refreshed).toBeGreaterThan(0);
		expect(refreshed).toBeLessThanOrEqual(60_000);
	});

	it('defaults retention to the dedicated knob default, decoupled from the 7-day job TTL', async () => {
		const redis = new IORedisMock();
		const journal = createRedisFlowJournal({ client: redis as never });
		const operationId = randomUUID();
		await append(journal, baseRow(operationId, 'navigate'));
		const pttl = await redis.pttl(
			`${DEFAULT_FLOW_JOURNAL_KEY_PREFIX}:${operationId}`,
		);
		expect(DEFAULT_FLOW_JOURNAL_TTL_SECONDS).toBe(14 * 24 * 60 * 60);
		expect(pttl).toBeGreaterThan(13 * 24 * 60 * 60 * 1000);
		expect(pttl).toBeLessThanOrEqual(DEFAULT_FLOW_JOURNAL_TTL_SECONDS * 1000);
	});

	it('keeps the journal in its own keyspace (bridge:flow:journal:{operationId})', async () => {
		const redis = new IORedisMock();
		const journal = createRedisFlowJournal({ client: redis as never });
		const operationId = randomUUID();
		await append(journal, baseRow(operationId, 'navigate'));
		await expect(
			redis.exists(`${DEFAULT_FLOW_JOURNAL_KEY_PREFIX}:${operationId}`),
		).resolves.toBe(1);
		// Nothing leaks into the async-store keyspace.
		await expect(redis.keys('bridge-async:*')).resolves.toEqual([]);
	});

	it('requires client or url and exposes close/ready per redis-store conventions', async () => {
		expect(() => createRedisFlowJournal({})).toThrow(
			'createRedisFlowJournal requires client or url',
		);
		const shared = createRedisFlowJournal({
			client: new IORedisMock() as never,
		});
		expect(shared.close).toBeUndefined();
		await expect(shared.ready()).resolves.toBeUndefined();
	});

	it('maps decode failures to JournalError', async () => {
		const redis = new IORedisMock();
		const keyPrefix = 'test:flow:journal:corrupt';
		const journal = createRedisFlowJournal({
			client: redis as never,
			keyPrefix,
		});
		const operationId = randomUUID();
		await redis.rpush(`${keyPrefix}:${operationId}`, 'not-json');
		const failure = await Effect.runPromise(
			Effect.flip(journal.read(operationId)),
		);
		expect(failure).toBeInstanceOf(JournalError);
		expect(failure.message).toContain(operationId);
	});
});

// ---------------------------------------------------------------------------
// Postgres-specific: schema shape, migrate gating, PK-conflict retry behavior
// ---------------------------------------------------------------------------
describe('Postgres FlowJournal specifics', () => {
	it('declares the additive flow_checkpoints table with composite PK (operation_id, seq)', () => {
		expect(FLOW_JOURNAL_SCHEMA_SQL).toContain(
			'create table if not exists flow_checkpoints',
		);
		expect(FLOW_JOURNAL_SCHEMA_SQL).toContain('primary key (operation_id, seq)');
		// Journal data never lives in the job record (design risk 1).
		expect(FLOW_JOURNAL_SCHEMA_SQL).not.toContain('bridge_jobs');
	});

	it('runs the bootstrap DDL once via the ready gate, and skips it with migrate: false', async () => {
		const fake = createFakeFlowCheckpointsPool();
		const journal = createPostgresFlowJournal({ pool: fake.pool });
		await journal.ready();
		await append(journal, baseRow(randomUUID(), 'navigate'));
		expect(fake.stats.ddlRuns).toBe(1);

		const unmanaged = createFakeFlowCheckpointsPool();
		const noMigrate = createPostgresFlowJournal({
			pool: unmanaged.pool,
			migrate: false,
		});
		await noMigrate.ready();
		expect(unmanaged.stats.ddlRuns).toBe(0);
		await expect(ensureFlowJournalSchema(unmanaged.pool)).resolves.toBeUndefined();
		expect(unmanaged.stats.ddlRuns).toBe(1);
	});

	it('resolves racing appends through 23505 PK-conflict retries (no duplicate, no gap)', async () => {
		const fake = createFakeFlowCheckpointsPool();
		const journal = createPostgresFlowJournal({ pool: fake.pool });
		const operationId = randomUUID();
		const racers = 12;
		const appended = await Promise.all(
			Array.from({ length: racers }, (_, i) =>
				append(journal, baseRow(operationId, `step-${i}`)),
			),
		);
		// The fake's yield guarantees real collisions; the retry loop absorbed them.
		expect(fake.stats.conflicts).toBeGreaterThan(0);
		expect([...appended.map((cp) => cp.seq)].sort((a, b) => a - b)).toEqual(
			Array.from({ length: racers }, (_, i) => i),
		);
	});

	it('surfaces exhausted seq-conflict retries as JournalError', async () => {
		const fake = createFakeFlowCheckpointsPool();
		const journal = createPostgresFlowJournal({
			pool: fake.pool,
			maxSeqConflictRetries: 1,
		});
		const operationId = randomUUID();
		const outcomes = await Promise.allSettled(
			Array.from({ length: 4 }, (_, i) =>
				append(journal, baseRow(operationId, `step-${i}`)),
			),
		);
		const rejected = outcomes.filter((o) => o.status === 'rejected');
		expect(rejected.length).toBeGreaterThan(0);
	});

	it('requires pool or connectionString', () => {
		expect(() => createPostgresFlowJournal({})).toThrow(
			'createPostgresFlowJournal requires pool or connectionString',
		);
	});
});
