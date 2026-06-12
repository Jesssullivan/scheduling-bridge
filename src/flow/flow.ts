/**
 * Flow + FlowBuilder — the single front door for flow authoring.
 * Design: docs/design/flow-dag-formalization.md §4 (flow.ts).
 *
 * `.add(step)` compiles ONLY if step.meta.needs ⊆ Provided ∪ initial keys; the same
 * constraint, forward-edge acyclicity (dependsOn derived from needs/provides), and
 * segment contiguity are re-validated at RUNTIME at construction (`validateFlowPlan`).
 * `.recover(fromStepId, on, edges)` records explicitly marked recovery edges that MAY point
 * backward, each with a journaled re-entry budget (maxReentries, default 1), TOGETHER with
 * the typed chooser `on: (state, observed) => stepId | undefined` that decides which declared
 * edge (if any) a known-but-unexpected landing reroutes to — branch targets are data (hashed
 * into the plan); choosers are typed code (never plan data, never hashed; design §5 step 3 and
 * recorded tradeoff 1). Recovery edges are excluded from the acyclicity check. There is NO
 * JSON/IR authoring path; plans are output, never input. The type-level `Provided`
 * accumulator is deliberately shallow (design risk 8) — runtime validation is the backstop.
 */

import type { FlowStateSpec, JsonEncodableSpec, StateOf } from './state.js';
import type { FlowStep } from './step.js';
import {
	computePlanHash,
	validateFlowPlan,
	type FlowPlan,
	type FlowPlanNode,
	type RecoveryEdge,
} from './plan.js';
import type { BridgeBackend, StationId } from './station.js';

/**
 * Typed recovery chooser (design §4 flow.ts; §5 step 3: "targets are data; choosers are
 * typed code"). Invoked when a step lands on a known-but-unexpected station: given the
 * accumulated state and the observed landing, returns the stepId of one of that step's
 * DECLARED recovery edges to re-enter, or undefined to decline. Declining — or naming an
 * undeclared or budget-exhausted target — escalates to Diverged; the chooser is what keeps
 * true divergences from being masked into reroutes.
 */
export type RecoveryChooser<Spec extends FlowStateSpec> = (
	state: Readonly<Partial<StateOf<Spec>>>,
	observed: StationId,
) => string | undefined;

export interface Flow<Spec extends FlowStateSpec, E, R> {
	/** Derived, frozen. */
	readonly plan: FlowPlan;
	readonly planHash: string;
	readonly steps: ReadonlyMap<string, FlowStep<Spec, any, any, E, R>>;
	/** Per-step recovery choosers keyed by fromStepId. Typed code — never plan data, never hashed. */
	readonly choosers: ReadonlyMap<string, RecoveryChooser<Spec>>;
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
	/**
	 * Records budgeted recovery edges from `fromStepId` (edges may point backward;
	 * maxReentries default 1) together with the typed chooser that decides which declared
	 * edge an observed known-but-unexpected landing reroutes to. One declaration per step.
	 */
	readonly recover: (
		fromStepId: string,
		on: RecoveryChooser<Spec>,
		edges: readonly { readonly to: string; readonly maxReentries?: number }[],
	) => FlowBuilder<Spec, Provided, E, R>;
	/** Derives the FlowPlan projection, validates it, and freezes the Flow. */
	readonly build: (identity: FlowIdentity) => Flow<Spec, E, R>;
}

interface BuilderState<Spec extends FlowStateSpec> {
	readonly spec: Spec;
	readonly initialKeys: readonly (keyof Spec & string)[];
	readonly steps: readonly FlowStep<Spec, any, any, any, any>[];
	readonly recoveries: readonly {
		readonly from: string;
		readonly on: RecoveryChooser<Spec>;
		readonly edges: readonly RecoveryEdge[];
	}[];
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
		const recoveries =
			state.recoveries.find((entry) => entry.from === step.meta.id)?.edges ?? [];
		return {
			stepId: step.meta.id,
			needs: [...needs],
			provides: [...(step.meta.provides as readonly string[])],
			dependsOn,
			...(recoveries.length > 0 ? { recoveries: [...recoveries] } : {}),
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
	recover: (fromStepId, on, edges) =>
		makeBuilder({
			...state,
			recoveries: [
				...state.recoveries,
				{
					from: fromStepId,
					on,
					edges: edges.map((edge) => ({ to: edge.to, maxReentries: edge.maxReentries ?? 1 })),
				},
			],
		}),
	build: (identity) => {
		const knownIds = new Set(state.steps.map((step) => step.meta.id));
		const declarationViolations: string[] = [];
		const declaredFrom = new Set<string>();
		for (const entry of state.recoveries) {
			if (!knownIds.has(entry.from)) {
				declarationViolations.push(`recovery edge declared from unknown step '${entry.from}'`);
			}
			if (declaredFrom.has(entry.from)) {
				declarationViolations.push(
					`duplicate recovery declaration for step '${entry.from}' (one chooser per step)`,
				);
			}
			declaredFrom.add(entry.from);
			if (entry.edges.length === 0) {
				declarationViolations.push(`recovery declaration for step '${entry.from}' has no edges`);
			}
		}

		const plan: FlowPlan = Object.freeze({
			flowId: identity.flowId,
			backend: identity.backend,
			version: identity.version,
			nodes: Object.freeze(deriveNodes(state)) as readonly FlowPlanNode[],
		});

		const violations = [
			...declarationViolations,
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
			choosers: new Map(state.recoveries.map((entry) => [entry.from, entry.on])),
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
