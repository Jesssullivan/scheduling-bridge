/**
 * Compatibility re-exports for the date matcher surface.
 *
 * The implementation lives in `@tummycrypt/scheduling-kit/fuzzy`; bridge keeps
 * this module as a stable import path for flow and adapter code.
 */

export {
	DEFAULT_DATE_MIN_CONFIDENCE,
	DateMatcher,
	DateMatcherLive,
	MONTH_NAMES,
	makeDateMatcher,
	matchSlotMembership,
	parseMonthLabel,
	parseYearMonthKey,
	scoreMonthTarget,
	scoreSlot,
	stripTzSuffix,
	type CalendarMonth,
	type DateMatchQuery,
	type SlotCandidate,
} from '@tummycrypt/scheduling-kit/fuzzy';
