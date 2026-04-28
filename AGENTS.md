# scheduling-bridge Agent Notes

<!-- markdownlint-disable MD013 -->

This file is the working brief for AI agents and LLMs operating in the
`scheduling-bridge` repo, formerly `acuity-middleware`, which publishes as
`@tummycrypt/scheduling-bridge`.

## Repo Role

This repo is the remote automation service.

It owns:

- Acuity browser automation
- Playwright orchestration
- Effect-based resource management around browser/page lifecycle
- remote HTTP endpoints for services, availability, slots, booking, and health
- Modal and Docker deployment surfaces

It does **not** own:

- Vercel application deployment
- application-specific environment switching
- site-specific admin UI
- reusable, backend-agnostic UI components

## Strategic Goal

This repo is the bridge layer that allows a business to:

1. keep Acuity running
2. gain control over scheduling reads and booking orchestration
3. migrate gradually toward a homegrown backend without a big-bang cutover

That makes this repo central to the migration paper and to the operational beta-to-prod story.

## Current Tracking

As of `2026-04-25`, the active structural work here is:

- `TIN-89` package, Bazel, CI, publish, and dependency truth across shared
  scheduling packages
- `TIN-165` bazel-registry generation from standalone package truth
- release, tag, and npm authority cleanup tracked in GitHub issue `#76`
- runner reachability and shared-runner adoption, still pending proof before it
  becomes this public repo's live workflow contract

Operationally relevant truth:

- the pending package metadata on this branch is `@tummycrypt/scheduling-bridge`
  `0.4.4`
- `0.4.4` depends on `@tummycrypt/scheduling-kit ^0.7.4`
- as of `2026-04-25`, npm `latest`, git tag `v0.4.3`, and the GitHub release
  all point at `0.4.3`; deployed bridge runtime tuple remains a separate
  verification surface
- package metadata, git tags, npm dist-tags, and GitHub releases are separate
  authority surfaces until `#76` is resolved

## Deployment Truth

### Modal

Modal is the primary remote deployment surface.

Important facts:

- the deployed server should run `dist/server/handler.js`
- the Modal image must stay aligned with the same built artifact used by `pnpm start`
- warm-container behavior and concurrency settings are part of the real latency story

### Docker

Docker should mirror the same entrypoint and runtime assumptions as Modal.

If Modal and Docker drift from the actual Node entrypoint, that is an operational bug.

### Release Coordination

The app repo and this repo do not currently share a single atomic release mechanism.

That means:

- a new app build can point at an older bridge release
- a new bridge release can affect beta without any matching app deploy

Any promotion analysis must explicitly check bridge release identity and health.

Package graph rule:

- do not let bridge metadata lag behind the `scheduling-kit` version actually
  required by downstream apps

## Architecture Notes

Current high-level flow:

HTTP request
-> `server/handler.ts`
-> shared service catalog resolution
-> step programs
-> browser resource layer
-> Playwright/Acuity UI

Key architectural lessons already established:

- request-scoped pages are better than serializing all traffic through one singleton tab
- warm browsers matter
- false-empty Acuity reads are real and should be retried carefully
- URL-based direct reads are preferable when Acuity ids allow them
- shared service catalog logic should not be duplicated across local and remote paths

## Effect Guidance

Effect is useful here because this repo truly has resource lifecycle problems:

- browser startup and reuse
- page acquisition/release
- retry semantics
- service composition

Use Effect where it improves correctness and lifecycle clarity.

Do not add needless abstraction when simple synchronous code is sufficient.

## Performance Guidance

Treat latency work here as first-class product work.

Important performance dimensions:

- cold health path
- service catalog read latency
- date read latency
- slot read latency
- booking warm-up behavior
- false-empty calendar reads
- concurrency / contention under multiple booking sessions

If beta feels slow, do not dismiss that as “just Playwright.” Measure the step cost and reduce avoidable browser choreography first.

## CI / Publishing Truth

Important commands:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm docs:generate
```

Current publish flow targets:

- npm as `@tummycrypt/scheduling-bridge`
- GitHub Packages as `@jesssullivan/scheduling-bridge`

The canonical GitHub repo is `Jesssullivan/scheduling-bridge`; historical
`Jesssullivan/acuity-middleware` URLs may redirect. The npm package name is
`@tummycrypt/scheduling-bridge`. Preserve that distinction.

Current CI and publish workflows use the shared `js-bazel-package` workflow with:

- `runner_mode: shared`
- `publish_mode: same_runner`
- `bazel_targets: "//:pkg"`
- `package_dir: ./bazel-bin/pkg`

That means Bazel-built package output is already part of the CI/publish path.
Do not regress publish lanes back to ad hoc pnpm packaging without explicitly
re-opening the package authority decision.

<!-- markdownlint-enable MD013 -->

Current runner truth:

- the public workflow contract names the runner policy, not private runner
  topology
- the concrete shared-runner labels come from repository Actions variables and
  must be proven by green workflow runs before being treated as operational truth
- keep private runner topology, cluster names, and apply details out of this
  public repo; track those in the private infrastructure repo and Linear

## Important Files

- `src/server/handler.ts`
- `src/shared/browser-service.ts`
- `src/shared/acuity-service-catalog.ts`
- `src/adapters/acuity/wizard.ts`
- `src/adapters/acuity/steps/**`
- `modal-app.py`
- `Dockerfile`
- `MODULE.bazel`
- `BUILD.bazel`
- `flake.nix`
- `mkdocs.yml`
- `docs/generated/repo-facts.md`
- `llms.txt`
- `scripts/build-derived-artifacts.mjs`
- `scripts/check-artifact-authority.mjs`
- `scripts/check-release-metadata.mjs`
- `.github/workflows/ci.yml`
- `.github/workflows/publish.yml`

## Guardrails

- Do not let Modal/Docker entrypoints drift from the real built server.
- Do not reintroduce singleton-page contention without a compelling measured reason.
- Do not hide false-empty availability behavior behind silent caches.
- Do not confuse this repo with the reusable UI/package layer.
- Do not let the bridge package declare stale `scheduling-kit` dependencies
  while downstream apps have already moved on.
