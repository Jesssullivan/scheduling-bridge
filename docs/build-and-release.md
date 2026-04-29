# Build And Release

The release path is artifact-first.

1. Keep `package.json`, `MODULE.bazel`, and `BUILD.bazel` aligned.
2. Run `pnpm check:release-metadata`.
3. Build the package with `bazel build //:pkg`.
4. Use `pnpm build` when local `pkg/` and `dist/` materialization is needed.
5. Publish from `./bazel-bin/pkg`.
6. Deploy Modal and Docker from the same materialized package surface.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm check:release-metadata
pnpm check:artifact-authority
pnpm typecheck
pnpm test
pnpm build
pnpm check:package
pnpm docs:generate
```

`pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm check:package` route
through Bazel so local and CI paths exercise the same package graph.

`pnpm test:host` intentionally bypasses Bazel and runs Vitest under the host
Node selected by CI. Keep it in the package workflow when widening consumer
engine support so the matrix proves the published package can execute on every
advertised downstream major.

For sandboxed local validation where Bazel cannot write its default output root,
set `BAZEL_OUTPUT_USER_ROOT=/tmp/<repo>-bazel-out`.

## Node Policy

The npm package advertises Node 22 and Node 24 consumer support. That is the
downstream contract for apps such as MassageIthaca.

Bridge-owned runtime and artifact authority remains Node 24:

- Bazel Node toolchain
- Nix development shell
- Docker runtime image
- Modal runtime image
- npm/GitHub Packages publish runner

Do not collapse these two concerns. Consumer support is broader than the bridge
runtime image, and package CI must prove both supported consumer majors.

## Nix

Use `nix develop` or `direnv allow` to enter the Node 24, pnpm, Bazelisk,
Playwright, MkDocs, and paper-tooling shell.
