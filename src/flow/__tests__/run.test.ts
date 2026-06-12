import { describe, expect, it } from 'vitest';
import { Cause, Context, Effect, Exit, Layer, Option, Schedule } from 'effect';
import { makeFlow } from '../flow.js';
import { FlowJournal, JournalError, createInMemoryFlowJournal, type FlowJournalShape } from '../journal.js';
import { FlowDivergedError, runFlow } from '../run.js';
import { makeStep, observation, spec } from './helpers.js';

const identity = { flowId: 'booking_create_with_payment', backend: 'acuity', version: '1.0.0' } as const;
const options = { operationId: 'op-1', sessionLayer: () => Layer.empty } as const;

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
	if (!Exit.isFailure(exit)) throw new Error('expected a failure exit');
	const failure = Cause.failureOption(exit.cause);
	if (Option.isNone(failure)) throw new Error('expected a typed failure');
	return failure.value;
};

class StepFailure extends Error {
	readonly _tag = 'StepFailure';
}

describe('runFlow', () => {
	it('journals the happy-path checkpoint sequence and lands on the intended terminal', async () => {
		const journal = createInMemoryFlowJournal();
		const flow = makeFlow(spec, ['bookingRef'])
			.add(
				makeStep({
					id: 'acuity/navigate',
					needs: ['bookingRef'],
					provides: ['navResult'],
					expects: ['acuity:client-form'],
					run: (input) =>
						Effect.succeed({
							state: { navResult: `nav:${input.bookingRef}` },
							observed: observation('acuity:client-form', ['acuity:client-form']),
						}),
				}),
			)
			.add(
				makeStep({
					id: 'acuity/fill-form',
					needs: ['navResult'],
					provides: ['formResult'],
					run: (input) => Effect.succeed({ state: { formResult: `form:${input.navResult}` } }),
				}),
			)
			.build(identity);

		const outcome = await Effect.runPromise(
			runFlow(flow, { bookingRef: 'ref-9' }, options).pipe(
				Effect.provideService(FlowJournal, journal),
			),
		);

		expect(outcome.landed).toBe('intended-terminal');
		expect(outcome.terminalStepId).toBe('acuity/fill-form');
		expect(outcome.confidenceFloor).toBe(1);
		expect(outcome.output.formResult).toBe('form:nav:ref-9');

		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.map((r) => [r.seq, r.stepId, r.status, r.attempt])).toEqual([
			[0, 'acuity/navigate', 'started', 1],
			[1, 'acuity/navigate', 'completed', 1],
			[2, 'acuity/fill-form', 'started', 1],
			[3, 'acuity/fill-form', 'completed', 1],
		]);
		expect(rows.every((r) => r.planHash === flow.planHash && r.flowId === flow.plan.flowId)).toBe(true);
		expect(rows[1].landing?.observed).toBe('acuity:client-form');
	});

	it('honors the step retry schedule', async () => {
		const journal = createInMemoryFlowJournal();
		let runs = 0;
		const flow = makeFlow(spec)
			.add(
				makeStep({
					id: 'flaky',
					needs: [],
					provides: ['navResult'],
					retry: Schedule.recurs(2),
					run: () =>
						Effect.suspend(() => {
							runs += 1;
							return runs < 3
								? Effect.fail(new StepFailure('not yet'))
								: Effect.succeed({ state: { navResult: 'ok' } });
						}),
				}),
			)
			.build(identity);

		const outcome = await Effect.runPromise(
			runFlow(flow, {}, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		expect(runs).toBe(3);
		expect(outcome.output.navResult).toBe('ok');
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.map((r) => r.status)).toEqual(['started', 'completed']);
	});

	it('defaults to Schedule.stop (no retry) and journals the failure', async () => {
		const journal = createInMemoryFlowJournal();
		let runs = 0;
		const flow = makeFlow(spec)
			.add(
				makeStep({
					id: 'fragile',
					needs: [],
					provides: ['navResult'],
					run: () =>
						Effect.suspend(() => {
							runs += 1;
							return Effect.fail(new StepFailure('boom'));
						}),
				}),
			)
			.build(identity);

		const exit = await Effect.runPromiseExit(
			runFlow(flow, {}, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		expect(runs).toBe(1);
		expect(failureOf(exit)).toBeInstanceOf(StepFailure);
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.map((r) => r.status)).toEqual(['started', 'failed']);
		expect(rows[1].error?.code).toBe('StepFailure');
	});

	it('reroutes backward along a declared recovery edge, decrementing the journaled budget', async () => {
		const journal = createInMemoryFlowJournal();
		let landings = 0;
		const flow = makeFlow(spec, ['bookingRef'])
			.add(
				makeStep({
					id: 'acuity/navigate',
					needs: ['bookingRef'],
					provides: ['navResult'],
					expects: ['acuity:client-form'],
					run: () =>
						Effect.sync(() => {
							landings += 1;
							return {
								state: { navResult: 'ok' },
								observed:
									landings === 1
										? observation('acuity:service-selection', ['acuity:client-form'])
										: observation('acuity:client-form', ['acuity:client-form']),
							};
						}),
				}),
			)
			.recover('acuity/navigate', { to: 'acuity/navigate', maxReentries: 1 })
			.build(identity);

		const outcome = await Effect.runPromise(
			runFlow(flow, { bookingRef: 'r' }, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		expect(outcome.landed).toBe('alternate-terminal');
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.map((r) => [r.status, r.attempt])).toEqual([
			['started', 1],
			['rerouted', 1],
			['started', 2],
			['completed', 2],
		]);
		expect(rows[1].reroute).toEqual({ to: 'acuity/navigate', remaining: 0 });
		expect(rows[1].landing?.observed).toBe('acuity:service-selection');
	});

	it('escalates to Diverged with the observation attached once the re-entry budget is exhausted', async () => {
		const journal = createInMemoryFlowJournal();
		let runs = 0;
		const flow = makeFlow(spec, ['bookingRef'])
			.add(
				makeStep({
					id: 'acuity/navigate',
					needs: ['bookingRef'],
					provides: ['navResult'],
					expects: ['acuity:client-form'],
					run: () =>
						Effect.sync(() => {
							runs += 1;
							return {
								state: { navResult: 'ok' },
								observed: observation('acuity:service-selection', ['acuity:client-form']),
							};
						}),
				}),
			)
			.recover('acuity/navigate', { to: 'acuity/navigate', maxReentries: 2 })
			.build(identity);

		const exit = await Effect.runPromiseExit(
			runFlow(flow, { bookingRef: 'r' }, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		const error = failureOf(exit) as FlowDivergedError;
		expect(error._tag).toBe('FlowDivergedError');
		expect(error.stepId).toBe('acuity/navigate');
		expect(error.observation.observed).toBe('acuity:service-selection');

		// Termination bound: |nodes| x (1 + sum maxReentries) = 1 x (1 + 2) = 3 executions.
		expect(runs).toBe(3);
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.map((r) => r.status)).toEqual([
			'started',
			'rerouted',
			'started',
			'rerouted',
			'started',
			'failed',
		]);
		expect(rows.filter((r) => r.status === 'rerouted').map((r) => r.reroute?.remaining)).toEqual([1, 0]);
		expect(rows[5].error?.code).toBe('FLOW_DIVERGED');
	});

	it('leaves an effectful-once started-without-completed trail visible in the journal', async () => {
		const journal = createInMemoryFlowJournal();
		const flow = makeFlow(spec)
			.add(
				makeStep({
					id: 'acuity/submit',
					needs: [],
					provides: ['confirmation'],
					idempotency: 'effectful-once',
					run: () => Effect.fail(new StepFailure('browser died mid-submit')),
				}),
			)
			.build(identity);

		const exit = await Effect.runPromiseExit(
			runFlow(flow, {}, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		const rows = await Effect.runPromise(journal.read('op-1'));
		const submitRows = rows.filter((r) => r.stepId === 'acuity/submit');
		expect(submitRows.some((r) => r.status === 'started')).toBe(true);
		expect(submitRows.some((r) => r.status === 'completed')).toBe(false);
	});

	it('compensates succeeded steps in reverse order of success on failure', async () => {
		const journal = createInMemoryFlowJournal();
		const compensated: string[] = [];
		const flow = makeFlow(spec)
			.add(
				makeStep({
					id: 'a',
					needs: [],
					provides: ['navResult'],
					run: () => Effect.succeed({ state: { navResult: 'a-out' } }),
					compensate: (output) =>
						Effect.sync(() => {
							compensated.push(`a:${output.navResult}`);
						}),
				}),
			)
			.add(
				makeStep({
					id: 'b',
					needs: [],
					provides: ['formResult'],
					run: () => Effect.succeed({ state: { formResult: 'b-out' } }),
					compensate: (output) =>
						Effect.sync(() => {
							compensated.push(`b:${output.formResult}`);
						}),
				}),
			)
			.add(
				makeStep({
					id: 'c',
					needs: [],
					provides: ['confirmation'],
					run: () => Effect.fail(new StepFailure('late failure')),
				}),
			)
			.build(identity);

		const exit = await Effect.runPromiseExit(
			runFlow(flow, {}, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		expect(failureOf(exit)).toBeInstanceOf(StepFailure);
		expect(compensated).toEqual(['b:b-out', 'a:a-out']);
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.filter((r) => r.status === 'compensated').map((r) => r.stepId)).toEqual(['b', 'a']);
	});

	it('tolerates journal append failures (evidence-only: a failed checkpoint never fails the flow)', async () => {
		const deadJournal: FlowJournalShape = {
			append: () => Effect.fail(new JournalError({ message: 'redis down' })),
			read: () => Effect.succeed([]),
		};
		const flow = makeFlow(spec)
			.add(
				makeStep({
					id: 'a',
					needs: [],
					provides: ['navResult'],
					run: () => Effect.succeed({ state: { navResult: 'ok' } }),
				}),
			)
			.build(identity);

		const outcome = await Effect.runPromise(
			runFlow(flow, {}, options).pipe(Effect.provideService(FlowJournal, deadJournal)),
		);
		expect(outcome.landed).toBe('intended-terminal');
		expect(outcome.output.navResult).toBe('ok');
	});

	it('accumulates the confidence floor from fuzzy resolutions and journals them', async () => {
		const journal = createInMemoryFlowJournal();
		const resolution = (confidence: number) => ({
			value: 'svc',
			confidence,
			strategy: 'token-overlap' as const,
			matchedLabel: 'Deep Tissue Massage',
			threshold: 0.3,
			alternates: [],
		});
		const flow = makeFlow(spec)
			.add(
				makeStep({
					id: 'a',
					needs: [],
					provides: ['navResult'],
					run: () =>
						Effect.succeed({ state: { navResult: 'ok' }, resolutions: [resolution(0.95)] }),
				}),
			)
			.add(
				makeStep({
					id: 'b',
					needs: [],
					provides: ['formResult'],
					run: () =>
						Effect.succeed({ state: { formResult: 'ok' }, resolutions: [resolution(0.7)] }),
				}),
			)
			.build(identity);

		const outcome = await Effect.runPromise(
			runFlow(flow, {}, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		expect(outcome.confidenceFloor).toBe(0.7);
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.find((r) => r.stepId === 'a' && r.status === 'completed')?.resolutions?.[0]?.confidence).toBe(0.95);
	});

	it('journals minted idempotency tokens and re-attaches them on re-entry', async () => {
		const journal = createInMemoryFlowJournal();
		let runs = 0;
		const flow = makeFlow(spec)
			.add(
				makeStep({
					id: 'payment/apply-coupon',
					needs: [],
					provides: ['navResult'],
					expects: ['acuity:payment'],
					run: () =>
						Effect.sync(() => {
							runs += 1;
							return {
								state: { navResult: 'ok' },
								idempotencyToken: 'ALT-COUPON-1',
								observed:
									runs === 1
										? observation('acuity:service-selection', ['acuity:payment'])
										: observation('acuity:payment', ['acuity:payment']),
							};
						}),
				}),
			)
			.recover('payment/apply-coupon', { to: 'payment/apply-coupon', maxReentries: 1 })
			.build(identity);

		await Effect.runPromise(
			runFlow(flow, {}, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		const rows = await Effect.runPromise(journal.read('op-1'));
		// First started row: no token minted yet; re-entry started row reuses the journaled token.
		expect(rows[0].status).toBe('started');
		expect(rows[0].idempotencyToken).toBeUndefined();
		expect(rows[2].status).toBe('started');
		expect(rows[2].idempotencyToken).toBe('ALT-COUPON-1');
		expect(rows[3].idempotencyToken).toBe('ALT-COUPON-1');
	});

	it('provides the session layer once per segment Scope region', async () => {
		class TestSession extends Context.Tag('flow-test/Session')<TestSession, { readonly id: number }>() {}
		const journal = createInMemoryFlowJournal();
		let builds = 0;
		const seen: Record<string, number> = {};
		const sessionStep = (id: string, provides: 'navResult' | 'formResult' | 'confirmation', segment: string) =>
			makeStep({
				id,
				needs: [],
				provides: [provides],
				segment,
				run: () =>
					Effect.gen(function* () {
						const session = yield* TestSession;
						seen[id] = session.id;
						return { state: { [provides]: 'ok' } as never };
					}),
			});
		const flow = makeFlow(spec)
			.add(sessionStep('a1', 'navResult', 'seg-a'))
			.add(sessionStep('a2', 'formResult', 'seg-a'))
			.add(sessionStep('b1', 'confirmation', 'seg-b'))
			.build(identity);

		const outcome = await Effect.runPromise(
			runFlow(flow, {}, {
				operationId: 'op-1',
				sessionLayer: () =>
					Layer.sync(TestSession, () => {
						builds += 1;
						return { id: builds };
					}),
			}).pipe(Effect.provideService(FlowJournal, journal)),
		);
		expect(outcome.landed).toBe('intended-terminal');
		expect(builds).toBe(2);
		expect(seen.a1).toBe(seen.a2);
		expect(seen.b1).not.toBe(seen.a1);
	});
});
