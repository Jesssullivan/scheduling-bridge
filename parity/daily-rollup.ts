// parity/daily-rollup.ts
// Note: T20's NDJSON carries `service`, `date`, `modalCount`, `k8sCount` as structured fields.
// A future `rollupByService(lines, date)` can aggregate per-service without schema migration.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export interface DailyRollup {
  date: string;
  runs: number;
  ok: number;
  warn: number;
  critical: number;
}

/**
 * Aggregate NDJSON journal lines for a single date into a DailyRollup.
 * Malformed JSON and lines with unrecognized/missing `level` fields are skipped silently.
 */
export const rollupJournalLines = (lines: string[], date: string): DailyRollup => {
  let runs = 0;
  let ok = 0;
  let warn = 0;
  let critical = 0;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // malformed JSON — skip silently
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('level' in parsed)
    ) {
      continue;
    }

    const level = (parsed as Record<string, unknown>)['level'];
    if (level === 'OK') {
      runs++;
      ok++;
    } else if (level === 'WARN') {
      runs++;
      warn++;
    } else if (level === 'CRITICAL') {
      runs++;
      critical++;
    }
    // Unrecognized level values are skipped silently
  }

  return { date, runs, ok, warn, critical };
};

// CLI entry point (skip in tests / library import)
if (import.meta.url === `file://${process.argv[1]}`) {
  (async (): Promise<void> => {
    const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);

    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const lines: string[] = [];
    for await (const line of rl) {
      lines.push(line);
    }

    const rollup = rollupJournalLines(lines, date);

    // Write to paper/data/phase1/<date>.json relative to CWD
    const outDir = join(process.cwd(), 'paper', 'data', 'phase1');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `${date}.json`);
    writeFileSync(outPath, JSON.stringify(rollup, null, 2) + '\n');

    console.log(`Wrote ${outPath}`);
    console.log(JSON.stringify(rollup));
  })().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
