/**
 * Wizard Step: Fill Client Form Fields
 *
 * Fills standard fields (name, email, phone), custom intake fields
 * (radio buttons, "How did you hear" checkboxes, medication, terms),
 * and advances past the client info step to the payment page.
 *
 * Acuity form requirements (verified 2026-02-26):
 *   - Standard: firstName, lastName, email, phone
 *   - 3 yes/no radio groups (aria-required, NO name/id attrs)
 *   - "How did you hear" multi-checkbox (at least 1 required)
 *   - Medication textarea (fields[field-16606770])
 *   - Terms checkbox (fields[field-13933959])
 *   - ALL must be filled before "Continue to Payment" advances
 */

import { Effect } from 'effect';
import type { Page } from 'playwright-core';
import { BrowserService } from '../browser-service.js';
import { WizardStepError } from '../errors.js';
import { resolveSelector, Selectors } from '../selectors.js';
import type { ClientInfo } from '../../core/types.js';

// =============================================================================
// TYPES
// =============================================================================

export interface FillFormParams {
	readonly client: ClientInfo;
	readonly customFields?: Record<string, string>;
	/** Answer for yes/no radio questions (default: "no") */
	readonly intakeRadioAnswer?: 'yes' | 'no';
	/** Which "How did you hear" checkbox to select (default: "Internet search") */
	readonly howDidYouHear?: string;
	/** Medication text (default: "None") */
	readonly medication?: string;
}

