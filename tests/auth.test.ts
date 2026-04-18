import { describe, expect, it } from 'vitest';
import { checkAuth, UNAUTHENTICATED_PATHS } from '../src/server/auth.js';

describe('auth middleware', () => {
	const TOKEN = 'test-secret-token';

	describe('when auth is disabled (no token configured)', () => {
		it('allows any request', () => {
			const result = checkAuth(undefined, '/services', undefined);
			expect(result.authorized).toBe(true);
		});

		it('allows requests without Authorization header', () => {
			const result = checkAuth(undefined, '/booking/create', undefined);
			expect(result.authorized).toBe(true);
		});
	});

	describe('when auth is enabled', () => {
		it('accepts correct Bearer token', () => {
			const result = checkAuth(TOKEN, '/services', `Bearer ${TOKEN}`);
			expect(result.authorized).toBe(true);
		});

		it('rejects missing Authorization header', () => {
			const result = checkAuth(TOKEN, '/services', undefined);
			expect(result.authorized).toBe(false);
			if (!result.authorized) {
				expect(result.statusCode).toBe(401);
				expect(result.body.error.code).toBe('UNAUTHORIZED');
			}
		});

		it('rejects wrong token', () => {
			const result = checkAuth(TOKEN, '/services', 'Bearer wrong-token');
			expect(result.authorized).toBe(false);
		});

		it('rejects non-Bearer scheme', () => {
			const result = checkAuth(TOKEN, '/services', `Basic ${TOKEN}`);
			expect(result.authorized).toBe(false);
		});

		it('rejects raw token without Bearer prefix', () => {
			const result = checkAuth(TOKEN, '/services', TOKEN);
			expect(result.authorized).toBe(false);
		});

		it('rejects empty Authorization header', () => {
			const result = checkAuth(TOKEN, '/services', '');
			expect(result.authorized).toBe(false);
		});
	});

	describe('unauthenticated paths (K8s probes)', () => {
		it('bypasses auth for /health', () => {
			const result = checkAuth(TOKEN, '/health', undefined);
			expect(result.authorized).toBe(true);
		});

		it('bypasses auth for /ready', () => {
			const result = checkAuth(TOKEN, '/ready', undefined);
			expect(result.authorized).toBe(true);
		});

		it('bypasses auth for /metrics', () => {
			const result = checkAuth(TOKEN, '/metrics', undefined);
			expect(result.authorized).toBe(true);
		});

		it('does NOT bypass auth for /services', () => {
			const result = checkAuth(TOKEN, '/services', undefined);
			expect(result.authorized).toBe(false);
		});

		it('does NOT bypass auth for /booking/create', () => {
			const result = checkAuth(TOKEN, '/booking/create', undefined);
			expect(result.authorized).toBe(false);
		});
	});

	describe('default unauthenticated paths', () => {
		it('includes exactly /health, /ready, /metrics', () => {
			expect(UNAUTHENTICATED_PATHS).toEqual(
				new Set(['/health', '/ready', '/metrics']),
			);
		});
	});

	describe('custom unauthenticated paths', () => {
		it('accepts custom path set', () => {
			const custom = new Set(['/custom-health']);
			const result = checkAuth(TOKEN, '/custom-health', undefined, custom);
			expect(result.authorized).toBe(true);
		});

		it('still rejects non-listed paths with custom set', () => {
			const custom = new Set(['/custom-health']);
			const result = checkAuth(TOKEN, '/health', undefined, custom);
			expect(result.authorized).toBe(false);
		});
	});

	describe('rejection shape', () => {
		it('returns structured error body matching bridge protocol', () => {
			const result = checkAuth(TOKEN, '/services', undefined);
			expect(result.authorized).toBe(false);
			if (!result.authorized) {
				expect(result.body).toEqual({
					success: false,
					error: {
						tag: 'InfrastructureError',
						code: 'UNAUTHORIZED',
						message: 'Invalid auth token',
					},
				});
			}
		});
	});
});
