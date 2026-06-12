import { describe, expect, it } from 'vitest';
import { canonicalJson, computePlanHash, validateFlowPlan, type FlowPlan } from '../plan.js';

const node = (
	stepId: string,
	overrides: Partial<FlowPlan['nodes'][number]> = {},
): FlowPlan['nodes'][number] => ({
	stepId,
	needs: [],
	provides: [],
	dependsOn: [],
	expects: [],
	idempotency: 'read',
	segment: 'wizard',
	tags: ['read'],
	...overrides,
});

const plan = (nodes: FlowPlan['nodes']): FlowPlan => ({
	flowId: 'booking_create_with_payment',
	backend: 'acuity',
	version: '1.0.0',
	nodes,
});

describe('canonicalJson', () => {
	it('is independent of object key insertion order', () => {
		const a = { z: 1, a: { c: [1, 2], b: 'x' } };
		const b = { a: { b: 'x', c: [1, 2] }, z: 1 };
		expect(canonicalJson(a)).toBe(canonicalJson(b));
		expect(canonicalJson(a)).toBe('{"a":{"b":"x","c":[1,2]},"z":1}');
	});

	it('drops undefined properties and rejects non-JSON values', () => {
		expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
		expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
		expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
	});
});

describe('computePlanHash', () => {
	it('is stable for a fixed plan shape (pinned digest)', () => {
		const fixed = plan([
			node('acuity/navigate', { provides: ['navResult'], expects: ['acuity:client-form'] }),
			node('acuity/fill-form', {
				needs: ['navResult'],
				provides: ['formResult'],
				dependsOn: ['acuity/navigate'],
			}),
		]);
		const hash = computePlanHash(fixed);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		// Pinned: a hash change here IS a flow-shape change and must be reviewed as one.
		expect(hash).toBe(computePlanHash(JSON.parse(JSON.stringify(fixed)) as FlowPlan));
		expect(hash).toBe('13a3a31c625b181a6a54721e44470aff0ff6a4d3ddfbaf057cdc7ec672ebea33');
	});

	it('does not depend on property insertion order', () => {
		const orderedOneWay = plan([node('a')]);
		const orderedOtherWay = JSON.parse(
			JSON.stringify(orderedOneWay, ['nodes', 'version', 'backend', 'flowId', 'stepId', 'tags', 'segment', 'idempotency', 'expects', 'dependsOn', 'provides', 'needs']),
		) as FlowPlan;
		expect(computePlanHash(orderedOtherWay)).toBe(computePlanHash(orderedOneWay));
	});
});

describe('validateFlowPlan', () => {
	it('accepts a well-formed plan', () => {
		const ok = plan([
			node('a', { provides: ['x'] }),
			node('b', { needs: ['x'], dependsOn: ['a'] }),
		]);
		expect(validateFlowPlan(ok, [])).toEqual([]);
	});

	it('rejects forward-edge cycles', () => {
		const cyclic = plan([
			node('a', { needs: ['y'], provides: ['x'], dependsOn: ['b'] }),
			node('b', { needs: ['x'], provides: ['y'], dependsOn: ['a'] }),
		]);
		const violations = validateFlowPlan(cyclic, ['x', 'y']);
		expect(violations.some((v) => v.includes('forward-edge cycle'))).toBe(true);
	});

	it('rejects unmet needs, unknown dependsOn, and bad recovery edges', () => {
		const bad = plan([
			node('a', { needs: ['missing'], dependsOn: ['ghost'], recoveries: [{ to: 'nowhere', maxReentries: 0 }] }),
		]);
		const violations = validateFlowPlan(bad, []);
		expect(violations.some((v) => v.includes("needs 'missing'"))).toBe(true);
		expect(violations.some((v) => v.includes("unknown step 'ghost'"))).toBe(true);
		expect(violations.some((v) => v.includes("unknown step 'nowhere'"))).toBe(true);
		expect(violations.some((v) => v.includes('invalid maxReentries'))).toBe(true);
	});

	it('rejects non-contiguous segments and duplicate stepIds', () => {
		const bad = plan([
			node('a', { segment: 's1' }),
			node('b', { segment: 's2' }),
			node('a', { segment: 's1' }),
		]);
		const violations = validateFlowPlan(bad, []);
		expect(violations.some((v) => v.includes('not contiguous'))).toBe(true);
		expect(violations.some((v) => v.includes("duplicate stepId 'a'"))).toBe(true);
	});
});
