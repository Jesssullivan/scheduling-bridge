import { readFileSync } from 'node:fs';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const expectedScripts = {
  build: 'node scripts/build-derived-artifacts.mjs',
  typecheck: 'node scripts/run-bazel-target.mjs build //:typecheck',
  test: 'node scripts/run-bazel-target.mjs test //:test',
  'check:package': 'node scripts/check-package-surface.mjs',
  start: 'node dist/server/handler.js',
};

const mismatches = Object.entries(expectedScripts)
  .filter(([key, expected]) => pkg.scripts?.[key] !== expected)
  .map(([key, expected]) => ({
    key,
    expected,
    actual: pkg.scripts?.[key] ?? '<missing>',
  }));

if (mismatches.length > 0) {
  for (const mismatch of mismatches) {
    console.error(
      `package.json script ${mismatch.key} mismatch: expected "${mismatch.expected}", found "${mismatch.actual}"`,
    );
  }
  process.exit(1);
}

console.log('artifact authority contract aligned in package.json scripts');
