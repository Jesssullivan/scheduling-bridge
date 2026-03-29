import { describe, it, expect } from 'vitest';
import { parseSlotText, buildIsoDatetime } from '../slot-parser.js';

describe('parseSlotText', () => {
	it('parses time with spots left', () => {
		expect(parseSlotText('4:00 PM1 spot left')).toEqual({ time: '4:00 PM', spotsLeft: 1 });
	});

	it('parses time with multiple spots', () => {
		expect(parseSlotText('2:30 PM3 spots left')).toEqual({ time: '2:30 PM', spotsLeft: 3 });
	});

	it('parses time without spots indicator', () => {
		expect(parseSlotText('10:00 AM')).toEqual({ time: '10:00 AM', spotsLeft: null });
	});

	it('handles leading/trailing whitespace', () => {
		expect(parseSlotText('  9:00 AM  ')).toEqual({ time: '9:00 AM', spotsLeft: null });
	});

	it('returns null for empty string', () => {
		expect(parseSlotText('')).toBeNull();
	});

	it('returns null for whitespace-only string', () => {
		expect(parseSlotText('   ')).toBeNull();
	});

	it('returns null for non-time text', () => {
		expect(parseSlotText('No slots available')).toBeNull();
	});

	it('handles noon', () => {
		expect(parseSlotText('12:00 PM')).toEqual({ time: '12:00 PM', spotsLeft: null });
	});

	it('handles midnight', () => {
		expect(parseSlotText('12:00 AM')).toEqual({ time: '12:00 AM', spotsLeft: null });
	});

	it('handles compact AM/PM without space', () => {
		expect(parseSlotText('4:00PM1 spot left')).toEqual({ time: '4:00PM', spotsLeft: 1 });
	});
});

describe('buildIsoDatetime', () => {
	it('converts AM time', () => {
		expect(buildIsoDatetime('2026-03-15', '10:00 AM')).toBe('2026-03-15T10:00:00');
	});

	it('converts PM time', () => {
		expect(buildIsoDatetime('2026-03-15', '4:00 PM')).toBe('2026-03-15T16:00:00');
	});

	it('handles noon (12 PM)', () => {
		expect(buildIsoDatetime('2026-03-15', '12:00 PM')).toBe('2026-03-15T12:00:00');
	});

	it('handles midnight (12 AM)', () => {
		expect(buildIsoDatetime('2026-03-15', '12:00 AM')).toBe('2026-03-15T00:00:00');
	});

	it('handles single-digit hour', () => {
		expect(buildIsoDatetime('2026-03-15', '9:30 AM')).toBe('2026-03-15T09:30:00');
	});

	it('handles 11 PM', () => {
		expect(buildIsoDatetime('2026-03-15', '11:45 PM')).toBe('2026-03-15T23:45:00');
	});

	it('defaults to midnight for unparseable time', () => {
		expect(buildIsoDatetime('2026-03-15', 'invalid')).toBe('2026-03-15T00:00:00');
	});
});
