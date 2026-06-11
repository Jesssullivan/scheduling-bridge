import { runBazel } from './bazel-helpers.mjs';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node scripts/run-bazel-target.mjs <bazel-args...>');
  process.exit(1);
}

runBazel(...args);
