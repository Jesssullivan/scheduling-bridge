/**
 * Volatile-state fence (c): the design (docs/design/flow-dag-formalization.md §4, risk 2)
 * calls for an ESLint ban on `Schema.declare`/`Schema.Any` in flow-state positions. This repo
 * has no ESLint infrastructure (no config, no devDependency, no lint script), so the ban ships
 * as this equivalent conformance test: it scans flow sources (src/flow/ and, as later lanes add
 * them, flow-definition modules) and fails on any use of the banned constructs. Comments are
 * stripped before matching so the design citations in doc comments do not trip the fence.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FLOW_SOURCE_ROOTS = [join(dirname(fileURLToPath(import.meta.url)), '..')];

const BANNED = /\bSchema\s*\.\s*(declare|Any)\b/g;

const stripComments = (source: string): string =>
	source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const collectSources = (root: string): string[] => {
	const out: string[] = [];
	for (const entry of readdirSync(root)) {
		const full = join(root, entry);
		if (statSync(full).isDirectory()) {
			if (entry === '__tests__' || entry === 'node_modules') continue;
			out.push(...collectSources(full));
			continue;
		}
		if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
	}
	return out;
};

describe('flow source fences (ESLint-equivalent ban)', () => {
	it('bans Schema.declare and Schema.Any in flow-state positions', () => {
		const offenders: string[] = [];
		for (const root of FLOW_SOURCE_ROOTS) {
			for (const file of collectSources(root)) {
				const cleaned = stripComments(readFileSync(file, 'utf8'));
				const matches = [...cleaned.matchAll(BANNED)];
				if (matches.length > 0) {
					offenders.push(`${file}: ${matches.map((m) => m[0]).join(', ')}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it('scans a non-empty source set (guard against silent path drift)', () => {
		const files = FLOW_SOURCE_ROOTS.flatMap(collectSources);
		expect(files.length).toBeGreaterThanOrEqual(10);
	});
});
