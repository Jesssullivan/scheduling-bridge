# Codex Bridge Capability Boundary

Date: 2026-04-17
Worktree: `.claude/worktrees/codex-bridge-capability-boundary`
Branch: `codex-bridge-capability-boundary`

## Current Truth

- `src/capabilities.ts` currently exports `extractCapabilities`.
- The helper already emits public Stripe as `card`, so the immediate bug is not
  the value shape.
- The architectural problem is ownership: this repo is a remote automation
  bridge, but it still publishes a booking-surface payment capability contract.
- `MassageIthaca` and `scheduling-kit` are now converging on package-owned
  public payment ids, which makes the bridge-owned capability helper transition
  debt instead of a valid long-term authority.

## Authority Decision

- `acuity-middleware` / `@tummycrypt/scheduling-bridge` should own:
  - Acuity wizard steps
  - remote protocol and HTTP surfaces
  - runtime, browser, and deployment semantics
- It should not own:
  - booking-surface payment capability extraction
  - canonical public payment method ids
  - site policy for which rails should be exposed

## Transition Plan

1. Short term
- Keep `extractCapabilities` readable for downstream compatibility.
- Mark the helper as transition debt in repo-local docs and AGENTS guidance.
- Do not expand the helper or move more site-policy logic into this repo.

2. Mid term
- Move public payment capability extraction to the repo that owns the booking
  surface contract.
- Prefer `scheduling-kit` for reusable capability normalization helpers.
- Keep application repos responsible for combining practitioner settings with
  site policy and deployment/runtime context.

3. Cleanup
- Deprecate and later remove `extractCapabilities` from the bridge public API
  after downstream consumers stop importing it.
- Update tests so protocol and transport truth remain here, while payment
  capability truth moves upstream.

## Execution Notes

- The first upstream `scheduling-kit` lane is draft PR
  `Jesssullivan/scheduling-kit#63`.
- This bridge lane should stay non-breaking until the app and package adoption
  path is explicit.
- If a bridge PR is opened from this branch, it should be docs/authority only
  unless a consumer-safe deprecation marker is added.
