# scheduling-bridge

`@tummycrypt/scheduling-bridge` is the remote automation layer for Acuity-backed scheduling.
It owns Playwright automation, Effect-based browser/page lifecycle management, and the remote
HTTP bridge that downstream apps use for services, availability, slots, booking, and health.

## Start Here

- Use `direnv allow` or `nix develop` to enter the repo-managed shell.
- Run `pnpm install --frozen-lockfile` once per checkout.
- Run `pnpm docs:generate` before editing repo-facing docs.
- Treat `bazel build //:pkg` as publish artifact truth.
- Treat `pnpm build` as the local derivation step that syncs Bazel output into `pkg/` and `dist/`.
- Keep `docs/paper.md` and `docs/paper/` aligned when runtime, deployment, or build claims change.

## Repo Truth

- Runtime owner: this repo
- Package name: `@tummycrypt/scheduling-bridge`
- Canonical publish artifact: `bazel-bin/pkg`
- Stable runtime truth surface: `GET /health`
- Current primary deployment target: Modal

The generated facts page at [`docs/generated/repo-facts.md`](generated/repo-facts.md)
is the compact machine-readable summary of package, toolchain, CI, and protocol metadata.
