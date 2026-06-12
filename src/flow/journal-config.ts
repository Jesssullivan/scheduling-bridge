/**
 * Flow journal retention configuration.
 *
 * Design: docs/design/flow-dag-formalization.md §4 storage layout / risk 1 —
 * journal retention is a dedicated knob, deliberately DECOUPLED from the job-record
 * TTL (`BRIDGE_REDIS_ASYNC_JOB_TTL_SECONDS`): checkpoint rows are reconciliation
 * evidence and must be able to outlive the job record they explain.
 *
 * Parser shape mirrors `src/async/config.ts` (`parseRedisAsyncJobTtlSeconds`).
 */

/**
 * Default journal retention: 14 days (twice the 7-day job-record TTL), so
 * `reconcile_required` triage evidence survives past job-record expiry.
 * Tuning from production volume is a 0.8.0 item (design §10).
 */
export const DEFAULT_FLOW_JOURNAL_TTL_SECONDS = 14 * 24 * 60 * 60;

export const parseFlowJournalTtlSeconds = (
	env: Partial<Record<'BRIDGE_FLOW_JOURNAL_TTL_SECONDS', string>> = process.env,
): number | undefined => {
	const raw = env.BRIDGE_FLOW_JOURNAL_TTL_SECONDS;
	if (!raw) return undefined;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return Math.floor(parsed);
};
