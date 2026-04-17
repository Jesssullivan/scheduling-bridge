import { describe, expect, it } from 'vitest';
import { rollupJournalLines } from './daily-rollup.js';

describe('rollupJournalLines', () => {
  it('counts diff levels + extracts scrape counts', () => {
    const lines = [
      JSON.stringify({ ts: '2026-05-01T10:00:00Z', level: 'OK',       detail: 'drift=0' }),
      JSON.stringify({ ts: '2026-05-01T10:10:00Z', level: 'OK',       detail: 'drift=1' }),
      JSON.stringify({ ts: '2026-05-01T10:20:00Z', level: 'WARN',     detail: 'drift=4' }),
      JSON.stringify({ ts: '2026-05-01T10:30:00Z', level: 'CRITICAL', detail: 'drift=7' }),
    ];
    const result = rollupJournalLines(lines, '2026-05-01');
    expect(result).toEqual({
      date: '2026-05-01',
      runs: 4,
      ok: 2,
      warn: 1,
      critical: 1,
    });
  });

  it('skips malformed JSON silently', () => {
    const lines = [
      JSON.stringify({ ts: '2026-05-01T09:00:00Z', level: 'OK', detail: 'drift=0' }),
      'not-valid-json',
      '{broken:',
    ];
    const result = rollupJournalLines(lines, '2026-05-01');
    expect(result).toEqual({
      date: '2026-05-01',
      runs: 1,
      ok: 1,
      warn: 0,
      critical: 0,
    });
  });

  it('returns zero counts for empty input', () => {
    const result = rollupJournalLines([], '2026-05-02');
    expect(result).toEqual({
      date: '2026-05-02',
      runs: 0,
      ok: 0,
      warn: 0,
      critical: 0,
    });
  });

  it('skips lines missing a recognized level field', () => {
    const lines = [
      JSON.stringify({ ts: '2026-05-01T10:00:00Z', level: 'OK',      detail: 'drift=0' }),
      JSON.stringify({ ts: '2026-05-01T10:05:00Z', detail: 'drift=0' }),   // no level
      JSON.stringify({ ts: '2026-05-01T10:10:00Z', level: 'UNKNOWN', detail: 'x' }), // unrecognized
    ];
    const result = rollupJournalLines(lines, '2026-05-01');
    expect(result).toEqual({
      date: '2026-05-01',
      runs: 1,
      ok: 1,
      warn: 0,
      critical: 0,
    });
  });
});
