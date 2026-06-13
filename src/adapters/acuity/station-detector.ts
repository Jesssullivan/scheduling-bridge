/**
 * Acuity station detector — physically extracted standalone module behind the
 * VendorFlowPack (design §7 / §10-0.7.0; "station detectors become standalone
 * modules"). TIN-2094 (Lane B).
 *
 * This module owns the Acuity fuzzy-out landing detection:
 *   - `detectLandingStep` — the bare-label probe cascade
 *     (firstNameInput → timeSlot → calendarDay → serviceList), previously
 *     module-private in steps/navigate.ts and consumed by `navigateToBooking`;
 *   - `detectAcuityStation` — the same cascade producing a typed
 *     `LandingObservation` with per-probe `StationEvidence`, previously inlined
 *     in flow-pack.ts and consumed as the pack's `detectStation`.
 *
 * Both are byte-identical to their pre-extraction bodies (probe order, key map,
 * outcomes) — the move is physical only, so the trace-conformance harness is
 * unaffected. The detector reads selector chains from the (profile-composed)
 * registry; it names ZERO tenant specifics.
 */

import { Effect } from 'effect';
import type { Page } from 'playwright-core';
import { probe, probeSelector, Selectors } from './selector-registry.js';
import type { LandingObservation, StationEvidence, StationId } from '../../flow/station.js';

/**
 * Probe keys the station detector checks, in probe order (the
 * `detectLandingStep` cascade). Owned here (re-exported by flow-steps.ts) so the
 * detector has no dependency on flow-steps — avoiding the
 * flow-steps → steps/index → navigate → station-detector import cycle.
 */
export const LANDING_PROBE_KEYS = {
	'client-form': 'firstNameInput',
	'time-slots': 'timeSlot',
	calendar: 'calendarDay',
	'service-selection': 'serviceList',
} as const;

/**
 * Bare-label landing probe cascade. Probes in order
 * `firstNameInput → timeSlot → calendarDay → serviceList`, returning the first
 * matching station label or `'unknown'`. Moved verbatim from steps/navigate.ts.
 */
export const detectLandingStep = (
	page: Page,
): Effect.Effect<
	'client-form' | 'time-slots' | 'calendar' | 'service-selection' | 'unknown',
	never
> =>
	Effect.gen(function* () {
		const hasClientForm = yield* probe(page, 'firstNameInput');
		if (hasClientForm) return 'client-form' as const;

		const hasTimeSlots = yield* probe(page, 'timeSlot');
		if (hasTimeSlots) return 'time-slots' as const;

		const hasCalendar = yield* probe(page, 'calendarDay');
		if (hasCalendar) return 'calendar' as const;

		const hasServiceList = yield* probe(page, 'serviceList');
		if (hasServiceList) return 'service-selection' as const;

		return 'unknown' as const;
	});

/**
 * The pack's station detector: identical probe cascade and ordering
 * (firstNameInput → timeSlot → calendarDay → serviceList), returning a
 * `LandingObservation` with the full probe-evidence trail instead of a bare
 * label. `expected` is filled in by the runner from `StepMeta.expects`;
 * standalone detection reports an empty expectation. Moved verbatim from
 * flow-pack.ts.
 */
export const detectAcuityStation = (
	page: Page,
): Effect.Effect<LandingObservation, never, never> =>
	Effect.gen(function* () {
		const probes: readonly { station: StationId; key: string }[] = [
			{ station: 'acuity:client-form', key: LANDING_PROBE_KEYS['client-form'] },
			{ station: 'acuity:time-slots', key: LANDING_PROBE_KEYS['time-slots'] },
			{ station: 'acuity:calendar', key: LANDING_PROBE_KEYS.calendar },
			{
				station: 'acuity:service-selection',
				key: LANDING_PROBE_KEYS['service-selection'],
			},
		];
		const evidence: StationEvidence[] = [];
		for (const { station, key } of probes) {
			const matched = yield* probeSelector(
				page,
				(Selectors as Record<string, readonly string[]>)[key] ?? [],
			);
			evidence.push({ kind: 'selector', key, matched: matched !== null });
			if (matched !== null) {
				return {
					expected: [],
					observed: station,
					confidence: 1,
					evidence,
				} satisfies LandingObservation;
			}
		}
		return {
			expected: [],
			observed: 'unknown',
			confidence: 0,
			evidence,
		} satisfies LandingObservation;
	});
