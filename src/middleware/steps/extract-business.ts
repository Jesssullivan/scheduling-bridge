/**
 * Extract BUSINESS Object from Acuity React SPA
 *
 * Acuity's scheduling page (Pylon/Squarespace) embeds a `BUSINESS`
 * JavaScript variable in the initial HTML containing the full service
 * catalog, calendars, forms, products, and configuration.
 *
 * This approach is far more reliable than DOM scraping because:
 * - The data is present in the raw HTML before React hydrates
 * - No CSS selectors needed (immune to UI redesigns)
 * - Contains Acuity's canonical numeric IDs for all services
 * - Works even without a browser (plain HTTP fetch + regex)
 *
 * Two extraction modes:
 * - `extractBusinessFromPage()` — Playwright page.evaluate (browser context)
 * - `extractBusinessFromHtml()` — Regex on raw HTML (no browser needed)
 */

import { Effect } from 'effect';
import { BrowserService } from '../browser-service.js';
import { WizardStepError } from '../errors.js';
import type { Service } from '../../core/types.js';

// =============================================================================
// TYPES — Acuity's BUSINESS object shape
// =============================================================================

/** A single appointment type from Acuity's BUSINESS.appointmentTypes */
export interface AcuityAppointmentType {
	readonly id: number;
	readonly name: string;
	readonly active: boolean;
	readonly description: string;
	readonly duration: number;
	readonly price: string; // "155.00"
	readonly category: string;
	readonly color: string;
	readonly private: boolean;
	readonly type: string; // "service"
	readonly calendarIDs: readonly number[];
	readonly formIDs: readonly number[];
	readonly addonIDs: readonly number[];
	readonly paddingAfter: number;
	readonly paddingBefore: number;
	readonly paymentRequired: boolean;
	readonly classSize: number | null;
}

/** A calendar (provider) from BUSINESS.calendars */
export interface AcuityCalendar {
	readonly id: number;
	readonly name: string;
	readonly description: string;
	readonly location: string;
	readonly timezone: string;
	readonly thumbnail: string;
	readonly image: string;
}

/** Subset of BUSINESS we care about */
export interface AcuityBusinessData {
	readonly id: number;
	readonly ownerKey: string;
	readonly name: string;
	readonly timezone: string;
	readonly appointmentTypes: Record<string, AcuityAppointmentType[]>;
	readonly calendars: Record<string, AcuityCalendar[]>;
	readonly products: Record<string, unknown[]>;
	readonly forms: unknown[];
	readonly addons: unknown[];
}

// =============================================================================
// EXTRACTION — Browser context (Effect program)
// =============================================================================

/**
 * Extract the BUSINESS object from the Acuity page using Playwright.
 * Loads the page and evaluates `window.BUSINESS` in the page context.
 */
export const extractBusinessFromPage = Effect.gen(function* () {
	const { acquirePage, config } = yield* BrowserService;
	const page = yield* acquirePage;

	yield* Effect.tryPromise({
		try: () => page.goto(config.baseUrl, { waitUntil: 'domcontentloaded', timeout: config.timeout }),
		catch: (e) =>
			new WizardStepError({
				step: 'extract-business',
				message: `Failed to load Acuity page: ${e instanceof Error ? e.message : String(e)}`,
			}),
	});

	const business = yield* Effect.tryPromise({
		try: () =>
			page.evaluate(() => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const b = (window as any).BUSINESS;
				if (!b) return null;
				return {
					id: b.id,
					ownerKey: b.ownerKey,
					name: b.name,
					timezone: b.timezone,
					appointmentTypes: b.appointmentTypes,
					calendars: b.calendars,
					products: b.products,
					forms: b.forms,
					addons: b.addons,
				};
			}),
		catch: (e) =>
			new WizardStepError({
				step: 'extract-business',
				message: `Failed to evaluate BUSINESS: ${e instanceof Error ? e.message : String(e)}`,
			}),
	});

	if (!business) {
		return yield* Effect.fail(
			new WizardStepError({
				step: 'extract-business',
				message: 'window.BUSINESS not found on Acuity page — page structure may have changed',
			}),
		);
	}

	return business as AcuityBusinessData;
});

// =============================================================================
// EXTRACTION — Plain HTTP (no browser needed)
// =============================================================================

/**
 * Extract the BUSINESS object from raw HTML using regex.
 * Works without a browser — suitable for lightweight health checks.
 */
export const extractBusinessFromHtml = (html: string): AcuityBusinessData | null => {
	// The BUSINESS object is assigned as: var BUSINESS = {...};
	// It's a large JSON-like object. We find the assignment and parse it.
	const match = html.match(/var\s+BUSINESS\s*=\s*(\{[\s\S]*?\});\s*(?:var\s|$)/);
	if (!match) return null;

	try {
		// The object may contain single-quoted strings or unquoted keys,
		// but Acuity outputs valid JSON-like syntax. Try parsing directly.
		const parsed = JSON.parse(match[1]);
		return {
			id: parsed.id,
			ownerKey: parsed.ownerKey,
			name: parsed.name,
			timezone: parsed.timezone,
			appointmentTypes: parsed.appointmentTypes ?? {},
			calendars: parsed.calendars ?? {},
			products: parsed.products ?? {},
			forms: parsed.forms ?? [],
			addons: parsed.addons ?? [],
		};
	} catch {
		// If JSON.parse fails, the page may use non-standard JS syntax.
		// Fall back to eval in a browser context (caller should use extractBusinessFromPage).
		return null;
	}
};

/**
 * Fetch the Acuity page via HTTP and extract the BUSINESS object.
 * No browser needed — uses plain fetch + regex.
 */
export const fetchBusinessData = async (baseUrl: string): Promise<AcuityBusinessData | null> => {
	try {
		const response = await fetch(baseUrl, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (compatible; scheduling-kit/1.0)',
			},
			redirect: 'follow',
		});
		if (!response.ok) return null;
		const html = await response.text();
		return extractBusinessFromHtml(html);
	} catch {
		return null;
	}
};

// =============================================================================
// TRANSFORM — BUSINESS → Service[]
// =============================================================================

/**
 * Convert Acuity's BUSINESS.appointmentTypes to our Service[] format.
 * Flattens the category-grouped structure and filters to active services.
 *
 * Critical: Uses Acuity's numeric ID (e.g. 53178494) as the service ID.
 * Our internal IDs (e.g. 'urgent-pain-relief') are PG-side only.
 * The wizard/scraper/availability endpoints need Acuity's numeric IDs.
 */
export const businessToServices = (business: AcuityBusinessData): Service[] => {
	const services: Service[] = [];

	for (const [category, types] of Object.entries(business.appointmentTypes)) {
		for (const apt of types) {
			if (!apt.active || apt.private) continue;

			services.push({
				id: String(apt.id),
				name: apt.name,
				duration: apt.duration,
				price: Math.round(parseFloat(apt.price) * 100), // "155.00" → 15500 cents
				currency: 'USD',
				category: category.replace(/^\d+\.?\s*/, ''), // Strip numeric prefix: "2 TMD" → "TMD"
				active: true,
			});
		}
	}

	return services;
};

/**
 * Effect program: extract services from BUSINESS object via browser.
 * Combines extractBusinessFromPage + businessToServices.
 */
export const extractBusinessServices = Effect.gen(function* () {
	const business = yield* extractBusinessFromPage;
	const services = businessToServices(business);

	if (services.length === 0) {
		console.warn('[extract-business] BUSINESS object found but contained 0 active services');
	} else {
		console.log(`[extract-business] Extracted ${services.length} services from BUSINESS object`);
	}

	return services;
});
