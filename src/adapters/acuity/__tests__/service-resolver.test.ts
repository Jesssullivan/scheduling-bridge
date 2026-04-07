import { describe, it, expect } from 'vitest';
import { normalize, tokenOverlap, levenshtein, fuzzyConfidence } from '../service-resolver.js';

describe('normalize', () => {
	it('lowercases', () => {
		expect(normalize('URGENT Care')).toBe('urgent care');
	});

	it('strips punctuation', () => {
		expect(normalize('TMD: single session (30 min)')).toBe('tmd single session 30 min');
	});

	it('collapses whitespace', () => {
		expect(normalize('TMD  Tune   up')).toBe('tmd tune up');
	});

	it('trims', () => {
		expect(normalize('  hello  ')).toBe('hello');
	});

	it('strips asterisks', () => {
		expect(normalize('*(most popular)')).toBe('most popular');
	});

	it('handles empty string', () => {
		expect(normalize('')).toBe('');
	});
});

describe('tokenOverlap', () => {
	it('returns 1 for identical strings', () => {
		expect(tokenOverlap('foo bar', 'foo bar')).toBe(1);
	});

	it('returns 0 for no overlap', () => {
		expect(tokenOverlap('foo bar', 'baz qux')).toBe(0);
	});

	it('scores partial overlap', () => {
		// "cervical massage" vs "cervical medical massage 30" => 2/4 = 0.5
		expect(tokenOverlap('Cervical Massage', 'Cervical Medical Massage 30')).toBeCloseTo(0.5, 1);
	});

	it('handles case insensitivity via normalize', () => {
		expect(tokenOverlap('TMD Tune Up', 'tmd tune up')).toBe(1);
	});

	it('returns 0 for empty strings', () => {
		expect(tokenOverlap('', 'foo')).toBe(0);
		expect(tokenOverlap('foo', '')).toBe(0);
	});

	it('handles punctuation differences', () => {
		// "TMD: single session (30 min)" => tokens: [tmd, single, session, 30, min]
		// "TMD single session 30 min" => tokens: [tmd, single, session, 30, min]
		expect(tokenOverlap('TMD: single session (30 min)', 'TMD single session 30 min')).toBe(1);
	});
});

describe('levenshtein', () => {
	it('returns 0 for identical strings', () => {
		expect(levenshtein('foo', 'foo')).toBe(0);
	});

	it('returns length for empty vs non-empty', () => {
		expect(levenshtein('', 'abc')).toBe(3);
		expect(levenshtein('abc', '')).toBe(3);
	});

	it('returns 1 for single edit', () => {
		expect(levenshtein('cat', 'car')).toBe(1);
	});

	it('handles insertions', () => {
		expect(levenshtein('abc', 'abcd')).toBe(1);
	});

	it('handles deletions', () => {
		expect(levenshtein('abcd', 'abc')).toBe(1);
	});

	it('computes known distance', () => {
		expect(levenshtein('kitten', 'sitting')).toBe(3);
	});
});

describe('fuzzyConfidence', () => {
	it('returns 1 for identical strings', () => {
		expect(fuzzyConfidence('hello', 'hello')).toBe(1);
	});

	it('returns 1 for case-different strings', () => {
		expect(fuzzyConfidence('Hello', 'hello')).toBe(1);
	});

	it('returns high confidence for close strings', () => {
		const conf = fuzzyConfidence('TMD Tune up', 'TMD Tune-up');
		expect(conf).toBeGreaterThan(0.8);
	});

	it('returns low confidence for very different strings', () => {
		const conf = fuzzyConfidence('abc', 'xyz');
		expect(conf).toBeLessThan(0.5);
	});

	it('returns 0 for empty strings', () => {
		expect(fuzzyConfidence('', '')).toBe(0);
	});
});

describe('real-world service name matching', () => {
	const acuityNames = [
		'URGENT Care Massage (Same or Next day care)',
		'TMD 1st Consultation & Session',
		'TMD: single session (30 min)',
		'TMD: double session (60 minutes)',
		'TMD Tune up (75 min)',
		'Cervical Medical Massage 30 minutes',
		'Targeted treatment session 45 minutes *(most popular)',
		'Extended treatment 60 minutes',
		'Comprehensive treatment 75 minutes',
		'Targeted pain relief (45 min)',
	];

	it('normalized exact catches case/punctuation differences', () => {
		const target = normalize('TMD 1st Consultation & Session');
		expect(target).toBe('tmd 1st consultation session');
		const match = acuityNames.find((n) => normalize(n) === target);
		expect(match).toBe('TMD 1st Consultation & Session');
	});

	it('token overlap catches partial name matches', () => {
		// "URGENT Care Massage" vs full name has 3 shared tokens out of 8 unique => ~0.43
		// This is below the 0.6 threshold, demonstrating why we need fuzzy as a fallback
		const score = tokenOverlap('URGENT Care Massage', acuityNames[0]);
		expect(score).toBeGreaterThan(0.3);
		expect(score).toBeLessThan(0.6);

		// But with more tokens, overlap is higher
		const score2 = tokenOverlap('URGENT Care Massage Same day', acuityNames[0]);
		expect(score2).toBeGreaterThan(0.5);
	});

	it('token overlap catches slug-derived names', () => {
		// slug "cervical-30" -> "cervical 30"
		const score = tokenOverlap('cervical 30', 'Cervical Medical Massage 30 minutes');
		expect(score).toBeGreaterThan(0.3); // will be low but non-zero
	});

	it('fuzzy catches minor spelling differences', () => {
		const conf = fuzzyConfidence('TMD Tune up', 'TMD Tune up (75 min)');
		expect(conf).toBeGreaterThan(0.5);
	});

	it('picks best match from candidates', () => {
		const target = 'TMD single session';
		let best = '';
		let bestScore = 0;
		for (const name of acuityNames) {
			const score = tokenOverlap(target, name);
			if (score > bestScore) {
				bestScore = score;
				best = name;
			}
		}
		expect(best).toBe('TMD: single session (30 min)');
	});
});
