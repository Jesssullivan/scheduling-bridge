import { rootPath, runBazel, runNode } from './bazel-helpers.mjs';

runBazel('build', '//:pkg');
runNode(
  rootPath('bazel-bin', 'node_modules', 'publint', 'src', 'cli.js'),
  rootPath('bazel-bin', 'pkg'),
);
