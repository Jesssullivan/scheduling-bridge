import { describe, expect, it } from 'vitest';
import {
	DEFAULT_FLOW_JOURNAL_TTL_SECONDS,
	parseFlowJournalTtlSeconds,
} from '../journal-config.js';
import { DEFAULT_REDIS_ASYNC_JOB_TTL_SECONDS } from '../../async/config.js';

describe('flow journal config', () => {
	it('leaves journal TTL unset when no env override is configured', () => {
		expect(parseFlowJournalTtlSeconds({})).toBeUndefined();
		expect(DEFAULT_FLOW_JOURNAL_TTL_SECONDS).toBe(1209600);
	});

	it('is a dedicated knob, decoupled from the job-record TTL', () => {
		expect(DEFAULT_FLOW_JOURNAL_TTL_SECONDS).not.toBe(
			DEFAULT_REDIS_ASYNC_JOB_TTL_SECONDS,
		);
	});

	it('parses positive journal TTL seconds from env', () => {
		expect(
			parseFlowJournalTtlSeconds({ BRIDGE_FLOW_JOURNAL_TTL_SECONDS: '900' }),
		).toBe(900);
		expect(
			parseFlowJournalTtlSeconds({ BRIDGE_FLOW_JOURNAL_TTL_SECONDS: '90.9' }),
		).toBe(90);
	});

	it('ignores invalid journal TTL env values so the default applies', () => {
		expect(
			parseFlowJournalTtlSeconds({ BRIDGE_FLOW_JOURNAL_TTL_SECONDS: '0' }),
		).toBeUndefined();
		expect(
			parseFlowJournalTtlSeconds({ BRIDGE_FLOW_JOURNAL_TTL_SECONDS: '-1' }),
		).toBeUndefined();
		expect(
			parseFlowJournalTtlSeconds({ BRIDGE_FLOW_JOURNAL_TTL_SECONDS: 'nope' }),
		).toBeUndefined();
	});
});
