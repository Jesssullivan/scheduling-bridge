/**
 * runFlow — the single execution combinator (the fold).
 * Design: docs/design/flow-dag-formalization.md §5.
 *
 * Semantics: plan nodes are grouped by segment in topological order; each segment gets ONE
 * Scope region with the (parameterizable) session layer provided once. Per node: decode needs
 * from accumulated state, journal 'started', run with Effect.retry(meta.retry ?? Schedule.stop),
 * compare observed vs expects into a LandingOutcome, journal 'completed'/'failed'/'rerouted',
 * merge provides. Recoverable reroutes along a DECLARED recovery edge with a journaled,
 * decremented re-entry budget; exhaustion escalates to Diverged, which fails with the
 * observation attached. On failure, compensate handlers of succeeded steps run in REVERSE
 * order of success (outside segment scopes — vendor-side cleanup only). Journal append failure
 * is log-and-continue (evidence-only in 0.6.x). Termination: total step executions are bounded
 * by |nodes| x (1 + sum of maxReentries over recovery edges).
 */

import { Data, Effect, Schedule, type Layer, type Scope } from 'effect';
import type { FlowStateSpec, StateOf } from './state.js';
import type { Flow } from './flow.js';
import type { FlowPlanNode } from './plan.js';
import type { LandingObservation, LandingOutcome, StationId } from './station.js';
import { FlowJournal, type CheckpointStatus, type FlowCheckpoint } from './journal.js';
import type { FlowOutcome } from './outcome.js';
import type { StepOutcome } from './step.js';

export class FlowDivergedError extends Data.TaggedError('FlowDivergedError')<{
	readonly stepId: string;
	readonly observation: LandingObservation;
}> {}

export class FlowRunError extends Data.TaggedError('FlowRunError')<{
	readonly code: 'MISSING_NEED' | 'UNKNOWN_STEP' | 'TERMINATION_BOUND_EXCEEDED';
	readonly message: string;
}> {}

export interface RunFlowOptions<RS = never, ES = never, RIn = never> {
	/** = BridgeJobRecord.operationId; keys the journal rows. */
	readonly operationId: string;
	/** Session layer provided once per segment Scope region. The caller decides
	 * BrowserSessionLive vs another layer (e.g. Layer.empty for REST flows) — never hardcoded. */
	readonly sessionLayer: (segment: string) => Layer.Layer<RS, ES, RIn>;
}

type NodeResult = { readonly kind: 'advance' } | { readonly kind: 'reroute'; readonly to: number };

const errorCode = (error: unknown): string =>
	typeof error === 'object' && error !== null && '_tag' in error
		? String((error as { _tag: unknown })._tag)
		: 'UNKNOWN';

const errorMessage = (error: unknown): string =>
	typeof error === 'object' && error !== null && 'message' in error
		? String((error as { message: unknown }).message)
		: String(error);

export const runFlow = <Spec extends FlowStateSpec, E, R, RS = never, ES = never, RIn = never>(
	flow: Flow<Spec, E, R>,
	initial: Partial<StateOf<Spec>>,
	options: RunFlowOptions<RS, ES, RIn>,
): Effect.Effect<
	FlowOutcome<Partial<StateOf<Spec>>>,
	E | ES | FlowDivergedError | FlowRunError,
	FlowJournal | RIn | Exclude<R, RS | Scope.Scope>
