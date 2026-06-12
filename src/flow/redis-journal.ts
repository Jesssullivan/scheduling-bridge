/**
 * Redis FlowJournal — append-only checkpoint rows in a SEPARATE keyspace from the
 * job records (design: docs/design/flow-dag-formalization.md §4 storage layout, risk 1).
 *
 * Seq assignment is atomic with the append: one Lua script derives
 * `seq = LLEN bridge:flow:journal:{operationId}` and RPUSHes the seq-stamped row in
 * the same atomic step. A separate INCR counter is deliberately FORBIDDEN — it would
 * let two workers interleave under the lease-expiry race (counter incremented by A,
 * row pushed by B first), diverging list order from seq order and duplicating
 * attempt rows. With LLEN-derived seq inside one script, list order ≡ seq order by
 * construction, gapless, monotonic.
 *
 * The journal key carries a TTL coupled to the dedicated retention knob
 * (`BRIDGE_FLOW_JOURNAL_TTL_SECONDS`, parsed by `journal-config.ts`), decoupled from
 * the job-record TTL. EXPIRE runs inside the same script on every append, so
 * retention counts from the last write.
 *
 * Client handling and serialization follow `src/async/redis-store.ts` conventions:
 * accept an injected `client` or own one from `url` (only then exposing `close()`),
 * JSON rows, `ready()` = PING.
 */

import { Redis as IORedisImpl } from 'ioredis';
import type { Redis as IORedis, RedisOptions } from 'ioredis';
import { Effect } from 'effect';
import {
	JournalError,
	type FlowCheckpoint,
	type FlowJournalShape,
} from './journal.js';
import { DEFAULT_FLOW_JOURNAL_TTL_SECONDS } from './journal-config.js';

/**
 * Atomic seq-stamped append. The row arrives WITHOUT a `seq` field (stripped
 * caller-side); the script splices `"seq":<LLEN>` in as the first member so the
 * stored row is self-describing. Avoids cjson round-trips (not guaranteed under
 * every Lua host) via plain string splicing on the leading `{`.
 */
const LUA_APPEND_SEQ_STAMPED = `
local seq = redis.call('LLEN', KEYS[1])
local payload = ARGV[1]
local stamped
if payload == '{}' then
  stamped = '{"seq":' .. string.format('%d', seq) .. '}'
else
  stamped = '{"seq":' .. string.format('%d', seq) .. ',' .. string.sub(payload, 2)
end
redis.call('RPUSH', KEYS[1], stamped)
local ttl = tonumber(ARGV[2])
if ttl ~= nil and ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
end
return seq
`;

export const DEFAULT_FLOW_JOURNAL_KEY_PREFIX = 'bridge:flow:journal';

export interface RedisFlowJournalOptions {
	readonly client?: IORedis;
	readonly url?: string;
	readonly redisOptions?: RedisOptions;
	readonly keyPrefix?: string;
	/** Journal retention in seconds; see `journal-config.ts`. */
	readonly ttlSeconds?: number;
}

export type RedisFlowJournal = FlowJournalShape & {
	close?: () => Promise<void>;
	ready: () => Promise<void>;
};

const journalKey = (prefix: string, operationId: string): string =>
	`${prefix}:${operationId}`;

export const createRedisFlowJournal = (
	options: RedisFlowJournalOptions,
): RedisFlowJournal => {
	if (!options.client && !options.url) {
		throw new Error('createRedisFlowJournal requires client or url');
	}

	const ownsClient = !options.client;
	const client =
		options.client ?? new IORedisImpl(options.url!, options.redisOptions ?? {});
	const prefix = options.keyPrefix ?? DEFAULT_FLOW_JOURNAL_KEY_PREFIX;
	const ttlSeconds = options.ttlSeconds ?? DEFAULT_FLOW_JOURNAL_TTL_SECONDS;

	const appendRow = async (
		cp: Omit<FlowCheckpoint, 'seq'>,
	): Promise<FlowCheckpoint> => {
		// Defensive strip: the stamped seq is spliced FIRST, so a rogue runtime
		// `seq` on the payload would win on JSON.parse (last key wins). Remove it.
		const { seq: _ignored, ...row } = cp as FlowCheckpoint;
		const seq = (await client.eval(
			LUA_APPEND_SEQ_STAMPED,
			1,
			journalKey(prefix, row.operationId),
			JSON.stringify(row),
			String(ttlSeconds),
		)) as number;
		return Object.freeze({ ...row, seq: Number(seq) });
	};

	const readRows = async (
		operationId: string,
	): Promise<readonly FlowCheckpoint[]> => {
		const raws = await client.lrange(journalKey(prefix, operationId), 0, -1);
		return raws.map((raw) => JSON.parse(raw) as FlowCheckpoint);
	};

	const journal: RedisFlowJournal = {
		append: (cp) =>
			Effect.tryPromise({
				try: () => appendRow(cp),
				catch: (cause) =>
					new JournalError({
						message: `Redis flow journal append failed for operation ${cp.operationId}`,
						cause,
					}),
			}),
		read: (operationId) =>
			Effect.tryPromise({
				try: () => readRows(operationId),
				catch: (cause) =>
					new JournalError({
						message: `Redis flow journal read failed for operation ${operationId}`,
						cause,
					}),
			}),
		ready: async () => {
			await client.ping();
		},
	};

	if (ownsClient) {
		journal.close = async () => {
			await client.quit().then(
				() => undefined,
				() => undefined,
			);
		};
	}

	return journal;
};
