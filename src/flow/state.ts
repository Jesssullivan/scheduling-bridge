/**
 * Flow state primitives (design: docs/design/flow-dag-formalization.md §4).
 *
 * Durable flow state: plain-data, JSON-encodable schemas ONLY. Volatile handles (Page,
 * ElementHandle) live in R (Context services), never in state. This is a convention with
 * layered enforcement, NOT a structural impossibility — `Schema.declare`/`Schema.Any` can wrap
 * arbitrary runtime values (an ElementHandle included). Fences: (a) `JsonEncodableSpec` rejects
 * schemas whose Encoded side is not `JsonValue`; (b) the state-schema conformance test helper
 * (`state-conformance.ts`); (c) the source-fence conformance test banning `Schema.declare` /
 * `Schema.Any` in flow-state positions (this repo has no ESLint infrastructure, so the lint
 * ban from the design ships as a source-scanning test instead).
 */

import type { Schema } from 'effect';

/** A JSON-serializable value: the only shape durable flow state may take on the wire. */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

/** A flow's state vocabulary: named keys, each described by an effect Schema. */
export interface FlowStateSpec {
	readonly [key: string]: Schema.Schema<any, any, never>;
}

/**
 * Type-level fence (a): maps any key whose Encoded side is not `JsonValue` to `never`,
 * so `makeFlow(spec)` rejects specs containing volatile-handle schemas at compile time.
 */
export type JsonEncodableSpec<Spec extends FlowStateSpec> = {
	readonly [K in keyof Spec]: Schema.Schema.Encoded<Spec[K]> extends JsonValue ? Spec[K] : never;
};

/** The decoded (Type-side) state record described by a spec. */
export type StateOf<Spec extends FlowStateSpec> = {
	readonly [K in keyof Spec]: Schema.Schema.Type<Spec[K]>;
};
