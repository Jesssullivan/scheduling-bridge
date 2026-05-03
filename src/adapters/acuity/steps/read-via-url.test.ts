import { describe, expect, it } from 'vitest';

import { dateEmptySettleTimeoutMs, urlReadNetworkIdleTimeoutMs } from './read-via-url.js';

describe('URL read timing config', () => {
	it('uses a short network-idle settle by default', () => {
		expect(urlReadNetworkIdleTimeoutMs(30_000, {})).toBe(1500);
	});

	it('honors explicit network-idle settle config including zero', () => {
		expect(urlReadNetworkIdleTimeoutMs(30_000, { ACUITY_URL_READ_NETWORK_IDLE_MS: '750' })).toBe(750);
		expect(urlReadNetworkIdleTimeoutMs(30_000, { ACUITY_URL_READ_NETWORK_IDLE_MS: '0' })).toBe(0);
	});

	it('never exceeds the caller operation timeout', () => {
		expect(urlReadNetworkIdleTimeoutMs(500, { ACUITY_URL_READ_NETWORK_IDLE_MS: '2000' })).toBe(500);
	});

	it('falls back when the env value is invalid', () => {
		expect(urlReadNetworkIdleTimeoutMs(30_000, { ACUITY_URL_READ_NETWORK_IDLE_MS: 'nope' })).toBe(1500);
	});
});

describe('date empty settle timing config', () => {
	it('waits briefly for enabled dates by default', () => {
		expect(dateEmptySettleTimeoutMs(30_000, {})).toBe(2500);
	});

	it('honors explicit empty-date settle config including zero', () => {
		expect(dateEmptySettleTimeoutMs(30_000, { ACUITY_EMPTY_DATE_SETTLE_MS: '1000' })).toBe(1000);
		expect(dateEmptySettleTimeoutMs(30_000, { ACUITY_EMPTY_DATE_SETTLE_MS: '0' })).toBe(0);
	});

	it('never exceeds the caller operation timeout', () => {
		expect(dateEmptySettleTimeoutMs(500, { ACUITY_EMPTY_DATE_SETTLE_MS: '2500' })).toBe(500);
	});

	it('falls back when the empty-date settle env value is invalid', () => {
		expect(dateEmptySettleTimeoutMs(30_000, { ACUITY_EMPTY_DATE_SETTLE_MS: 'nope' })).toBe(2500);
	});
});
