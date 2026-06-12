import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { FlowJournal, FlowJournalMemoryLive, createInMemoryFlowJournal } from '../journal.js';
import type { FlowCheckpoint } from '../journal.js';

const row = (operationId: string, stepId: string): Omit<FlowCheckpoint, 'seq'> => ({
	operationId,
	flowId: 'booking_create_with_payment',
	flowVersion: '1.0.0',
	planHash: 'a'.repeat(64),
	stepId,
	attempt: 1,
	status: 'started',
	at: new Date('2026-06-12T00:00:00.000Z').toISOString(),
});

describe('in-memory FlowJournal', () => {
	it('assigns serial, gapless seq per operation starting at 0', async () => {
		const journal = createInMemoryFlowJournal();
		const first = await Effect.runPromise(journal.append(row('op-1', 'navigate')));
		const second = await Effect.runPromise(journal.append(row('op-1', 'fill')));
		expect(first.seq).toBe(0);
		expect(second.seq).toBe(1);
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.map((r) => r.seq)).toEqual([0, 1]);
	});

	it('isolates operations from each other', async () => {
		const journal = createInMemoryFlowJournal();
		await Effect.runPromise(journal.append(row('op-1', 'navigate')));
		const other = await Effect.runPromise(journal.append(row('op-2', 'navigate')));
		expect(other.seq).toBe(0);
		expect(await Effect.runPromise(journal.read('op-2'))).toHaveLength(1);
		expect(await Effect.runPromise(journal.read('missing'))).toEqual([]);
	});

	it('returns frozen, append-only rows', async () => {
		const journal = createInMemoryFlowJournal();
		const appended = await Effect.runPromise(journal.append(row('op-1', 'navigate')));
		expect(Object.isFrozen(appended)).toBe(true);
		const copy = await Effect.runPromise(journal.read('op-1'));
		expect(copy).not.toBe(await Effect.runPromise(journal.read('op-1')));
	});

	it('is providable through the FlowJournalMemoryLive layer', async () => {
		const program = Effect.gen(function* () {
			const journal = yield* FlowJournal;
			yield* journal.append(row('op-layer', 'navigate'));
			return yield* journal.read('op-layer');
		});
		const rows = await Effect.runPromise(program.pipe(Effect.provide(FlowJournalMemoryLive)));
		expect(rows).toHaveLength(1);
		expect(rows[0].stepId).toBe('navigate');
	});
});
