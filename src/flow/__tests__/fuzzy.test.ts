import { describe, expect, it } from 'vitest';
import { Effect, Exit } from 'effect';
import {
	FuzzyMatchError,
	ServiceMatcher,
	ServiceMatcherLive,
	makeServiceMatcher,
	scoreLabel,
} from '../fuzzy.js';

const candidates = [
	{ label: 'Deep Tissue Massage', ref: '53178494' },
	{ label: 'Swedish Massage', ref: '11111111' },
	{ label: 'Acupuncture Consult', ref: '22222222' },
];

describe('scoreLabel cascade', () => {
	it('admits normalized-exact at 0.95 ahead of token overlap', () => {
		const score = scoreLabel('deep tissue massage!!', 'Deep Tissue Massage');
		expect(score).toEqual({ strategy: 'normalized-exact', confidence: 0.95 });
	});

	it('scales token overlap onto 0.5-0.9', () => {
		const score = scoreLabel('Deep Tissue', 'Deep Tissue Massage');
		expect(score.strategy).toBe('token-overlap');
		expect(score.confidence).toBeGreaterThanOrEqual(0.5);
		expect(score.confidence).toBeLessThanOrEqual(0.9);
	});

	it('scales Levenshtein fuzz onto 0.3-0.7 and floors hopeless queries at 0', () => {
		const fuzzy = scoreLabel('Massagee', 'Massage');
		expect(fuzzy.strategy).toBe('fuzzy');
		expect(fuzzy.confidence).toBeGreaterThanOrEqual(0.3);
		expect(fuzzy.confidence).toBeLessThanOrEqual(0.7);
		expect(scoreLabel('Yoga', 'Deep Tissue Massage').confidence).toBe(0);
	});
});

describe('makeServiceMatcher', () => {
	it('resolves by appointmentTypeId with confidence 1.0 (id-match)', async () => {
		const matcher = makeServiceMatcher();
		const resolution = await Effect.runPromise(
			matcher.match({ serviceName: 'whatever', appointmentTypeId: '53178494' }, candidates),
		);
		expect(resolution.strategy).toBe('id-match');
		expect(resolution.confidence).toBe(1.0);
		expect(resolution.value.ref).toBe('53178494');
		expect(resolution.alternates).toEqual([]);
	});

	it('falls through the cascade and reports alternates sorted by confidence', async () => {
		const matcher = makeServiceMatcher();
		const resolution = await Effect.runPromise(
			matcher.match({ serviceName: 'Deep Tissue Massage' }, candidates),
		);
		expect(resolution.strategy).toBe('normalized-exact');
		expect(resolution.matchedLabel).toBe('Deep Tissue Massage');
		expect(resolution.threshold).toBe(matcher.threshold);
		expect(resolution.alternates).toHaveLength(2);
		const confidences = resolution.alternates.map((a) => a.confidence);
		expect([...confidences].sort((a, b) => b - a)).toEqual(confidences);
	});

	it('fails with FuzzyMatchError when nothing clears the threshold', async () => {
		const matcher = makeServiceMatcher();
		const exit = await Effect.runPromiseExit(
			matcher.match({ serviceName: 'completely unrelated thing' }, candidates),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit) && exit.cause._tag === 'Fail') {
			expect(exit.cause.error).toBeInstanceOf(FuzzyMatchError);
			expect(exit.cause.error.threshold).toBe(matcher.threshold);
		}
	});

	it('keeps every admitted confidence within [threshold, 1]', async () => {
		const matcher = makeServiceMatcher();
		for (const query of ['Deep Tissue Massage', 'Deep Tissue', 'Swedish Massagee', 'acupuncture consult']) {
			const resolution = await Effect.runPromise(matcher.match({ serviceName: query }, candidates));
			expect(resolution.confidence).toBeGreaterThanOrEqual(matcher.threshold);
			expect(resolution.confidence).toBeLessThanOrEqual(1);
		}
	});

	it('is providable through the ServiceMatcherLive layer behind the scheduling-bridge tag', async () => {
		const resolution = await Effect.runPromise(
			Effect.gen(function* () {
				const matcher = yield* ServiceMatcher;
				return yield* matcher.match({ serviceName: 'Swedish Massage' }, candidates);
			}).pipe(Effect.provide(ServiceMatcherLive)),
		);
		expect(resolution.strategy).toBe('normalized-exact');
		expect(ServiceMatcher.key).toBe('scheduling-bridge/ServiceMatcher');
	});
});
