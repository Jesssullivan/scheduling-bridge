/**
 * Selector de-tenanting + physical-extraction conformance (design §7 / §10-0.7.0;
 * TIN-2094, Lane B).
 *
 * Two guarantees:
 *  1. The GENERIC selector registry (vendor-neutral base) contains ZERO tenant
 *     specifics — no Acuity custom-field ids, no tenant intake option names. The
 *     tenant-customizable keys resolve to empty chains in the base.
 *  2. Selecting the `massageithaca` profile reproduces the PRIOR selector
 *     resolution byte-for-byte (trace-neutrality): the effective table for the
 *     MI profile equals the historical pre-extraction values, and the default
 *     profile (selectorProfile unset) is the MI profile.
 */

import { describe, it, expect } from 'vitest';
import {
	BaseSelectors,
	Selectors,
	buildSelectors,
	type SelectorKey,
} from '../selector-registry.js';
import {
	NEUTRAL_SELECTOR_PROFILE,
	MASSAGE_ITHACA_SELECTOR_PROFILE,
	DEFAULT_SELECTOR_PROFILE,
	resolveSelectorProfile,
} from '../selector-profile.js';

/** Tenant specifics that must NEVER appear in generic selector code. */
const TENANT_NEEDLES = [
	'field-13933959',
	'field-16606770',
	'Noha',
	'massageithaca',
	'MassageIthaca',
	'Massage Ithaca',
	'Internet search',
];

/** The keys that are tenant-customizable (intake-form fields). */
const TENANT_KEYS: readonly SelectorKey[] = [
	'termsCheckbox',
	'howDidYouHearCheckbox',
	'medicationField',
];

/**
 * The historical pre-extraction selector chains for the tenant keys (the values
 * that lived in the generic `Selectors` const before this lane). The MI profile
 * must reproduce these exactly.
 */
const HISTORICAL_MI_CHAINS: Record<string, readonly string[]> = {
	termsCheckbox: [
		'input[type="checkbox"][name*="field-13933959"]',
		'input[id*="13933959"]',
	],
	howDidYouHearCheckbox: [
		'input[type="checkbox"][name="Internet search"]',
		'label:has(input[type="checkbox"][name="Internet search"])',
	],
	medicationField: [
		'textarea[name="fields[field-16606770]"]',
		'#fields\\[field-16606770\\]',
	],
};

describe('generic selector registry has no tenant specifics', () => {
	it('the vendor-neutral base contains no tenant needles', () => {
		const serialized = JSON.stringify(BaseSelectors);
		for (const needle of TENANT_NEEDLES) {
			expect(serialized).not.toContain(needle);
		}
	});

	it('tenant-customizable keys resolve to empty chains in the neutral base', () => {
		for (const key of TENANT_KEYS) {
			expect(BaseSelectors[key]).toEqual([]);
		}
	});

	it('the neutral profile carries no tenant data', () => {
		expect(NEUTRAL_SELECTOR_PROFILE.selectors).toEqual({});
		expect(NEUTRAL_SELECTOR_PROFILE.excludeFallbackFieldId).toBeUndefined();
		expect(NEUTRAL_SELECTOR_PROFILE.defaultHowDidYouHear).toBeUndefined();
		const neutralTable = buildSelectors(NEUTRAL_SELECTOR_PROFILE);
		for (const key of TENANT_KEYS) {
			expect(neutralTable[key]).toEqual([]);
		}
	});
});

describe('massageithaca profile reproduces prior selector resolution', () => {
	it('the MI profile carries the tenant selector chains', () => {
		const table = buildSelectors(MASSAGE_ITHACA_SELECTOR_PROFILE);
		for (const key of TENANT_KEYS) {
			expect(table[key]).toEqual(HISTORICAL_MI_CHAINS[key]);
		}
	});

	it('the MI profile carries the de-tenanted fallback + default option data', () => {
		expect(MASSAGE_ITHACA_SELECTOR_PROFILE.excludeFallbackFieldId).toBe('field-13933959');
		expect(MASSAGE_ITHACA_SELECTOR_PROFILE.defaultHowDidYouHear).toBe('Internet search');
	});

	it('the default profile (selectorProfile unset) is the MI profile — trace-neutral', () => {
		expect(DEFAULT_SELECTOR_PROFILE).toBe(MASSAGE_ITHACA_SELECTOR_PROFILE);
		expect(resolveSelectorProfile(undefined)).toBe(MASSAGE_ITHACA_SELECTOR_PROFILE);
		expect(resolveSelectorProfile('massageithaca')).toBe(MASSAGE_ITHACA_SELECTOR_PROFILE);
	});

	it('the effective default `Selectors` table equals the historical const values', () => {
		// Tenant keys: MI values (preserved behavior).
		for (const key of TENANT_KEYS) {
			expect(Selectors[key]).toEqual(HISTORICAL_MI_CHAINS[key]);
		}
		// Vendor-neutral keys: unchanged from the base.
		expect(Selectors.firstNameInput).toEqual(BaseSelectors.firstNameInput);
		expect(Selectors.paymentCouponToggle).toEqual(BaseSelectors.paymentCouponToggle);
	});

	it('resolveSelectorProfile falls back to default for unknown names', () => {
		expect(resolveSelectorProfile('no-such-profile')).toBe(DEFAULT_SELECTOR_PROFILE);
	});

	it('the neutral profile is selectable by name', () => {
		expect(resolveSelectorProfile('neutral')).toBe(NEUTRAL_SELECTOR_PROFILE);
	});
});
