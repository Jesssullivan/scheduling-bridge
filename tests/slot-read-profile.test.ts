import { describe, expect, it } from 'vitest';
import {
	buildSlotReadProfileEvent,
	createSlotReadProfile,
	formatSlotReadProfileLog,
	getSlotReadProfileConfig,
	shouldLogSlotReadProfile,
} from '../src/adapters/acuity/steps/slot-read-profile.js';

describe('slot read profiling helpers', () => {
	it('builds a long-tail profile with phase totals and parsed counts', () => {
		const profile = createSlotReadProfile({
			serviceId: '53178494',
			date: '2026-04-25',
			thresholdMs: 1500,
			calendarTileCount: 28,
			matchedDateFound: true,
			slotCount: 4,
			parsedSlotCount: 3,
			phases: {
				navigationMs: 900,
				calendarReadyMs: 40,
				dateSelectMs: 120,
				postClickSettleMs: 2000,
				slotWaitMs: 300,
				slotDomReadMs: 180,
				parseMs: 10,
			},
		});

		expect(profile.totalMs).toBe(3550);
		expect(profile.longTail).toBe(true);
		expect(profile.unparsedSlotCount).toBe(1);
		expect(profile.matchedDateFound).toBe(true);
		expect(profile.phases.postClickSettleMs).toBe(2000);
	});

	it('preserves request-scoped context in emitted profile events', () => {
		const profile = createSlotReadProfile({
			serviceId: '53178494',
			date: '2026-04-25',
			thresholdMs: 1500,
			calendarTileCount: 28,
			matchedDateFound: true,
			slotCount: 4,
			parsedSlotCount: 4,
			phases: {
				navigationMs: 900,
				calendarReadyMs: 40,
				dateSelectMs: 120,
				postClickSettleMs: 2000,
				slotWaitMs: 300,
				slotDomReadMs: 180,
				parseMs: 10,
			},
			context: {
				requestId: 'req-123',
				endpoint: 'availability_slots',
				flowOwner: 'scheduling-bridge',
				releaseVersion: '0.4.2',
			},
		});

		const event = buildSlotReadProfileEvent(profile);

		expect(event.event).toBe('slot_read_profile');
		expect(event.context?.requestId).toBe('req-123');
		expect(event.context?.endpoint).toBe('availability_slots');
		expect(event.context?.flowOwner).toBe('scheduling-bridge');
	});

	it('reads threshold and force-log config from env', () => {
		const config = getSlotReadProfileConfig({
			SCHEDULING_BRIDGE_SLOT_PROFILE_THRESHOLD_MS: '2200',
			SCHEDULING_BRIDGE_PROFILE_SLOT_READS: 'true',
		});

		expect(config.thresholdMs).toBe(2200);
		expect(config.forceLog).toBe(true);
	});

	it('falls back to defaults when env values are absent or invalid', () => {
		const config = getSlotReadProfileConfig({
			SCHEDULING_BRIDGE_SLOT_PROFILE_THRESHOLD_MS: 'nope',
			SCHEDULING_BRIDGE_PROFILE_SLOT_READS: '0',
		});

		expect(config.thresholdMs).toBe(1500);
		expect(config.forceLog).toBe(false);
	});

	it('only logs non-long-tail reads when force logging is enabled', () => {
		const profile = createSlotReadProfile({
			serviceId: '53178494',
			date: '2026-04-15',
			thresholdMs: 1500,
			calendarTileCount: 21,
			matchedDateFound: true,
			slotCount: 2,
			parsedSlotCount: 2,
			phases: {
				navigationMs: 200,
				calendarReadyMs: 30,
				dateSelectMs: 40,
				postClickSettleMs: 250,
				slotWaitMs: 50,
				slotDomReadMs: 20,
				parseMs: 5,
			},
		});

		expect(shouldLogSlotReadProfile(profile, { thresholdMs: 1500, forceLog: false })).toBe(false);
		expect(shouldLogSlotReadProfile(profile, { thresholdMs: 1500, forceLog: true })).toBe(true);
		expect(formatSlotReadProfileLog(profile)).toContain('[availability/slots][profile]');
		expect(formatSlotReadProfileLog(profile)).toContain('"event":"slot_read_profile"');
	});
});