> =>
	Effect.gen(function* () {
		const journal = yield* FlowJournal;
		const nodes = flow.plan.nodes;
		const indexOf = new Map(nodes.map((node, i) => [node.stepId, i]));

		// Contiguous segment runs in topological (plan) order; contiguity is build-validated.
		const segments: { segment: string; start: number; end: number }[] = [];
		for (let i = 0; i < nodes.length; i += 1) {
			const last = segments[segments.length - 1];
			if (last && last.segment === nodes[i].segment) last.end = i;
			else segments.push({ segment: nodes[i].segment, start: i, end: i });
		}

		// Re-entry budgets per declared recovery edge; their sum bounds the unrolling.
		const budgets = new Map<string, number>();
		let budgetSum = 0;
		for (const node of nodes) {
			for (const edge of node.recoveries ?? []) {
				budgets.set(`${node.stepId}=>${edge.to}`, edge.maxReentries);
				budgetSum += edge.maxReentries;
			}
		}
		const executionBound = nodes.length * (1 + budgetSum);

		const state: Record<string, unknown> = { ...(initial as Record<string, unknown>) };
		const attempts = new Map<string, number>();
		const tokens = new Map<string, string>();
		const succeeded: {
			readonly stepId: string;
			readonly output: Record<string, unknown>;
			readonly compensate?: (output: never) => Effect.Effect<void, never, unknown>;
		}[] = [];
		let executions = 0;
		let rerouted = false;
		let confidenceFloor = 1;

		// Evidence-only in 0.6.x: a failed checkpoint write never fails the flow.
		const checkpoint = (
			stepId: string,
			attempt: number,
			status: CheckpointStatus,
			extra: Partial<Omit<FlowCheckpoint, 'seq'>> = {},
		) =>
			journal
				.append({
					operationId: options.operationId,
					flowId: flow.plan.flowId,
					flowVersion: flow.plan.version,
					planHash: flow.planHash,
					stepId,
					attempt,
					status,
					at: new Date().toISOString(),
					...extra,
				})
				.pipe(
					Effect.catchAll((error) =>
						Effect.logWarning('flow journal append failed (evidence-only; continuing)', error),
					),
				);

		const classify = (node: FlowPlanNode, observed: LandingObservation | undefined): LandingOutcome => {
			if (!observed) {
				return { _tag: 'OnTrack', landing: node.expects[0] ?? (`${flow.plan.backend}:unknown` as StationId) };
			}
			if (observed.observed !== 'unknown' && node.expects.includes(observed.observed)) {
				return { _tag: 'OnTrack', landing: observed.observed };
			}
			if (observed.observed !== 'unknown') {
				for (const edge of node.recoveries ?? []) {
					if ((budgets.get(`${node.stepId}=>${edge.to}`) ?? 0) > 0) {
						return { _tag: 'Recoverable', landing: observed.observed, rerouteTo: edge.to };
					}
				}
			}
			return { _tag: 'Diverged', observation: observed };
		};

		const runNode = (index: number): Effect.Effect<NodeResult, unknown, unknown> =>
			Effect.gen(function* () {
				const node = nodes[index];
				const step = flow.steps.get(node.stepId);
				if (!step) {
					return yield* Effect.fail(
						new FlowRunError({ code: 'UNKNOWN_STEP', message: `no step registered for plan node '${node.stepId}'` }),
					);
				}
				executions += 1;
				if (executions > executionBound) {
					return yield* Effect.fail(
						new FlowRunError({
							code: 'TERMINATION_BOUND_EXCEEDED',
							message: `execution count exceeded bound ${executionBound} at step '${node.stepId}'`,
						}),
					);
				}
				const attempt = (attempts.get(node.stepId) ?? 0) + 1;
				attempts.set(node.stepId, attempt);

				for (const need of node.needs) {
					if (!(need in state)) {
						return yield* Effect.fail(
							new FlowRunError({ code: 'MISSING_NEED', message: `step '${node.stepId}' needs '${need}' which is absent from accumulated state` }),
						);
					}
				}
				const input = Object.fromEntries(node.needs.map((key) => [key, state[key]]));

				const knownToken = tokens.get(node.stepId);
				yield* checkpoint(node.stepId, attempt, 'started', knownToken ? { idempotencyToken: knownToken } : {});

				const outcome = (yield* Effect.retry(
					step.run(input as never) as Effect.Effect<unknown, unknown, unknown>,
					(step.meta.retry ?? Schedule.stop) as Schedule.Schedule<unknown, unknown>,
				).pipe(
					Effect.tapError((error) =>
						checkpoint(node.stepId, attempt, 'failed', {
							error: { code: errorCode(error), message: errorMessage(error), retryable: false },
						}),
					),
				)) as StepOutcome<Spec, keyof Spec & string>;

				for (const resolution of outcome.resolutions ?? []) {
					confidenceFloor = Math.min(confidenceFloor, resolution.confidence);
				}
				if (outcome.idempotencyToken !== undefined) tokens.set(node.stepId, outcome.idempotencyToken);

				const landing = classify(node, outcome.observed);
				if (landing._tag === 'Diverged') {
					yield* checkpoint(node.stepId, attempt, 'failed', {
						...(outcome.observed ? { landing: outcome.observed } : {}),
						error: {
							code: 'FLOW_DIVERGED',
							message: `step '${node.stepId}' landed on '${landing.observation.observed}', expected [${node.expects.join(', ')}]`,
							retryable: false,
						},
					});
					return yield* Effect.fail(new FlowDivergedError({ stepId: node.stepId, observation: landing.observation }));
				}
				if (landing._tag === 'Recoverable') {
					const key = `${node.stepId}=>${landing.rerouteTo}`;
					const remaining = (budgets.get(key) ?? 0) - 1;
					budgets.set(key, remaining);
					rerouted = true;
					yield* checkpoint(node.stepId, attempt, 'rerouted', {
						...(outcome.observed ? { landing: outcome.observed } : {}),
						reroute: { to: landing.rerouteTo, remaining },
					});
					return { kind: 'reroute', to: indexOf.get(landing.rerouteTo) as number } as NodeResult;
				}

				yield* checkpoint(node.stepId, attempt, 'completed', {
					...(outcome.observed ? { landing: outcome.observed } : {}),
					...(outcome.resolutions ? { resolutions: outcome.resolutions } : {}),
					...(outcome.idempotencyToken !== undefined ? { idempotencyToken: outcome.idempotencyToken } : {}),
				});
				Object.assign(state, outcome.state);
				succeeded.push({
					stepId: node.stepId,
					output: outcome.state as Record<string, unknown>,
					compensate: step.compensate as never,
				});
				return { kind: 'advance' } as NodeResult;
			});

		// One Scope region per segment (re-)entry; in-segment reroutes stay on the same session.
		const runSegment = (segIndex: number, startIndex: number): Effect.Effect<NodeResult, unknown, unknown> =>
			Effect.gen(function* () {
				const segment = segments[segIndex];
				let i = startIndex;
				while (i <= segment.end) {
					const result = yield* runNode(i);
					if (result.kind === 'reroute') {
						if (result.to >= segment.start && result.to <= segment.end) {
							i = result.to;
							continue;
						}
						return result;
					}
					i += 1;
				}
				return { kind: 'advance' } as NodeResult;
			});

		const execute = Effect.gen(function* () {
			let index = 0;
			while (index < nodes.length) {
				const segIndex = segments.findIndex((s) => index >= s.start && index <= s.end);
				const segment = segments[segIndex];
				const layer = options.sessionLayer(segment.segment);
				const result = (yield* Effect.scoped(
					Effect.provide(runSegment(segIndex, index), layer as Layer.Layer<unknown, unknown, unknown>),
				)) as NodeResult;
				index = result.kind === 'reroute' ? result.to : segment.end + 1;
			}
		});

		yield* execute.pipe(
			Effect.catchAll((error) =>
				Effect.gen(function* () {
					for (const entry of [...succeeded].reverse()) {
						if (!entry.compensate) continue;
						yield* (entry.compensate(entry.output as never) as Effect.Effect<void, never, never>).pipe(
							Effect.catchAllCause((cause) => Effect.logWarning('flow compensation failed', cause)),
						);
						yield* checkpoint(entry.stepId, attempts.get(entry.stepId) ?? 1, 'compensated');
					}
					return yield* Effect.fail(error);
				}),
			),
		);

		const outcome: FlowOutcome<Partial<StateOf<Spec>>> = {
			output: { ...state } as Partial<StateOf<Spec>>,
			landed: rerouted ? 'alternate-terminal' : 'intended-terminal',
			terminalStepId: nodes[nodes.length - 1]?.stepId ?? '',
			confidenceFloor,
		};
		return outcome;
	}) as unknown as Effect.Effect<
		FlowOutcome<Partial<StateOf<Spec>>>,
		E | ES | FlowDivergedError | FlowRunError,
		FlowJournal | RIn | Exclude<R, RS | Scope.Scope>
	>;
