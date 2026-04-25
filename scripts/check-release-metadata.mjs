import { readFileSync } from 'node:fs';

const read = (relativePath) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const packageJson = JSON.parse(read('../package.json'));
const moduleBazel = read('../MODULE.bazel');
const buildBazel = read('../BUILD.bazel');
const flakeNix = read('../flake.nix');
const ciWorkflow = read('../.github/workflows/ci.yml');
const publishWorkflow = read('../.github/workflows/publish.yml');
const deployModalWorkflow = read('../.github/workflows/deploy-modal.yml');
const dockerfile = read('../Dockerfile');
const modalApp = read('../modal-app.py');
const expectedPnpmVersion = packageJson.packageManager?.replace(/^pnpm@/, '');

const extract = (source, pattern, label) => {
  const match = source.match(pattern);
  if (!match?.[1]) {
    throw new Error(`Unable to find ${label}`);
  }
  return match[1];
};

const parseMajor = (value, label) => {
  const match = String(value).match(/(\d+)/);
  if (!match?.[1]) {
    throw new Error(`Unable to parse ${label}`);
  }
  return Number(match[1]);
};

const parseSupportedNodeMajors = (engineRange) => {
  const match = engineRange.match(/^>=(\d+)\s+<(\d+)$/);
  if (!match?.[1] || !match?.[2]) {
    throw new Error(`Unsupported node engines range "${engineRange}"`);
  }

  const lower = Number(match[1]);
  const upper = Number(match[2]);

  return {
    lower,
    upper,
    majors: Array.from({ length: upper - lower }, (_, index) => String(lower + index)),
  };
};

const supportedNodeMajors = parseSupportedNodeMajors(packageJson.engines.node);
const canonicalNodeMajor = String(supportedNodeMajors.lower);
const nodeTypesMajor = parseMajor(
  packageJson.devDependencies['@types/node'],
  '@types/node version',
);
const bazelNodeVersion = extract(
  moduleBazel,
  /node\.toolchain\(node_version = "([^"]+)"/,
  'node toolchain version',
);
const bazelNodeMajor = parseMajor(bazelNodeVersion, 'Bazel node toolchain version');
const flakeNodeMajor = parseMajor(
  extract(flakeNix, /\bnodejs_(\d+)\b/, 'flake Node package'),
  'flake Node package',
);
const ciNodeVersions = JSON.parse(
  extract(ciWorkflow, /node_versions:\s*'(\[[^\n]+\])'/, 'CI node versions'),
);
const publishNodeVersions = JSON.parse(
  extract(publishWorkflow, /node_versions:\s*'(\[[^\n]+\])'/, 'publish node versions'),
);
const ciPublishNodeVersion = extract(
  ciWorkflow,
  /publish_node_version:\s*"([^"]+)"/,
  'CI publish node version',
);
const ciBuildCommand = extract(
  ciWorkflow,
  /build_command:\s*([^\n]+)/,
  'CI build command',
).trim();
const publishWorkflowNodeVersion = extract(
  publishWorkflow,
  /publish_node_version:\s*"([^"]+)"/,
  'publish workflow node version',
);
const publishBuildCommand = extract(
  publishWorkflow,
  /build_command:\s*([^\n]+)/,
  'publish workflow build command',
).trim();
const dockerNodeMajor = parseMajor(
  extract(dockerfile, /setup_(\d+)\.x/, 'Docker NodeSource major'),
  'Docker NodeSource major',
);
const modalNodeMajor = parseMajor(
  extract(modalApp, /setup_(\d+)\.x/, 'Modal NodeSource major'),
  'Modal NodeSource major',
);

