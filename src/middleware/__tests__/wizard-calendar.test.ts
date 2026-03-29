import { describe, it, expect } from 'vitest';
import { MONTH_NAMES } from '../wizard-calendar.js';

describe('MONTH_NAMES', () => {
	it('has 12 entries', () => {
		expect(MONTH_NAMES).toHaveLength(12);
	});

	it('starts with january', () => {
		expect(MONTH_NAMES[0]).toBe('january');
	});

	it('ends with december', () => {
		expect(MONTH_NAMES[11]).toBe('december');
	});

	it('all lowercase', () => {
		for (const m of MONTH_NAMES) {
			expect(m).toBe(m.toLowerCase());
		}
	});

	it('indexOf works for month lookup', () => {
		expect(MONTH_NAMES.indexOf('march')).toBe(2);
		expect(MONTH_NAMES.indexOf('december')).toBe(11);
		expect(MONTH_NAMES.indexOf('invalid')).toBe(-1);
	});
});
