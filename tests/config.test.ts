import { describe, expect, it } from 'vitest';
import {
	readServerConfig,
	readAcuityConfig,
	readBrowserEnvConfig,
	readRedisConfig,
	readReleaseConfig,
	readAppConfig,
	configSummary,
} from '../src/server/config.js';

describe('server config', () => {
	describe('readServerConfig', () => {
		it('reads port and auth token from env', () => {
			const config = readServerConfig({ PORT: '8080', AUTH_TOKEN: 'secret' });
			expect(config.port).toBe(8080);
			expect(config.authToken).toBe('secret');
		});

		it('defaults port to 3001 when absent', () => {
			const config = readServerConfig({});
			expect(config.port).toBe(3001);
		});

		it('defaults port to 3001 when invalid', () => {
			const config = readServerConfig({ PORT: 'nope' });
			expect(config.port).toBe(3001);
		});

		it('leaves authToken undefined when absent', () => {
			const config = readServerConfig({});
			expect(config.authToken).toBeUndefined();
		});
	});

	describe('readAcuityConfig', () => {
		it('reads all acuity vars', () => {
			const config = readAcuityConfig({
				ACUITY_BASE_URL: 'https://test.as.me',
				ACUITY_BYPASS_COUPON: 'TESTCODE',
				ACUITY_SERVICE_CACHE_TTL_MS: '120000',
				SERVICES_JSON: '[{"id":"1"}]',
			});
			expect(config.baseUrl).toBe('https://test.as.me');
			expect(config.couponCode).toBe('TESTCODE');
			expect(config.serviceCacheTtlMs).toBe(120000);
			expect(config.servicesJson).toBe('[{"id":"1"}]');
		});

		it('defaults baseUrl to MassageIthaca', () => {
			const config = readAcuityConfig({});
			expect(config.baseUrl).toBe('https://MassageIthaca.as.me');
		});

		it('defaults cache TTL to 5 minutes', () => {
			const config = readAcuityConfig({});
			expect(config.serviceCacheTtlMs).toBe(300000);
		});

		it('falls back to 5 minutes on invalid TTL', () => {
			const config = readAcuityConfig({ ACUITY_SERVICE_CACHE_TTL_MS: 'bad' });
			expect(config.serviceCacheTtlMs).toBe(300000);
		});
	});

	describe('readBrowserEnvConfig', () => {
		it('reads browser config from env', () => {
			const config = readBrowserEnvConfig({
				PLAYWRIGHT_HEADLESS: 'false',
				PLAYWRIGHT_TIMEOUT: '60000',
				CHROMIUM_EXECUTABLE_PATH: '/usr/bin/chromium',
				CHROMIUM_LAUNCH_ARGS: '--no-sandbox,--disable-gpu',
			});
			expect(config.headless).toBe(false);
			expect(config.timeout).toBe(60000);
			expect(config.executablePath).toBe('/usr/bin/chromium');
			expect(config.launchArgs).toEqual(['--no-sandbox', '--disable-gpu']);
		});

		it('defaults to headless=true, timeout=30000', () => {
			const config = readBrowserEnvConfig({});
			expect(config.headless).toBe(true);
			expect(config.timeout).toBe(30000);
			expect(config.executablePath).toBeUndefined();
			expect(config.launchArgs).toBeUndefined();
		});

		it('treats any PLAYWRIGHT_HEADLESS value except "false" as true', () => {
			expect(readBrowserEnvConfig({ PLAYWRIGHT_HEADLESS: 'true' }).headless).toBe(true);
			expect(readBrowserEnvConfig({ PLAYWRIGHT_HEADLESS: '1' }).headless).toBe(true);
			expect(readBrowserEnvConfig({ PLAYWRIGHT_HEADLESS: 'yes' }).headless).toBe(true);
		});
	});

	describe('readRedisConfig', () => {
		it('reads redis URL and password', () => {
			const config = readRedisConfig({
				REDIS_URL: 'redis://localhost:6379',
				REDIS_PASSWORD: 'pass123',
			});
			expect(config.url).toBe('redis://localhost:6379');
			expect(config.password).toBe('pass123');
		});

		it('leaves both undefined when absent', () => {
			const config = readRedisConfig({});
			expect(config.url).toBeUndefined();
			expect(config.password).toBeUndefined();
		});
	});

	describe('readReleaseConfig', () => {
		it('reads release metadata from standard env vars', () => {
			const config = readReleaseConfig({
				MIDDLEWARE_RELEASE_SHA: 'abc123',
				MIDDLEWARE_RELEASE_REF: 'refs/heads/main',
				MIDDLEWARE_RELEASE_VERSION: '0.4.3',
				MIDDLEWARE_RELEASE_BUILT_AT: '2026-04-18T12:00:00Z',
				DEPLOYMENT_ENVIRONMENT: 'tailnet-dev',
			});
			expect(config.sha).toBe('abc123');
			expect(config.ref).toBe('refs/heads/main');
			expect(config.version).toBe('0.4.3');
			expect(config.builtAt).toBe('2026-04-18T12:00:00Z');
			expect(config.runtimeEnvironment).toBe('tailnet-dev');
		});

		it('falls back to npm_package_version for version', () => {
			const config = readReleaseConfig({ npm_package_version: '0.4.2' });
			expect(config.version).toBe('0.4.2');
		});

		it('falls back to MIDDLEWARE_BUILD_TIMESTAMP for builtAt', () => {
			const config = readReleaseConfig({
				MIDDLEWARE_BUILD_TIMESTAMP: '2026-04-18T10:00:00Z',
			});
			expect(config.builtAt).toBe('2026-04-18T10:00:00Z');
		});

		it('falls back to MODAL_ENVIRONMENT when DEPLOYMENT_ENVIRONMENT absent', () => {
			const config = readReleaseConfig({ MODAL_ENVIRONMENT: 'main' });
			expect(config.runtimeEnvironment).toBe('main');
		});

		it('prefers DEPLOYMENT_ENVIRONMENT over MODAL_ENVIRONMENT', () => {
			const config = readReleaseConfig({
				DEPLOYMENT_ENVIRONMENT: 'k8s-prod',
				MODAL_ENVIRONMENT: 'main',
			});
			expect(config.runtimeEnvironment).toBe('k8s-prod');
		});

		it('returns all undefined when env is empty', () => {
			const config = readReleaseConfig({});
			expect(config.sha).toBeUndefined();
			expect(config.ref).toBeUndefined();
			expect(config.version).toBeUndefined();
			expect(config.builtAt).toBeUndefined();
			expect(config.runtimeEnvironment).toBeUndefined();
		});
	});

	describe('readAppConfig', () => {
		it('composes all sub-configs from a single env', () => {
			const config = readAppConfig({
				PORT: '9000',
				AUTH_TOKEN: 'tok',
				ACUITY_BASE_URL: 'https://test.as.me',
				REDIS_URL: 'redis://localhost',
				DEPLOYMENT_ENVIRONMENT: 'tailnet-dev',
			});
			expect(config.server.port).toBe(9000);
			expect(config.server.authToken).toBe('tok');
			expect(config.acuity.baseUrl).toBe('https://test.as.me');
			expect(config.redis.url).toBe('redis://localhost');
			expect(config.release.runtimeEnvironment).toBe('tailnet-dev');
			expect(config.browserEnv.headless).toBe(true);
		});

		it('works with completely empty env', () => {
			const config = readAppConfig({});
			expect(config.server.port).toBe(3001);
			expect(config.acuity.baseUrl).toBe('https://MassageIthaca.as.me');
			expect(config.redis.url).toBeUndefined();
		});
	});

	describe('configSummary', () => {
		it('omits secret values, exposes only booleans and non-sensitive fields', () => {
			const config = readAppConfig({
				PORT: '8080',
				AUTH_TOKEN: 'super-secret-token',
				ACUITY_BYPASS_COUPON: 'SECRET100',
				REDIS_URL: 'redis://:password@host:6379',
				REDIS_PASSWORD: 'password',
				DEPLOYMENT_ENVIRONMENT: 'tailnet-dev',
				MIDDLEWARE_RELEASE_SHA: 'abc123',
				MIDDLEWARE_RELEASE_VERSION: '0.4.3',
			});

			const summary = configSummary(config);

			// Sensitive values should NOT appear
			expect(JSON.stringify(summary)).not.toContain('super-secret-token');
			expect(JSON.stringify(summary)).not.toContain('SECRET100');
			expect(JSON.stringify(summary)).not.toContain('password');

			// Only booleans for secret-adjacent fields
			expect(summary.authEnabled).toBe(true);
			expect(summary.couponConfigured).toBe(true);
			expect(summary.redisConfigured).toBe(true);

			// Non-sensitive metadata present
			expect(summary.port).toBe(8080);
			expect(summary.runtimeEnvironment).toBe('tailnet-dev');
			expect(summary.releaseSha).toBe('abc123');
		});

		it('handles empty config gracefully', () => {
			const config = readAppConfig({});
			const summary = configSummary(config);

			expect(summary.authEnabled).toBe(false);
			expect(summary.redisConfigured).toBe(false);
			expect(summary.runtimeEnvironment).toBeNull();
			expect(summary.releaseVersion).toBeNull();
		});
	});
});
