import { runBazel, syncDerivedDist, syncDerivedPackage } from './bazel-helpers.mjs';

runBazel('build', '//:pkg');
syncDerivedPackage();
syncDerivedDist();

console.log('Materialized local `pkg/` and `dist/` from Bazel package output `bazel-bin/pkg`.');
