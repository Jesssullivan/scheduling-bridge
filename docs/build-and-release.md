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

## Nix

Use `nix develop` or `direnv allow` to enter the Node 24, pnpm, Bazelisk,
Playwright, MkDocs, and paper-tooling shell.
