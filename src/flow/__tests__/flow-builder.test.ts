import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { FlowValidationError, makeFlow, type FlowBuilder } from '../flow.js';
import { makeStep, spec, type Spec } from './helpers.js';

const identity = { flowId: 'booking_create_with_payment', backend: 'acuity', version: '1.0.0' } as const;

const navigate = makeStep({
	id: 'acuity/navigate',
	needs: ['bookingRef'],
	provides: ['navResult'],
	expects: ['acuity:client-form'],
	run: () => Effect.succeed({ state: { navResult: 'ok' } }),
});

const fill = makeStep({
	id: 'acuity/fill-form',
	needs: ['navResult'],
	provides: ['formResult'],
	run: () => Effect.succeed({ state: { formResult: 'ok' } }),
});

describe('FlowBuilder', () => {
	it('derives a validated, hashed plan from step definitions', () => {
		const flow = makeFlow(spec, ['bookingRef'])
			.add(navigate)
			.add(fill)
			.recover('acuity/navigate', { to: 'acuity/navigate' })
			.build(identity);

		expect(flow.plan.flowId).toBe('booking_create_with_payment');
		expect(flow.plan.nodes.map((n) => n.stepId)).toEqual(['acuity/navigate', 'acuity/fill-form']);
		expect(flow.plan.nodes[1].dependsOn).toEqual(['acuity/navigate']);
		expect(flow.plan.nodes[0].recoveries).toEqual([{ to: 'acuity/navigate', maxReentries: 1 }]);
		expect(flow.planHash).toMatch(/^[0-9a-f]{64}$/);
		expect(flow.steps.get('acuity/fill-form')).toBe(fill);
		expect(flow.initialKeys).toEqual(['bookingRef']);
		expect(Object.isFrozen(flow.plan)).toBe(true);
	});

	it('rejects unmet needs at runtime (the backstop behind the type-level accumulator)', () => {
		// Bypass the compile-time Provided accumulator deliberately.
		const builder = makeFlow(spec) as FlowBuilder<Spec, keyof Spec & string, never, never>;
		expect(() => builder.add(fill).build(identity)).toThrow(FlowValidationError);
		expect(() => builder.add(fill).build(identity)).toThrow(/needs 'navResult'/);
	});

	it('rejects non-contiguous segments', () => {
		const segA1 = makeStep({
			id: 'a1',
			needs: [],
			provides: ['navResult'],
			segment: 'seg-a',
			run: () => Effect.succeed({ state: { navResult: 'ok' } }),
		});
		const segB = makeStep({
			id: 'b1',
			needs: [],
			provides: ['formResult'],
			segment: 'seg-b',
			run: () => Effect.succeed({ state: { formResult: 'ok' } }),
		});
		const segA2 = makeStep({
			id: 'a2',
			needs: [],
			provides: ['confirmation'],
			segment: 'seg-a',
			run: () => Effect.succeed({ state: { confirmation: 'ok' } }),
		});
		expect(() => makeFlow(spec).add(segA1).add(segB).add(segA2).build(identity)).toThrow(
			/not contiguous/,
		);
	});

	it('rejects recovery edges referencing unknown steps', () => {
		expect(() =>
			makeFlow(spec, ['bookingRef'])
				.add(navigate)
				.recover('acuity/navigate', { to: 'ghost' })
				.build(identity),
		).toThrow(/unknown step 'ghost'/);
		expect(() =>
			makeFlow(spec, ['bookingRef'])
				.add(navigate)
				.recover('ghost', { to: 'acuity/navigate' })
				.build(identity),
		).toThrow(/from unknown step 'ghost'/);
	});

	it('rejects duplicate step ids', () => {
		expect(() => makeFlow(spec, ['bookingRef']).add(navigate).add(navigate).build(identity)).toThrow(
			/duplicate stepId/,
		);
	});

	it('produces identical hashes for identical definitions and different hashes for different shapes', () => {
		const build = () => makeFlow(spec, ['bookingRef']).add(navigate).add(fill).build(identity);
		expect(build().planHash).toBe(build().planHash);
		const reduced = makeFlow(spec, ['bookingRef']).add(navigate).build(identity);
		expect(reduced.planHash).not.toBe(build().planHash);
	});
});
