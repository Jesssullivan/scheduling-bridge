/**
 * Station vocabulary — vendor-namespaced landing observations (fuzzy-out).
 * Design: docs/design/flow-dag-formalization.md §4 (station.ts).
 */

/** Backends the bridge can drive (kit instance-model enum subset). */
export type BridgeBackend = 'acuity' | 'calcom' | 'glossgenius' | 'vagaro';

/** Vendor-namespaced landing identifier, e.g. 'acuity:client-form'. */
export type StationId = `${BridgeBackend}:${string}`;

/** A single probe contributing to a landing observation. */
export interface StationEvidence {
	readonly kind: 'selector' | 'url' | 'text';
	/** SelectorRegistry key or url-pattern id. */
	readonly key: string;
	readonly matched: boolean;
}

/** Where the flow actually landed versus where it intended to land. */
export interface LandingObservation {
	/** From StepMeta.expects. */
	readonly expected: readonly StationId[];
	readonly observed: StationId | 'unknown';
	/** 0..1 detector confidence. */
	readonly confidence: number;
	readonly evidence: readonly StationEvidence[];
}

/** Classification of an observation against a step's expectations. */
export type LandingOutcome =
	| { readonly _tag: 'OnTrack'; readonly landing: StationId }
	| {
			readonly _tag: 'Recoverable';
			readonly landing: StationId;
			/** Must name a declared RecoveryEdge.to (see plan.ts). */
			readonly rerouteTo: string;
	  }
	| { readonly _tag: 'Diverged'; readonly observation: LandingObservation };