export interface FillFormResult {
	readonly fieldsCompleted: string[];
	readonly customFieldsCompleted: string[];
	readonly intakeFieldsCompleted: string[];
	readonly advanced: boolean;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Fill the client information form and advance to the payment page.
 */
export const fillFormFields = (params: FillFormParams) =>
	Effect.gen(function* () {
		const { acquirePage } = yield* BrowserService;
		const page: Page = yield* acquirePage;

		const fieldsCompleted: string[] = [];
		const intakeFieldsCompleted: string[] = [];

		// Fill or verify each standard field
		yield* fillField(page, Selectors.firstNameInput, params.client.firstName, 'firstName');
		fieldsCompleted.push('firstName');

		yield* fillField(page, Selectors.lastNameInput, params.client.lastName, 'lastName');
		fieldsCompleted.push('lastName');

		yield* fillField(page, Selectors.emailInput, params.client.email, 'email');
		fieldsCompleted.push('email');

		if (params.client.phone) {
			yield* fillField(page, Selectors.phoneInput, params.client.phone, 'phone');
			fieldsCompleted.push('phone');
		}

		// Fill custom intake fields (by field ID)
		const customFieldsCompleted: string[] = [];
		if (params.customFields) {
			for (const [fieldId, value] of Object.entries(params.customFields)) {
				const filled = yield* fillCustomField(page, fieldId, value);
				if (filled) customFieldsCompleted.push(fieldId);
			}
		}

		// Fill intake radio buttons (yes/no questions)
		const radioAnswer = params.intakeRadioAnswer ?? 'no';
		yield* fillIntakeRadios(page, radioAnswer);
		intakeFieldsCompleted.push('radioButtons');

		// Fill "How did you hear" checkbox
		const hearOption = params.howDidYouHear ?? 'Internet search';
		yield* fillHowDidYouHear(page, hearOption);
		intakeFieldsCompleted.push('howDidYouHear');

		// Fill medication textarea
		const medication = params.medication ?? 'None';
		yield* fillMedication(page, medication);
		intakeFieldsCompleted.push('medication');

		// Fill terms checkbox
		yield* fillTermsCheckbox(page);
		intakeFieldsCompleted.push('termsCheckbox');

		// Click continue/next to advance past client form
		const advanced = yield* advancePastForm(page);

		return {
			fieldsCompleted,
			customFieldsCompleted,
			intakeFieldsCompleted,
			advanced,
		} satisfies FillFormResult;
	}).pipe(
		Effect.catchTag('SelectorError', (e) =>
			Effect.fail(
				new WizardStepError({
					step: 'fill-form',
					message: `Form field not found: ${e.message}`,
					cause: e,
				}),
			),
		),
	);

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Fill a form field. If the field already has the correct value
 * (from URL pre-fill), skip it. Otherwise clear and fill.
 */
const fillField = (
	page: Page,
	candidates: readonly string[],
	value: string,
	fieldName: string,
) =>
	Effect.gen(function* () {
		const { element, selector } = yield* resolveSelector(page, candidates, 5000);

		// Check current value
		const currentValue = yield* Effect.tryPromise({
			try: () => page.$eval(selector, (el) => (el as HTMLInputElement).value),
			catch: () => '',
		}).pipe(Effect.orElseSucceed(() => ''));

		// Skip if already correct
		if (currentValue.trim().toLowerCase() === value.trim().toLowerCase()) {
			return;
		}

		// Clear and fill
		yield* Effect.tryPromise({
			try: async () => {
				await element.click({ clickCount: 3 }); // Select all
				await element.fill(value);
			},
			catch: (e) =>
				new WizardStepError({
					step: 'fill-form',
					message: `Failed to fill ${fieldName}: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});
	});

/**
 * Fill a custom Acuity intake field by field ID.
 * Acuity custom fields use `field:XXXX` name pattern.
 */
const fillCustomField = (
	page: Page,
	fieldId: string,
	value: string,
): Effect.Effect<boolean, never> =>
	Effect.gen(function* () {
		const selectors = [
			`[name="fields[field-${fieldId}]"]`,
			`input[id*="${fieldId}"]`,
			`textarea[name*="${fieldId}"]`,
			`[data-field-id="${fieldId}"]`,
		];

		const result = yield* resolveSelector(page, selectors, 2000).pipe(
			Effect.map((resolved) => resolved),
			Effect.orElseSucceed(() => null),
		);

		if (!result) return false;

		yield* Effect.tryPromise({
			try: async () => {
				const tagName = await result.element.evaluate((el) => (el as Element).tagName.toLowerCase());
				if (tagName === 'select') {
					await page.selectOption(result.selector, value);
				} else if (tagName === 'textarea') {
					await result.element.fill(value);
				} else {
					const inputType = await result.element.evaluate(
						(el) => (el as HTMLInputElement).type,
					);
					if (inputType === 'checkbox') {
						const checked = await result.element.isChecked();
						if ((value === 'true') !== checked) {
							await result.element.click();
						}
					} else {
						await result.element.fill(value);
					}
				}
			},
			catch: () => null,
		}).pipe(Effect.orElseSucceed(() => null));

		return true;
	});

/**
 * Fill intake radio buttons.
 *
 * Acuity's radio buttons have NO name or id attributes — they are purely
 * React-controlled. The proven strategy is to click the <label> element
 * wrapping each radio via Playwright's locator().nth() API, which dispatches
 * OS-level mouse events that React's event delegation handles correctly.
 */
const fillIntakeRadios = (
	page: Page,
	answer: 'yes' | 'no',
): Effect.Effect<void, WizardStepError> =>
	Effect.tryPromise({
		try: async () => {
			const selectorKey = answer === 'no' ? Selectors.radioNoLabel : Selectors.radioYesLabel;
			const labelLocator = page.locator(selectorKey[0]);
			const count = await labelLocator.count();

			for (let i = 0; i < count; i++) {
				await labelLocator.nth(i).scrollIntoViewIfNeeded();
				await labelLocator.nth(i).click({ timeout: 5000 });
				await page.waitForTimeout(200);
			}
		},
		catch: (e) =>
			new WizardStepError({
				step: 'fill-form',
				message: `Failed to fill radio buttons: ${e instanceof Error ? e.message : String(e)}`,
				cause: e,
			}),
	});

/**
 * Select at least one "How did you hear" checkbox.
 *
 * These checkboxes have plain-text name attributes like "Internet search".
 * Uses the same label-click locator strategy as radio buttons.
 */
const fillHowDidYouHear = (
	page: Page,
	option: string,
): Effect.Effect<void, WizardStepError> =>
	Effect.tryPromise({
		try: async () => {
			const labelLocator = page.locator(`label:has(input[type="checkbox"][name="${option}"])`);
			const count = await labelLocator.count();
			if (count > 0) {
				await labelLocator.first().scrollIntoViewIfNeeded();
				await labelLocator.first().click({ timeout: 3000 });
			} else {
				// Fallback: click the first non-terms checkbox
				const fallback = page.locator('input[type="checkbox"]:not([name*="field-13933959"])');
				const fallbackCount = await fallback.count();
				if (fallbackCount > 0) {
					const parent = page.locator('label:has(input[type="checkbox"]:not([name*="field-13933959"]))');
					await parent.first().scrollIntoViewIfNeeded();
					await parent.first().click({ timeout: 3000 });
				}
			}
		},
		catch: (e) =>
			new WizardStepError({
				step: 'fill-form',
				message: `Failed to fill "How did you hear": ${e instanceof Error ? e.message : String(e)}`,
				cause: e,
			}),
	});

/**
 * Fill the medication textarea.
 */
const fillMedication = (
	page: Page,
	text: string,
): Effect.Effect<void, never> =>
	Effect.tryPromise({
		try: async () => {
			for (const selector of Selectors.medicationField) {
				const el = await page.$(selector);
				if (el) {
					await el.fill(text);
					return;
				}
			}
		},
		catch: () => undefined,
	}).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Check the terms agreement checkbox via label click.
 */
const fillTermsCheckbox = (page: Page): Effect.Effect<void, never> =>
	Effect.tryPromise({
		try: async () => {
			const isChecked = await page
				.$eval(Selectors.termsCheckbox[0], (el) => (el as HTMLInputElement).checked)
				.catch(() => false);
			if (!isChecked) {
				const label = page.locator(`label:has(${Selectors.termsCheckbox[0]})`);
				await label.scrollIntoViewIfNeeded();
				await label.click({ timeout: 3000 });
			}
		},
		catch: () => undefined,
	}).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Click "Continue to Payment" to advance past the client form.
 *
 * Verified 2026-02-26: "Continue to Payment" navigates to a SEPARATE
 * payment page at URL .../datetime/<ISO>/payment.
 */
const advancePastForm = (page: Page): Effect.Effect<boolean, WizardStepError> =>
	Effect.gen(function* () {
		const continueBtn = yield* resolveSelector(page, Selectors.continueToPayment, 5000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new WizardStepError({
						step: 'fill-form',
						message: '"Continue to Payment" button not found after filling form',
					}),
				),
			),
		);

		yield* Effect.tryPromise({
			try: async () => {
				await continueBtn.element.click();
				// Wait for navigation to payment page (URL ends in /payment)
				await page.waitForURL((url) => url.href.includes('/payment'), { timeout: 15000 });
			},
			catch: (e) =>
				new WizardStepError({
					step: 'fill-form',
					message: `Failed to advance to payment page: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		return true;
	});
