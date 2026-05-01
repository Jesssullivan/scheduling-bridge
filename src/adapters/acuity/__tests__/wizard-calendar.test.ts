import { describe, it, expect } from 'vitest';
import { MONTH_NAMES, parseYearMonthKey } from '../wizard-calendar.js';

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

describe('parseYearMonthKey', () => {
	it('parses a YYYY-MM key to zero-based calendar month', () => {
		expect(parseYearMonthKey('2026-07')).toEqual({ year: 2026, month: 6 });
	});

	it('rejects malformed or out-of-range month keys', () => {
		expect(parseYearMonthKey('2026-7')).toBeNull();
		expect(parseYearMonthKey('2026-00')).toBeNull();
		expect(parseYearMonthKey('2026-13')).toBeNull();
		expect(parseYearMonthKey('july-2026')).toBeNull();
	});
});
