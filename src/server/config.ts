/**
 * Server Configuration
 *
 * Centralized, typed configuration read from environment variables.
 * Fails fast at import time when required vars are malformed, so K8s
 * pods crash immediately with a clear message rather than serving
 * partial responses.
 *
 * All process.env reads for server runtime config belong here.
 * Adapter-level env reads (e.g., slot-read-profile thresholds) stay
 * with the adapter code that owns them.
 */

import type { BrowserConfig } from '../shared/browser-service.js';
import { defaultBrowserConfig } from '../shared/browser-service.js';
import type { ScraperConfig } from '../adapters/acuity/scraper.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const parseIntOr = (raw: string | undefined, fallback: number): number => {
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
	if (!raw) return fallback;
	return raw !== 'false';
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface ServerConfig {
	/** HTTP listen port */
	readonly port: number;
	/** Bearer token required on all endpoints (undefined = auth disabled) */
	readonly authToken: string | undefined;
}

export const readServerConfig = (
	env: Record<string, string | undefined> = process.env,
): ServerConfig => ({
	port: parseIntOr(env.PORT, 3001),
	authToken: env.AUTH_TOKEN,
});

// ---------------------------------------------------------------------------
// Acuity
// ---------------------------------------------------------------------------

export interface AcuityConfig {
	/** Base URL of the Acuity scheduling page */
	readonly baseUrl: string;
	/** 100% discount coupon code for payment bypass */
	readonly couponCode: string | undefined;
	/** Service catalog cache TTL in milliseconds */
	readonly serviceCacheTtlMs: number;
	/** Static services JSON (pre-seeded catalog) */
	readonly servicesJson: string | undefined;
}

export const readAcuityConfig = (
	env: Record<string, string | undefined> = process.env,
): AcuityConfig => ({
	baseUrl: env.ACUITY_BASE_URL ?? 'https://MassageIthaca.as.me',
	couponCode: env.ACUITY_BYPASS_COUPON,
	serviceCacheTtlMs: parseIntOr(env.ACUITY_SERVICE_CACHE_TTL_MS, 5 * 60_000),
	servicesJson: env.SERVICES_JSON,
});

// ---------------------------------------------------------------------------
// Browser / Playwright
// ---------------------------------------------------------------------------

export interface BrowserEnvConfig {
	readonly headless: boolean;
	readonly timeout: number;
	readonly executablePath: string | undefined;
	readonly launchArgs: string[] | undefined;
}

export const readBrowserEnvConfig = (
	env: Record<string, string | undefined> = process.env,
): BrowserEnvConfig => ({
	headless: parseBool(env.PLAYWRIGHT_HEADLESS, true),
	timeout: parseIntOr(env.PLAYWRIGHT_TIMEOUT, 30000),
	executablePath: env.CHROMIUM_EXECUTABLE_PATH,
	launchArgs: env.CHROMIUM_LAUNCH_ARGS?.split(','),
});

export const toBrowserConfig = (
	acuity: AcuityConfig,
	browserEnv: BrowserEnvConfig,
): BrowserConfig => ({
	...defaultBrowserConfig,
	baseUrl: acuity.baseUrl,
	headless: browserEnv.headless,
	timeout: browserEnv.timeout,
	executablePath: browserEnv.executablePath,
	launchArgs: browserEnv.launchArgs,
});

export const toScraperConfig = (
	acuity: AcuityConfig,
	browser: BrowserConfig,
): ScraperConfig => ({
	baseUrl: acuity.baseUrl,
	headless: browser.headless,
	timeout: browser.timeout,
	userAgent: browser.userAgent,
	executablePath: browser.executablePath,
	launchArgs: browser.launchArgs ? [...browser.launchArgs] : undefined,
});

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

export interface RedisConfig {
	/** Redis connection URL (undefined = L1-only mode, no L2 cache) */
	readonly url: string | undefined;
	/** Redis password (if not embedded in URL) */
	readonly password: string | undefined;
}

export const readRedisConfig = (
	env: Record<string, string | undefined> = process.env,
): RedisConfig => ({
	url: env.REDIS_URL,
	password: env.REDIS_PASSWORD,
});

// ---------------------------------------------------------------------------
// Release metadata
// ---------------------------------------------------------------------------

export interface ReleaseConfig {
	readonly sha: string | undefined;
	readonly ref: string | undefined;
	readonly version: string | undefined;
	readonly builtAt: string | undefined;
	readonly runtimeEnvironment: string | undefined;
}

export const readReleaseConfig = (
	env: Record<string, string | undefined> = process.env,
): ReleaseConfig => ({
	sha: env.MIDDLEWARE_RELEASE_SHA,
	ref: env.MIDDLEWARE_RELEASE_REF,
	version: env.MIDDLEWARE_RELEASE_VERSION ?? env.npm_package_version,
	builtAt: env.MIDDLEWARE_RELEASE_BUILT_AT ?? env.MIDDLEWARE_BUILD_TIMESTAMP,
	runtimeEnvironment: env.DEPLOYMENT_ENVIRONMENT ?? env.MODAL_ENVIRONMENT,
});

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

export interface AppConfig {
	readonly server: ServerConfig;
	readonly acuity: AcuityConfig;
	readonly browserEnv: BrowserEnvConfig;
	readonly redis: RedisConfig;
	readonly release: ReleaseConfig;
}

export const readAppConfig = (
	env: Record<string, string | undefined> = process.env,
): AppConfig => ({
	server: readServerConfig(env),
	acuity: readAcuityConfig(env),
	browserEnv: readBrowserEnvConfig(env),
	redis: readRedisConfig(env),
	release: readReleaseConfig(env),
});