const checks = [
  {
    label: 'MODULE.bazel version',
    actual: extract(moduleBazel, /module\([\s\S]*?version = "([^"]+)"/m, 'module version'),
    expected: packageJson.version,
  },
  {
    label: 'BUILD.bazel npm_package version',
    actual: extract(buildBazel, /npm_package\([\s\S]*?version = "([^"]+)"/m, 'npm_package version'),
    expected: packageJson.version,
  },
  {
    label: 'BUILD.bazel npm_package name',
    actual: extract(buildBazel, /npm_package\([\s\S]*?package = "([^"]+)"/m, 'npm_package name'),
    expected: packageJson.name,
  },
  {
    label: 'MODULE.bazel pnpm version',
    actual: extract(moduleBazel, /pnpm_version = "([^"]+)"/, 'pnpm_version'),
    expected: expectedPnpmVersion,
  },
  {
    label: 'MODULE.bazel Node major',
    actual: String(bazelNodeMajor),
    expected: canonicalNodeMajor,
  },
  {
    label: 'flake Node major',
    actual: String(flakeNodeMajor),
    expected: canonicalNodeMajor,
  },
  {
    label: 'Docker Node major',
    actual: String(dockerNodeMajor),
    expected: canonicalNodeMajor,
  },
  {
    label: 'Modal Node major',
    actual: String(modalNodeMajor),
    expected: canonicalNodeMajor,
  },
  {
    label: '@types/node major',
    actual: String(nodeTypesMajor),
    expected: canonicalNodeMajor,
  },
  {
    label: 'CI node versions',
    actual: JSON.stringify(ciNodeVersions),
    expected: JSON.stringify(supportedNodeMajors.majors),
  },
  {
    label: 'publish workflow node versions',
    actual: JSON.stringify(publishNodeVersions),
    expected: JSON.stringify(supportedNodeMajors.majors),
  },
  {
    label: 'CI publish node version',
    actual: ciPublishNodeVersion,
    expected: canonicalNodeMajor,
  },
  {
    label: 'publish workflow node version',
    actual: publishWorkflowNodeVersion,
    expected: canonicalNodeMajor,
  },
  {
    label: 'CI build command',
    actual: ciBuildCommand,
    expected: 'node scripts/check-artifact-authority.mjs',
  },
  {
    label: 'publish workflow build command',
    actual: publishBuildCommand,
    expected: 'node scripts/check-artifact-authority.mjs',
  },
  {
    label: 'Docker artifact input',
    actual: dockerfile.includes('COPY pkg/ ./') ? 'pkg' : '<missing>',
    expected: 'pkg',
  },
  {
    label: 'Docker install mode',
    actual: dockerfile.includes('pnpm install --prod --frozen-lockfile --ignore-scripts')
      ? 'artifact-runtime'
      : '<missing>',
    expected: 'artifact-runtime',
  },
  {
    label: 'Docker source build removed',
    actual: dockerfile.includes('pnpm build') || dockerfile.includes('COPY src/')
      ? 'source-build'
      : 'artifact-only',
    expected: 'artifact-only',
  },
  {
    label: 'Modal artifact input',
    actual: modalApp.includes('.add_local_dir("pkg", "/app", copy=True)') ? 'pkg' : '<missing>',
    expected: 'pkg',
  },
  {
    label: 'Modal install mode',
    actual: modalApp.includes('pnpm install --prod --frozen-lockfile --ignore-scripts')
      ? 'artifact-runtime'
      : '<missing>',
    expected: 'artifact-runtime',
  },
  {
    label: 'Modal source build removed',
    actual: modalApp.includes('cd /app && pnpm build') || modalApp.includes('.add_local_dir("src"')
      ? 'source-build'
      : 'artifact-only',
    expected: 'artifact-only',
  },
  {
    label: 'Deploy Modal workflow build step',
    actual: deployModalWorkflow.includes('Materialize Bazel-derived runtime package')
      && deployModalWorkflow.includes('run: pnpm build')
      ? 'present'
      : '<missing>',
    expected: 'present',
  },
];

const failures = checks.filter((check) => check.actual !== check.expected);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(
      `${failure.label} mismatch: expected "${failure.expected}", found "${failure.actual}"`,
    );
  }
  process.exit(1);
}

console.log(
  `release metadata aligned for ${packageJson.name}@${packageJson.version} (pnpm ${expectedPnpmVersion}, Node ${packageJson.engines.node}, Bazel Node ${bazelNodeVersion})`,
);
