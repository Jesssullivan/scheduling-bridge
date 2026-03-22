/**
 * BrowserService Layer
 *
 * Effect TS Layer providing managed Playwright browser lifecycle.
 * The browser and pages are acquired/released via Effect's Scope,
 * ensuring proper cleanup even on errors or interruptions.
 */

import { Context, Effect, Layer, Scope } from 'effect';
import type { Browser, Page } from 'playwright-core';
import { BrowserError } from './errors.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface BrowserConfig {
	/** Base URL for the Acuity scheduling page */
	readonly baseUrl: string;
	/** Run browser in headless mode (default: true) */
	readonly headless: boolean;
	/** Default timeout for page operations in ms (default: 30000) */
	readonly timeout: number;
	/** User agent string */
	readonly userAgent: string;
	/** Take screenshot on failure (default: true) */
	readonly screenshotOnFailure: boolean;
	/** Directory for failure screenshots */
	readonly screenshotDir: string;
	/** Path to Chromium executable (for Lambda/serverless) */
	readonly executablePath?: string;
	/** Additional chromium.launch() args (e.g., Lambda sandbox flags) */
	readonly launchArgs?: readonly string[];
}

export const defaultBrowserConfig: BrowserConfig = {
	baseUrl: 'https://MassageIthaca.as.me',
	headless: true,
	timeout: 30000,
	userAgent:
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	screenshotOnFailure: true,
	screenshotDir: '/tmp/scheduling-kit-screenshots',
};

// =============================================================================
// SERVICE DEFINITION
// =============================================================================

export interface BrowserServiceShape {
	/** Get a managed Page (scoped - auto-closed when scope ends) */
	readonly acquirePage: Effect.Effect<Page, BrowserError, Scope.Scope>;
	/** Take a screenshot of the most recently created page */
	readonly screenshot: (label: string) => Effect.Effect<Buffer, BrowserError>;
	/** The browser configuration */
	readonly config: BrowserConfig;
}

export class BrowserService extends Context.Tag('scheduling-kit/BrowserService')<
	BrowserService,
	BrowserServiceShape
>() {}

// =============================================================================
// LIVE IMPLEMENTATION
// =============================================================================

/**
 * Create a live BrowserService layer backed by Playwright Chromium.
 * The browser is launched once when the layer is created and closed
 * when the layer scope ends.
 */
export const BrowserServiceLive = (
	config: Partial<BrowserConfig> = {},
): Layer.Layer<BrowserService, BrowserError> => {
	const cfg: BrowserConfig = { ...defaultBrowserConfig, ...config };

	return Layer.scoped(
		BrowserService,
		Effect.gen(function* () {
			// Dynamic import - try playwright-core first (lighter, no bundled browsers),
			// fall back to full playwright which includes its own Chromium
			const chromium = yield* Effect.tryPromise({
				try: async (): Promise<typeof import('playwright-core').chromium> => {
					try {
						const pw = await import('playwright-core');
						return pw.chromium;
					} catch {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const pw = await (import('playwright-core') as any);
						return pw.chromium;
					}
				},
				catch: () =>
					new BrowserError({
						reason: 'PLAYWRIGHT_MISSING',
						cause: new Error(
							'playwright-core or playwright is required for the wizard middleware. ' +
								'Install with: pnpm add playwright-core',
						),
					}),
			});

			// Launch browser (released when scope ends)
			const browser: Browser = yield* Effect.acquireRelease(
				Effect.tryPromise({
					try: () =>
						chromium.launch({
							headless: cfg.headless,
							executablePath: cfg.executablePath,
							args: cfg.launchArgs ? [...cfg.launchArgs] : undefined,
						}),
					catch: (e) => new BrowserError({ reason: 'LAUNCH_FAILED', cause: e }),
				}),
				(browser) =>
					Effect.promise(() => browser.close()).pipe(Effect.ignoreLogged),
			);

			// Create a single managed page for the layer's lifetime.
			// All step programs share this page within a scope.
			const page: Page = yield* Effect.acquireRelease(
				Effect.tryPromise({
					try: async () => {
						const p = await browser.newPage({ userAgent: cfg.userAgent });
						p.setDefaultTimeout(cfg.timeout);
						return p;
					},
					catch: (e) => new BrowserError({ reason: 'PAGE_FAILED', cause: e }),
				}),
				(p) =>
					Effect.promise(() => p.close()).pipe(Effect.ignoreLogged),
			);

			// acquirePage returns the singleton page — cleanup is handled by the
			// layer scope above. The no-op release keeps the Scope type requirement
			// so callers still need Effect.scoped.
			const acquirePage = Effect.acquireRelease(
				Effect.succeed(page),
				() => Effect.void,
			);

			const screenshot = (label: string) =>
				Effect.tryPromise({
					try: async () => {
						if (page.isClosed()) {
							throw new Error('No active page for screenshot');
						}
						const buffer = await page.screenshot({
							path: `${cfg.screenshotDir}/${label}-${Date.now()}.png`,
							fullPage: true,
						});
						return buffer;
					},
					catch: (e) => new BrowserError({ reason: 'SCREENSHOT_FAILED', cause: e }),
				});

			return { acquirePage, screenshot, config: cfg };
		}),
	);
};

// =============================================================================
// TEST IMPLEMENTATION
// =============================================================================

/**
 * A mock BrowserService for unit tests.
 * Does not launch a real browser.
 */
export const BrowserServiceTest = (
	config: Partial<BrowserConfig> = {},
): Layer.Layer<BrowserService> => {
	const cfg: BrowserConfig = { ...defaultBrowserConfig, ...config };

	return Layer.succeed(BrowserService, {
		acquirePage: Effect.die(
			new Error('BrowserServiceTest: acquirePage called - use a real browser for integration tests'),
		) as unknown as Effect.Effect<Page, BrowserError, Scope.Scope>,
		screenshot: () =>
			Effect.succeed(Buffer.from('mock-screenshot')),
		config: cfg,
	});
};
