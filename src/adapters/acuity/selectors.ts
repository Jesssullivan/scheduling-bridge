/**
 * Acuity CSS Selector Registry — re-export facade.
 *
 * The implementation was physically extracted into standalone modules behind the
 * VendorFlowPack (design §7 / §10-0.7.0; TIN-2094, Lane B):
 *   - selector-registry.ts — vendor-neutral selector DATA + resolution machinery
 *   - selector-profile.ts  — per-tenant selector DATA, keyed by selectorProfile
 *
 * This module stays as a stable import path for existing consumers (steps,
 * wizard, service-resolver, selector-health, the pack). The effective
 * `Selectors` table is the vendor-neutral base merged with the default selector
 * profile, so behavior is byte-identical to the pre-extraction const and the
 * trace-conformance harness is unaffected.
 *
 * When Acuity changes their DOM, fix the vendor-neutral chains in
 * selector-registry.ts. When a tenant edits their intake form, fix that tenant's
 * profile in selector-profile.ts.
 */

export {
	BaseSelectors,
	Selectors,
	buildSelectors,
	resolveSelector,
	resolve,
	probeSelector,
	probe,
	healthCheck,
	type SelectorKey,
	type SelectorTable,
	type ResolvedSelector,
} from './selector-registry.js';
