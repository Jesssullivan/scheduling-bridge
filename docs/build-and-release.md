# Build and Release

## Local Workflow

```bash
direnv allow
pnpm install --frozen-lockfile
pnpm docs:generate
bazel build //:pkg
pnpm build
pnpm typecheck
pnpm test
pnpm check:package
bazel build //:typecheck
bazel test //:test
```

## Authority Model

- `flake.nix` and the Bazel toolchain are the entrypoints for build truth.
- `bazel build //:pkg` produces the package artifact CI publishes.
- `pnpm build` materializes local `pkg/` and `dist/` from `bazel-bin/pkg` so local runtime surfaces stay aligned with the Bazel package artifact.
- Docker and Modal should consume `pkg/` as a derived package surface, not rebuild from source.
- `pnpm typecheck` and `pnpm test` delegate to Bazel targets instead of maintaining a second build or test authority.
- GitHub Actions dry-run and publish from `./bazel-bin/pkg`.
- The reusable CI template still invokes `build_command` before its Bazel validation step, so this repo now uses that slot only for an authority-contract check.

## Node Contract

- Canonical build node: Node 24 LTS.
- Declared consumer window: `>=24 <26`.
- CI spans Node 24 and 25 at the package boundary.
- Modal, Docker, Bazel, and the Nix shell anchor the build lane on Node 24.

## Nix / direnv

- `flake.nix` is the repo-managed toolchain shell.
- `.envrc` loads that same flake through `nix-direnv`.
- The shell is expected to provide Node 24 LTS, pnpm, Bazelisk, MkDocs, Tectonic, and Playwright browsers.

## Docs Surface

- `pnpm docs:generate` refreshes generated LLM/operator docs.
- `pnpm docs:build` runs `mkdocs build --strict`.
- Hand-edited docs live in `docs/`.
- Generated docs live in `docs/generated/` and `llms.txt`.
- `docs/paper.md` and `docs/paper/` are paper-facing surfaces and should be updated when the runtime or build story changes.
