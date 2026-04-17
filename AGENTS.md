# scheduling-bridge Agent Notes

This file is the working brief for AI agents and LLMs operating in the `acuity-middleware` repo, which publishes as `@tummycrypt/scheduling-bridge`.

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
- payment capability extraction or booking-surface payment policy
- canonical public payment method identifiers

## Strategic Goal

This repo is the bridge layer that allows a business to:

1. keep Acuity running
2. gain control over scheduling reads and booking orchestration
3. migrate gradually toward a homegrown backend without a big-bang cutover

That makes this repo central to the migration paper and to the operational beta-to-prod story.

## Current Tracking

As of `2026-04-15`, the active structural work here is:

- `TIN-101` mini sprint: toolchain authority and hermetic package convergence
- `TIN-104` adopt Bazel-built artifact truth in package publish lanes
- package dependency convergence with `@tummycrypt/scheduling-kit 0.7.x`

Operationally relevant truth:

- the current published bridge line is `0.4.1`
- the current ESM artifact fix bumps metadata to `0.4.2`
- that branch aligns the bridge dependency on `@tummycrypt/scheduling-kit ^0.7.1`

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

Authority boundary rules:

- `@tummycrypt/scheduling-bridge` owns Acuity protocol truth, wizard-step
  semantics, and remote transport behavior.
- `@tummycrypt/scheduling-kit` owns reusable booking-controller semantics and
  canonical public payment identifiers.
- application repos such as `MassageIthaca` own site policy, environment
  selection, and which payment capabilities should be exposed on a given
  surface.
- if this repo still exports helper contracts like `extractCapabilities`, treat
  them as transition debt to be removed or deprecated once downstream consumers
  adopt the package-owned authority.

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
```

Current publish flow targets:

- npm as `@tummycrypt/scheduling-bridge`
- GitHub Packages as `@jesssullivan/scheduling-bridge`

The repo name is still `acuity-middleware`, but the package name is `scheduling-bridge`. Preserve that distinction.

Today, the publish lane is still pnpm/npm-first. Bazel metadata exists, but it
is not yet the artifact authority. `TIN-104` exists to change that deliberately
rather than by implication.

## Important Files

- `src/server/handler.ts`
- `src/shared/browser-service.ts`
- `src/shared/acuity-service-catalog.ts`
- `src/adapters/acuity/wizard.ts`
- `src/adapters/acuity/steps/**`
- `modal-app.py`
- `Dockerfile`
- `.github/workflows/ci.yml`
- `.github/workflows/publish.yml`

## Guardrails

- Do not let Modal/Docker entrypoints drift from the real built server.
- Do not reintroduce singleton-page contention without a compelling measured reason.
- Do not hide false-empty availability behavior behind silent caches.
- Do not confuse this repo with the reusable UI/package layer.
- Do not let the bridge package declare stale `scheduling-kit` dependencies
  while downstream apps have already moved on.
- Do not let this repo become the long-term owner of booking-surface payment
  policy just because it can currently see practitioner settings.
