/**
 * Flow + FlowBuilder — the single front door for flow authoring.
 * Design: docs/design/flow-dag-formalization.md §4 (flow.ts).
 *
 * `.add(step)` compiles ONLY if step.meta.needs ⊆ Provided ∪ initial keys; the same
 * constraint, forward-edge acyclicity (dependsOn derived from needs/provides), and
 * segment contiguity are re-validated at RUNTIME at construction (`validateFlowPlan`).
 * `.recover(...)` records explicitly marked recovery edges that MAY point backward, each
 * with a journaled re-entry budget (maxReentries, default 1); recovery edges are excluded
 * from the acyclicity check. There is NO JSON/IR authoring path; plans are output, never
 * input. The type-level `Provided` accumulator is deliberately shallow (design risk 8) —
 * runtime validation is the backstop.
 */

import type { FlowStateSpec, JsonEncodableSpec } from './state.js';
import type { FlowStep } from './step.js';
import {
	computePlanHash,
	validateFlowPlan,
	type FlowPlan,
	type FlowPlanNode,
	type RecoveryEdge,
} from './plan.js';
import type { BridgeBackend } from './station.js';

export interface Flow<Spec extends FlowStateSpec, E, R> {
	/** Derived, frozen. */
	readonly plan: FlowPlan;
	readonly planHash: string;
	readonly steps: ReadonlyMap<string, FlowStep<Spec, any, any, E, R>>;
	/** State keys supplied as initial input to runFlow (not provided by any step). */
	readonly initialKeys: readonly (keyof Spec & string)[];
	/** The state vocabulary, retained for state-schema conformance and stateDelta encoding. */
	readonly spec: Spec;
}

export interface FlowIdentity {
	readonly flowId: string;
	readonly backend: BridgeBackend;
	/** semver of the flow shape */
	readonly version: string;
}

/** Thrown at construction when runtime validation rejects the flow shape. */
export class FlowValidationError extends Error {
	override readonly name = 'FlowValidationError';
	constructor(readonly violations: readonly string[]) {
		super(`flow validation failed:\n- ${violations.join('\n- ')}`);
	}
}

export interface FlowBuilder<
	Spec extends FlowStateSpec,
	Provided extends keyof Spec & string,
	E,
	R,
> {
	/** Compiles only when the step's Needs are a subset of Provided-so-far ∪ initial keys. */
	readonly add: <
		N extends Provided,
		P extends keyof Spec & string,
		E2,
		R2,
	>(
		step: FlowStep<Spec, N, P, E2, R2>,
	) => FlowBuilder<Spec, Provided | P, E | E2, R | R2>;
	/** Records a recovery edge from `fromStepId`; may point backward; maxReentries default 1. */
	readonly recover: (
		fromStepId: string,
		edge: { readonly to: string; readonly maxReentries?: number },
	) => FlowBuilder<Spec, Provided, E, R>;
	/** Derives the FlowPlan projection, validates it, and freezes the Flow. */
	readonly build: (identity: FlowIdentity) => Flow<Spec, E, R>;
}

interface BuilderState<Spec extends FlowStateSpec> {
	readonly spec: Spec;
	readonly initialKeys: readonly (keyof Spec & string)[];
	readonly steps: readonly FlowStep<Spec, any, any, any, any>[];
	readonly recoveries: readonly { readonly from: string; readonly edge: RecoveryEdge }[];
}

const deriveNodes = <Spec extends FlowStateSpec>(state: BuilderState<Spec>): FlowPlanNode[] =>
	state.steps.map((step, index) => {
		const needs = step.meta.needs as readonly string[];
		// Forward edges: prior nodes providing my needs, deduped, in node order.
		const dependsOn = state.steps
			.slice(0, index)
			.filter((prior) =>
				(prior.meta.provides as readonly string[]).some((key) => needs.includes(key)),
			)
			.map((prior) => prior.meta.id);
		const recoveries = state.recoveries
			.filter((entry) => entry.from === step.meta.id)
			.map((entry) => entry.edge);
		return {
			stepId: step.meta.id,
			needs: [...needs],
			provides: [...(step.meta.provides as readonly string[])],
			dependsOn,
			...(recoveries.length > 0 ? { recoveries } : {}),
			expects: [...step.meta.expects],
			idempotency: step.meta.idempotency,
			segment: step.meta.segment,
			tags: [...step.meta.tags],
		};
	});

const makeBuilder = <
	Spec extends FlowStateSpec,
	Provided extends keyof Spec & string,
	E,
	R,
>(
	state: BuilderState<Spec>,
): FlowBuilder<Spec, Provided, E, R> => ({
	add: (step) =>
		makeBuilder({ ...state, steps: [...state.steps, step as FlowStep<Spec, any, any, any, any>] }),
	recover: (fromStepId, edge) =>
		makeBuilder({
			...state,
			recoveries: [
				...state.recoveries,
				{ from: fromStepId, edge: { to: edge.to, maxReentries: edge.maxReentries ?? 1 } },
			],
		}),
	build: (identity) => {
		const knownIds = new Set(state.steps.map((step) => step.meta.id));
		const orphanRecoveries = state.recoveries
			.filter((entry) => !knownIds.has(entry.from))
			.map((entry) => `recovery edge declared from unknown step '${entry.from}'`);

		const plan: FlowPlan = Object.freeze({
			flowId: identity.flowId,
			backend: identity.backend,
			version: identity.version,
			nodes: Object.freeze(deriveNodes(state)) as readonly FlowPlanNode[],
		});

		const violations = [
			...orphanRecoveries,
			...validateFlowPlan(plan, state.initialKeys as readonly string[]),
		];
		if (violations.length > 0) throw new FlowValidationError(violations);

		return {
			plan,
			planHash: computePlanHash(plan),
			steps: new Map(state.steps.map((step) => [step.meta.id, step])) as ReadonlyMap<
				string,
				FlowStep<Spec, any, any, E, R>
			>,
			initialKeys: state.initialKeys,
			spec: state.spec,
		};
	},
});

/**
 * Entry point. `initial` declares the state keys supplied to runFlow as input (seeding the
 * type-level Provided accumulator); omitted, the accumulator starts at `never` exactly as in
 * the design signature.
 */
export const makeFlow = <
	Spec extends FlowStateSpec,
	const Initial extends keyof Spec & string = never,
>(
	spec: Spec & JsonEncodableSpec<Spec>,
	initial?: readonly Initial[],
): FlowBuilder<Spec, Initial, never, never> =>
	makeBuilder<Spec, Initial, never, never>({
		spec,
		initialKeys: initial ?? [],
		steps: [],
		recoveries: [],
	});
