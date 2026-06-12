import { describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import { assertJsonEncodableSpec, jsonEncodableViolations } from '../state-conformance.js';

describe('state-schema conformance (volatile-state fence)', () => {
	it('accepts specs that encode to JSON primitives/arrays/records only', () => {
		const spec = {
			name: Schema.String,
			count: Schema.Number,
			flag: Schema.Boolean,
			none: Schema.Null,
			when: Schema.DateFromString, // encodes to string — allowed
			tags: Schema.Array(Schema.String),
			pair: Schema.Tuple(Schema.String, Schema.Number),
			nested: Schema.Struct({
				inner: Schema.Union(Schema.String, Schema.Literal(42), Schema.Null),
			}),
			lookup: Schema.Record({ key: Schema.String, value: Schema.Number }),
			constrained: Schema.String.pipe(Schema.minLength(1)),
		};
		expect(jsonEncodableViolations(spec)).toEqual([]);
		expect(() => assertJsonEncodableSpec(spec)).not.toThrow();
	});

	it('rejects Schema.Any (the AnyKeyword escape hatch)', () => {
		const violations = jsonEncodableViolations({ smuggled: Schema.Any });
		expect(violations).toEqual([{ key: 'smuggled', path: '$', tag: 'AnyKeyword' }]);
		expect(() => assertJsonEncodableSpec({ smuggled: Schema.Any })).toThrow(/AnyKeyword/);
	});

	it('rejects Schema.declare (the Declaration escape hatch that can wrap an ElementHandle)', () => {
		const elementHandleLike = Schema.declare(
			(input): input is { click: () => void } =>
				typeof input === 'object' && input !== null && 'click' in input,
		);
		const violations = jsonEncodableViolations({ element: elementHandleLike });
		expect(violations).toEqual([{ key: 'element', path: '$', tag: 'Declaration' }]);
	});

	it('rejects volatile constructs nested inside otherwise-plain structures', () => {
		const spec = {
			payload: Schema.Struct({
				ok: Schema.String,
				bad: Schema.Array(Schema.Unknown),
			}),
		};
		const violations = jsonEncodableViolations(spec);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatchObject({ key: 'payload', tag: 'UnknownKeyword' });
		expect(violations[0].path).toContain('.bad');
	});

	it('rejects non-JSON keywords (bigint, undefined, object, instanceOf declarations)', () => {
		expect(jsonEncodableViolations({ big: Schema.BigIntFromSelf })[0]?.tag).toBe('BigIntKeyword');
		expect(jsonEncodableViolations({ undef: Schema.Undefined })[0]?.tag).toBe('UndefinedKeyword');
		expect(jsonEncodableViolations({ obj: Schema.Object })[0]?.tag).toBe('ObjectKeyword');
		expect(jsonEncodableViolations({ date: Schema.instanceOf(Date) })[0]?.tag).toBe('Declaration');
	});
});
