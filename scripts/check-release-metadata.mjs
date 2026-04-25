import { readFileSync } from 'node:fs';

const read = (relativePath) =>
	readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const packageJson = JSON.parse(read('../package.json'));
const moduleBazel = read('../MODULE.bazel');
const buildBazel = read('../BUILD.bazel');
const ciWorkflow = read('../.github/workflows/ci.yml');
const publishWorkflow = read('../.github/workflows/publish.yml');
const expectedPnpmVersion = packageJson.packageManager?.replace(/^pnpm@/, '');
const expectedGitHubPackageName = '@jesssullivan/scheduling-bridge';
const expectedRepositoryUrl = 'git+https://github.com/Jesssullivan/scheduling-bridge.git';
const expectedHomepage = 'https://github.com/Jesssullivan/scheduling-bridge';
const expectedBugsUrl = 'https://github.com/Jesssullivan/scheduling-bridge/issues';
const usesPinnedPackageWorkflow = (workflow) =>
	/uses:\s*tinyland-inc\/ci-templates\/\.github\/workflows\/js-bazel-package\.yml@[0-9a-f]{40}/.test(
		workflow,
	);

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
	{
		label: 'package.json repository',
		actual: packageJson.repository?.url,
		expected: expectedRepositoryUrl,
	},
	{
		label: 'package.json homepage',
		actual: packageJson.homepage,
		expected: expectedHomepage,
	},
	{
		label: 'package.json bugs URL',
		actual: packageJson.bugs?.url,
		expected: expectedBugsUrl,
	},
	{
		label: 'CI reusable workflow pin',
		actual: String(usesPinnedPackageWorkflow(ciWorkflow)),
		expected: 'true',
	},
	{
		label: 'CI runner mode',
		actual: extract(ciWorkflow, /runner_mode:\s*([^\n]+)/, 'CI runner_mode').trim(),
		expected: 'shared',
	},
	{
		label: 'CI publish mode',
		actual: extract(ciWorkflow, /publish_mode:\s*([^\n]+)/, 'CI publish_mode').trim(),
		expected: 'same_runner',
	},
	{
		label: 'CI package artifact path',
		actual: extract(ciWorkflow, /package_dir:\s*([^\n]+)/, 'CI package_dir').trim(),
		expected: './bazel-bin/pkg',
	},
	{
		label: 'CI Bazel package target',
		actual: String(
			extract(ciWorkflow, /bazel_targets:\s*"([^"]+)"/, 'CI bazel_targets').includes(
				'//:pkg',
			),
		),
		expected: 'true',
	},
	{
		label: 'CI GitHub Packages name',
		actual: extract(ciWorkflow, /github_package_name:\s*"([^"]+)"/, 'CI github_package_name'),
		expected: expectedGitHubPackageName,
	},
	{
		label: 'publish reusable workflow pin',
		actual: String(usesPinnedPackageWorkflow(publishWorkflow)),
		expected: 'true',
	},
	{
		label: 'publish packages permission',
		actual: extract(publishWorkflow, /packages:\s*([^\n]+)/, 'publish packages permission').trim(),
		expected: 'write',
	},
	{
		label: 'publish package artifact path',
		actual: extract(publishWorkflow, /package_dir:\s*([^\n]+)/, 'publish package_dir').trim(),
		expected: './bazel-bin/pkg',
	},
	{
		label: 'publish Bazel package target',
		actual: String(
			extract(
				publishWorkflow,
				/bazel_targets:\s*"([^"]+)"/,
				'publish bazel_targets',
			).includes('//:pkg'),
		),
		expected: 'true',
	},
	{
		label: 'publish GitHub Packages name',
		actual: extract(publishWorkflow, /github_package_name:\s*"([^"]+)"/, 'publish github_package_name'),
		expected: expectedGitHubPackageName,
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
	`release metadata aligned for ${packageJson.name}@${packageJson.version} (pnpm ${expectedPnpmVersion}, ${expectedGitHubPackageName})`,
);
