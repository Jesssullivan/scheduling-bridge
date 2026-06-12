/**
 * FlowOutcome — whole-flow fuzzy-out.
 * Design: docs/design/flow-dag-formalization.md §4 (outcome.ts) and §6.
 */

export interface FlowOutcome<O> {
	readonly output: O;
	readonly landed: 'intended-terminal' | 'alternate-terminal' | 'compensated';
	readonly terminalStepId: string;
	/** Min accepted fuzzy-in confidence on the executed path. */
	readonly confidenceFloor: number;
}
