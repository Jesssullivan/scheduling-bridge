import { describe, expect, it } from 'vitest';
import {
	BRIDGE_PROTOCOL_CAPABILITIES,
	BRIDGE_PROTOCOL_ENDPOINTS,
	BRIDGE_PROTOCOL_VERSION,
	buildHealthPayload,
} from '../src/server/health.js';

describe('bridge health payload', () => {
	it('exposes release truth and versioned protocol metadata', () => {
		const payload = buildHealthPayload({
			baseUrl: 'https://MassageIthaca.as.me',
			hasCoupon: true,
			headless: true,
			staticServices: 8,
			serviceCacheTtlMs: 300000,
			releaseSha: 'abc123',
			releaseRef: 'refs/heads/main',
			releaseVersion: '0.4.2',
			releaseBuiltAt: '2026-04-16T12:00:00.000Z',
			modalEnvironment: 'main',
			timestamp: '2026-04-16T12:34:56.000Z',
		});

		expect(payload.protocolVersion).toBe(BRIDGE_PROTOCOL_VERSION);
		expect(payload.release).toEqual({
			sha: 'abc123',
			ref: 'refs/heads/main',
			version: '0.4.2',
			builtAt: '2026-04-16T12:00:00.000Z',
			modalEnvironment: 'main',
		});
		expect(payload.protocol).toEqual({
			version: BRIDGE_PROTOCOL_VERSION,
			flowOwner: 'scheduling-bridge',
			backend: 'acuity',
			transport: 'http-json',
			endpoints: BRIDGE_PROTOCOL_ENDPOINTS,
			capabilities: [...BRIDGE_PROTOCOL_CAPABILITIES],
		});
		expect(payload.timestamp).toBe('2026-04-16T12:34:56.000Z');
	});

	it('falls back to unknown release metadata when release env is absent', () => {
		const payload = buildHealthPayload({
			baseUrl: 'https://MassageIthaca.as.me',
			hasCoupon: false,
			headless: true,
			staticServices: 0,
			serviceCacheTtlMs: 300000,
			timestamp: '2026-04-16T12:34:56.000Z',
		});

		expect(payload.releaseSha).toBe('unknown');
		expect(payload.releaseRef).toBe('unknown');
		expect(payload.releaseVersion).toBe('unknown');
		expect(payload.releaseBuiltAt).toBeNull();
		expect(payload.release).toEqual({
			sha: 'unknown',
			ref: 'unknown',
			version: 'unknown',
			builtAt: null,
			modalEnvironment: null,
		});
	});
});
