export interface SlotReadPhaseTimings {
	readonly navigationMs: number;
	readonly calendarReadyMs: number;
	readonly dateSelectMs: number;
	readonly postClickSettleMs: number;
	readonly slotWaitMs: number;
	readonly slotDomReadMs: number;
	readonly parseMs: number;
}

export interface SlotReadProfile {
	readonly serviceId: string;
	readonly date: string;
	readonly totalMs: number;
	readonly thresholdMs: number;
	readonly longTail: boolean;
	readonly calendarTileCount: number;
	readonly matchedDateFound: boolean;
	readonly slotCount: number;
	readonly parsedSlotCount: number;
	readonly unparsedSlotCount: number;
	readonly phases: SlotReadPhaseTimings;
}

export interface SlotReadProfileConfig {
	readonly thresholdMs: number;
	readonly forceLog: boolean;
}

const DEFAULT_THRESHOLD_MS = 1500;
const FORCE_LOG_VALUES = new Set(['1', 'true', 'yes', 'on']);

export const getSlotReadProfileConfig = (
	env: Record<string, string | undefined> = process.env,
): SlotReadProfileConfig => {
	const parsedThreshold = Number.parseInt(env.SCHEDULING_BRIDGE_SLOT_PROFILE_THRESHOLD_MS ?? '', 10);

	return {
		thresholdMs:
			Number.isFinite(parsedThreshold) && parsedThreshold > 0
				? parsedThreshold
				: DEFAULT_THRESHOLD_MS,
		forceLog: FORCE_LOG_VALUES.has((env.SCHEDULING_BRIDGE_PROFILE_SLOT_READS ?? '').toLowerCase()),
	};
};

export interface CreateSlotReadProfileInput {
	readonly serviceId: string;
	readonly date: string;
	readonly thresholdMs: number;
	readonly calendarTileCount: number;
	readonly matchedDateFound: boolean;
	readonly slotCount: number;
	readonly parsedSlotCount: number;
	readonly phases: SlotReadPhaseTimings;
}

export const createSlotReadProfile = (
	input: CreateSlotReadProfileInput,
): SlotReadProfile => {
	const totalMs =
		input.phases.navigationMs +
		input.phases.calendarReadyMs +
		input.phases.dateSelectMs +
		input.phases.postClickSettleMs +
		input.phases.slotWaitMs +
		input.phases.slotDomReadMs +
		input.phases.parseMs;

	return {
		serviceId: input.serviceId,
		date: input.date,
		totalMs,
		thresholdMs: input.thresholdMs,
		longTail: totalMs >= input.thresholdMs,
		calendarTileCount: input.calendarTileCount,
		matchedDateFound: input.matchedDateFound,
		slotCount: input.slotCount,
		parsedSlotCount: input.parsedSlotCount,
		unparsedSlotCount: Math.max(0, input.slotCount - input.parsedSlotCount),
		phases: input.phases,
	};
};

export const shouldLogSlotReadProfile = (
	profile: SlotReadProfile,
	config: SlotReadProfileConfig,
): boolean => config.forceLog || profile.longTail;

export const formatSlotReadProfileLog = (profile: SlotReadProfile): string =>
	`[availability/slots][profile] ${JSON.stringify(profile)}`;
