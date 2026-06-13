/**
 * Acuity selector PROFILES — per-tenant selector DATA, keyed by
 * `BridgeAdapterProfile.selectorProfile` (src/async/types.ts:32).
 *
 * Design: docs/design/flow-dag-formalization.md §7 (de-tenanting, 0.7.0) and
 * §11 (test pins move to a named-profile fixture). TIN-2094 (Lane B).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Generic selector code (selector-registry.ts) must reference ZERO tenant
 * specifics — no Acuity custom-field ids, no tenant intake-form option names.
 * Those are not vendor (Acuity) facts; they are facts about a *single
 * practitioner's* intake form, which the practitioner can edit at any time.
 * They therefore live here as DATA, isolated per profile, and are merged onto
 * the vendor-neutral base registry only when a profile is selected.
 *
 * ACCOUNT REALITY (recon brief item 7)
 * ------------------------------------
 * There is no fresh/dev Acuity account provisioned (no `.env.example`, CI
 * carries no Acuity secrets, the only live host is the tenant's). §11's "fresh
 * dev account replaces the massageithaca pins" is therefore aspirational/unmet.
 * Per the lane's structural-de-tenanting fallback, the tenant values are kept
 * inside a clearly-named `massageithaca` profile so that:
 *   - generic code is clean (the reviewer can grep selector-registry.ts and
 *     every other "generic" module and find no tenant specifics), and
 *   - the tenant data is isolated in this one profile file.
 * When a dev account is provisioned, its values replace the `massageithaca`
 * profile body (or a new named profile is added) with no change to generic code.
 *
 * TRACE-NEUTRALITY
 * ----------------
 * The default selector profile resolved when `selectorProfile` is unset is the
 * `massageithaca` profile (the only deployment today, per recon). This keeps
 * the effective selector resolution byte-identical to the pre-extraction
 * `Selectors` const, so the 0.6.x trace-conformance harness is unaffected.
 */

import type { SelectorKey } from './selector-registry.js';

/**
 * A selector profile contributes per-tenant fallback chains for a subset of
 * selector keys (the intake-form fields a practitioner can customize). Keys not
 * present here fall through to the vendor-neutral base registry.
 */
export interface SelectorProfile {
	/** Stable profile id, equal to `BridgeAdapterProfile.selectorProfile`. */
	readonly name: string;
	/**
	 * Per-key fallback-chain overrides. Only the tenant-customizable intake keys
	 * appear here; generic structural keys stay in the base registry.
	 */
	readonly selectors: Partial<Record<SelectorKey, readonly string[]>>;
	/**
	 * Tenant-form field id excluded from the generic "how did you hear" fallback
	 * (the terms-agreement custom field that must never be auto-checked as the
	 * referral answer). Generalized out of the hardcoded `field-13933959` that
	 * used to live in fill-form.ts. When set, the fallback excludes
	 * `[name*="<excludeFallbackFieldId>"]`; when unset, no field is excluded.
	 */
	readonly excludeFallbackFieldId?: string;
	/**
	 * Default "how did you hear" intake option name to select when the caller
	 * does not supply one. This is a tenant intake-form OPTION name (the values a
	 * practitioner configures), so it is profile DATA, not a constant in generic
	 * code. When unset, the caller's value is used as-is and no tenant default is
	 * injected.
	 */
	readonly defaultHowDidYouHear?: string;
}

/**
 * Vendor-neutral default profile: no tenant intake-field selectors, no excluded
 * fallback field. Selecting this profile yields a registry with the tenant keys
 * resolving to empty chains — the honest vendor-neutral baseline a brand-new
 * Acuity account starts from before its intake form is known.
 */
export const NEUTRAL_SELECTOR_PROFILE: SelectorProfile = {
	name: 'neutral',
	selectors: {},
};

/**
 * The MassageIthaca tenant profile. Carries EVERY MassageIthaca-specific
 * selector entry that previously leaked into the generic registry:
 *   - termsCheckbox            (custom field-13933959)
 *   - medicationField          (custom field-16606770)
 *   - howDidYouHearCheckbox    (the tenant intake "Internet search" option;
 *                               sibling options include "google maps" and the
 *                               "referral from Noha Acupuncture" option)
 *   - excludeFallbackFieldId   (field-13933959, the terms field the referral
 *                               fallback must skip)
 *
 * These values are byte-identical to the pre-extraction `Selectors` const so the
 * trace-conformance harness sees no change when this profile is active.
 */
export const MASSAGE_ITHACA_SELECTOR_PROFILE: SelectorProfile = {
	name: 'massageithaca',
	selectors: {
		// Terms agreement checkbox (tenant custom field-13933959)
		termsCheckbox: [
			'input[type="checkbox"][name*="field-13933959"]',
			'input[id*="13933959"]',
		],
		// "How did you hear" multi-checkbox (REQUIRED — at least 1 must be checked)
		// Tenant option names: "Internet search", "google maps",
		//   "referral from Noha Acupuncture", "referral from dentist",
		//   "referral from PT or other practitioner".
		howDidYouHearCheckbox: [
			'input[type="checkbox"][name="Internet search"]',
			'label:has(input[type="checkbox"][name="Internet search"])',
		],
		// Medication textarea (tenant custom field-16606770)
		medicationField: [
			'textarea[name="fields[field-16606770]"]',
			'#fields\\[field-16606770\\]',
		],
	},
	excludeFallbackFieldId: 'field-13933959',
	defaultHowDidYouHear: 'Internet search',
};

/** Registered profiles, keyed by name. */
const PROFILES: Readonly<Record<string, SelectorProfile>> = {
	[NEUTRAL_SELECTOR_PROFILE.name]: NEUTRAL_SELECTOR_PROFILE,
	[MASSAGE_ITHACA_SELECTOR_PROFILE.name]: MASSAGE_ITHACA_SELECTOR_PROFILE,
};

/**
 * The profile used when `selectorProfile` is unset. Today the only deployment is
 * the MassageIthaca tenant, so the default preserves existing behavior (and
 * trace-neutrality). A fresh-dev-account deployment sets
 * `ACUITY_SELECTOR_PROFILE=neutral` (or a new profile name) explicitly.
 */
export const DEFAULT_SELECTOR_PROFILE = MASSAGE_ITHACA_SELECTOR_PROFILE;

/**
 * Resolve a selector profile by name. Unknown names (and `undefined`) resolve to
 * the default profile — selecting selector data is never a throw surface, the
 * same posture the registry takes for unknown keys.
 */
export const resolveSelectorProfile = (name?: string): SelectorProfile =>
	(name !== undefined ? PROFILES[name] : undefined) ?? DEFAULT_SELECTOR_PROFILE;
