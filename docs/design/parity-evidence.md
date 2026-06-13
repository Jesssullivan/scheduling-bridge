# Trace-Conformance Parity Evidence (TIN-2072 flip → TIN-2093 deletion gate)

Status: the 0.7.0 deletion gate has landed. `runFlow` is the only execution path;
the three legacy hand-written compositions, the `BRIDGE_FLOW_RUNNER` flag, the kill
switch, and shadow mode are deleted. This document states exactly what a green run
of the trace-conformance harness proves and what it does not. Design contract:
[Flow DAG Formalization](flow-dag-formalization.md) §10 ("0.7.0 — the deletion
gate") and §11 ("Trace conformance").

## The golden baseline

Before any deletion, the real legacy path was driven over every scenario and its
recorded step traces — ordered step ids, per-step outcomes, terminal job status,
scope/segment layout, result payloads (`createdAt` pinned), and the job-level retry
transitions through `executeBridgeJob` — were serialized as committed golden
fixtures under `src/server/__tests__/__fixtures__/trace-golden/`. The goldens are
the permanent parity baseline: they are recorded from the legacy compositions, never
hand-written to match the fold.

## The harness

`src/server/__tests__/trace-conformance.test.ts` drives **only** the `runFlow` fold
(`src/server/flow-runner.ts`, the only execution path) over the same
module-boundary-substituted stub step sets the goldens were captured under (no
Chromium launches). Every stub is wrapped in a tracing decorator that records, in
execution order:

- one `scope-open` event per browser-session Scope acquisition (the fold's
  one-Scope-per-segment lifecycle, counted by a substituted session Layer);
- one `step` event per underlying step program invocation, with its outcome
  (`ok` / `error:<tag>`).

The recorded trace is **deep-compared against the committed golden** for each
scenario, and the happy-path/failure-path traces are additionally pinned as literals
so a golden corrupted to match a broken fold cannot pass.

## What a green run proves

| Scenario | Kinds covered | Assertion |
| --- | --- | --- |
| Happy path | booking, dates (via-url + wizard dispatch), slots (via-url + wizard dispatch) | the fold reproduces the recorded golden trace and result byte-for-byte; journal trail mirrors the executed order |
| Bypass-proof failure (`PAYMENT_BYPASS_NOT_PROVEN`) | booking | golden terminal status **and step cutoff** (submit/extract never invoked) |
| Pre-submit failures (navigate, fill-form) | booking | golden cutoff, `failed_pre_submit`, retryable |
| REST execution-path guard | booking | golden (empty) trace and terminal |
| Submit failure / extract failure | booking | golden cutoff, `reconcile_required`, non-retryable |
| Job-level retry (requeue + re-lease, the only retry the worker performs) | booking, dates | golden cross-attempt traces and status transitions through the real `executeBridgeJob` machinery; re-lease re-runs from the top (no resume in 0.6.x, per design §5) |
| Segment layout | all three | the fold opens exactly as many session Scopes as the recorded golden, with the same step groupings; the plan-declared segments equal the golden groupings (five single-step segments for booking, one for each read) |

Status-transition coverage (`{status, code, step, retryable}`) for the fold is
additionally exercised by `flow-runner.test.ts`; this harness extends it to full
trace identity against the golden (step order, outcomes, page lifecycle, message
parity).

## Known, intentional divergences from the (deleted) legacy path

Two cases where the fold is deliberately *stricter* than the deleted legacy path.
The fold IS the canonical behavior of the only surviving path; both are asserted
explicitly in the harness so any drift fails:

1. **`COUPON_REQUIRED` front-loaded guard.** The deleted legacy worker discovered a
   missing coupon only after running navigate + fill-form; the fold executor guards
   before any browser work (`src/server/worker.ts`). Same terminal failure, strictly
   less vendor work — the fold produces an empty trace.
2. **Ambiguous submit halts at submit.** When `submitBooking` reports
   `confirmationPageReached: false`, the fold classifies the unknown landing as
   `Diverged` at `acuity/submit` (`FLOW_DIVERGED`, `reconcile_required`,
   non-retryable) instead of blindly probing `extractConfirmation` from an ambiguous
   page as the legacy path did (which then failed at extract-confirmation with the
   same `reconcile_required`). The fold trace stops at submit; `extractConfirmation`
   is never invoked.

## What a green run does NOT prove

- **Live vendor behavior.** All step programs are stubs: selector drift, real Acuity
  wizard markup/timing, Playwright behavior, and network conditions are out of scope.
  Live-wizard evidence comes from production per-stepId metrics and, later, the
  cassette corpus (design §11).
- **REST booking execution** beyond the `REST_BOOKING_NOT_WIRED` guard (not wired).
- **Journal durability.** Redis/Postgres journal semantics are covered separately by
  the journal-conformance suites; this harness uses the in-memory journal as evidence
  transport only.
- **Resume / idempotent re-submit.** 0.6.x has no segment-replay resume; the retry
  tests prove the fold re-runs from the top, which is the honest 0.6.x semantic
  (design §5).
