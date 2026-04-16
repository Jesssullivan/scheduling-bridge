import { readFileSync } from 'node:fs';

const read = (relativePath) =>
	readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const packageJson = JSON.parse(read('../package.json'));
const moduleBazel = read('../MODULE.bazel');
const buildBazel = read('../BUILD.bazel');
const expectedPnpmVersion = packageJson.packageManager?.replace(/^pnpm@/, '');

const extract = (source, pattern, label) => {
	const match = source.match(pattern);
	if (!match?.[1]) {
		throw new Error(`Unable to find ${label}`);
	}
	return match[1];
};

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
	`release metadata aligned for ${packageJson.name}@${packageJson.version} (pnpm ${expectedPnpmVersion})`,
);
