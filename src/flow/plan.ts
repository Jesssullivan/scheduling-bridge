/**
 * FlowPlan — the serializable projection (derived from the builder, never authored).
 * Design: docs/design/flow-dag-formalization.md §4 (plan.ts).
 *
 * planHash = sha256 of the canonical JSON of the plan (stable key ordering, explicit
 * canonicalization, node:crypto — zero new dependencies). Pinned into the job record at
 * enqueue (additive `planHash?`/`flowVersion?` fields on BridgeJobRecord, a later lane).
 */

import { createHash } from 'node:crypto';
import type { IdempotencyClass, StepTag } from './step.js';
import type { BridgeBackend, StationId } from './station.js';

export interface RecoveryEdge {
	/** Target stepId; MAY point backward (re-entry). */
	readonly to: string;
	/** Journaled re-entry budget; default 1. */
	readonly maxReentries: number;
}

export interface FlowPlanNode {
	readonly stepId: string;
	readonly needs: readonly string[];
	readonly provides: readonly string[];
	/** Forward edges (nodes providing my needs): acyclic. */
	readonly dependsOn: readonly string[];
	/** Recovery edges: may point backward, budgeted; excluded from the acyclicity check. */
	readonly recoveries?: readonly RecoveryEdge[];
	readonly expects: readonly StationId[];
	readonly idempotency: IdempotencyClass;
	readonly segment: string;
	readonly tags: readonly StepTag[];
}

export interface FlowPlan {
	/** 'booking_create_with_payment', ... */
	readonly flowId: string;
	readonly backend: BridgeBackend;
	/** semver of the flow shape */
	readonly version: string;
	/** Topologically ordered by forward edges. */
	readonly nodes: readonly FlowPlanNode[];
}

// =============================================================================
// CANONICAL JSON + planHash
// =============================================================================

const canonicalize = (value: unknown, path: string): string => {
	if (value === null) return 'null';
	switch (typeof value) {
		case 'string':
			return JSON.stringify(value);
		case 'boolean':
			return value ? 'true' : 'false';
		case 'number':
			if (!Number.isFinite(value)) {
				throw new TypeError(`canonicalJson: non-finite number at ${path}`);
			}
			return JSON.stringify(value);
		case 'object': {
			if (Array.isArray(value)) {
				return `[${value.map((item, i) => canonicalize(item, `${path}[${i}]`)).join(',')}]`;
			}
			const entries = Object.entries(value as Record<string, unknown>)
				.filter(([, v]) => v !== undefined)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v, `${path}.${k}`)}`);
			return `{${entries.join(',')}}`;
		}
		default:
			throw new TypeError(`canonicalJson: non-JSON value of type ${typeof value} at ${path}`);
	}
};

/** Deterministic JSON: object keys sorted recursively, undefined properties dropped. */
export const canonicalJson = (value: unknown): string => canonicalize(value, '$');

/** sha256 hex digest of the plan's canonical JSON; key-order independent by construction. */
export const computePlanHash = (plan: FlowPlan): string =>
	createHash('sha256').update(canonicalJson(plan), 'utf8').digest('hex');

// =============================================================================
// RUNTIME PLAN VALIDATION (the backstop behind the type-level accumulator)
// =============================================================================

/**
 * Re-validates at construction what the builder's type-level `Provided` accumulator enforces
 * at compile time, plus the structural invariants of the plan itself. Returns a list of
 * human-readable violations (empty = valid). Exposed standalone so conformance tests can
 * exercise rejection paths the builder cannot produce by construction.
 */
export const validateFlowPlan = (
	plan: FlowPlan,
	initialKeys: readonly string[],
): readonly string[] => {
	const violations: string[] = [];
	const ids = new Set<string>();

	for (const node of plan.nodes) {
		if (ids.has(node.stepId)) violations.push(`duplicate stepId '${node.stepId}'`);
		ids.add(node.stepId);
	}

	// Needs subset: each node's needs must be provided by the initial keys or a PRIOR node.
	const provided = new Set<string>(initialKeys);
	for (const node of plan.nodes) {
		for (const need of node.needs) {
			if (!provided.has(need)) {
				violations.push(
					`step '${node.stepId}' needs '${need}' which is not provided by initial keys or any prior step`,
				);
			}
		}
		for (const key of node.provides) provided.add(key);
	}

	// Forward-edge acyclicity over dependsOn (Kahn's algorithm).
	const indegree = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const node of plan.nodes) {
		indegree.set(node.stepId, node.dependsOn.length);
		for (const dep of node.dependsOn) {
			if (!ids.has(dep)) {
				violations.push(`step '${node.stepId}' dependsOn unknown step '${dep}'`);
				continue;
			}
			dependents.set(dep, [...(dependents.get(dep) ?? []), node.stepId]);
		}
	}
	const queue = plan.nodes.map((n) => n.stepId).filter((id) => (indegree.get(id) ?? 0) === 0);
	let visited = 0;
	while (queue.length > 0) {
		const id = queue.shift() as string;
		visited += 1;
		for (const dependent of dependents.get(id) ?? []) {
			const next = (indegree.get(dependent) ?? 0) - 1;
			indegree.set(dependent, next);
			if (next === 0) queue.push(dependent);
		}
	}
	if (visited < plan.nodes.length) {
		const cyclic = plan.nodes
			.map((n) => n.stepId)
			.filter((id) => (indegree.get(id) ?? 0) > 0);
		violations.push(`forward-edge cycle detected among steps [${cyclic.join(', ')}]`);
	}

	// Segment contiguity: a segment is one contiguous run of nodes (one Scope region each).
	const seenSegments = new Set<string>();
	let currentSegment: string | undefined;
	for (const node of plan.nodes) {
		if (node.segment !== currentSegment) {
			if (seenSegments.has(node.segment)) {
				violations.push(
					`segment '${node.segment}' is not contiguous (re-entered at step '${node.stepId}')`,
				);
			}
			seenSegments.add(node.segment);
			currentSegment = node.segment;
		}
	}

	// Recovery edges: targets must exist and be unique per node (budgets are keyed by
	// from=>to, so a duplicate target would alias one budget); budgets must be positive.
	for (const node of plan.nodes) {
		const targets = new Set<string>();
		for (const edge of node.recoveries ?? []) {
			if (targets.has(edge.to)) {
				violations.push(`step '${node.stepId}' declares duplicate recovery edge to '${edge.to}'`);
			}
			targets.add(edge.to);
			if (!ids.has(edge.to)) {
				violations.push(`step '${node.stepId}' declares recovery edge to unknown step '${edge.to}'`);
			}
			if (!Number.isInteger(edge.maxReentries) || edge.maxReentries < 1) {
				violations.push(
					`step '${node.stepId}' recovery edge to '${edge.to}' has invalid maxReentries ${edge.maxReentries}`,
				);
			}
		}
	}

	return violations;
};
