# Runtime Contract

`GET /health` is the bridge runtime truth surface.

Downstream apps should use it to verify:

- bridge release SHA, ref, version, and build timestamp
- protocol version
- flow owner
- backend
- transport
- endpoint and capability shape

Package metadata says what a consumer compiled against. `/health` says what the
deployed bridge is actually running. Promotion and beta validation should check
both when claims depend on the live bridge.

## Provider Truth

The bridge contract is provider-agnostic: a Node HTTP server exposing the
protocol endpoints and `/health` tuple.

- K8s/container execution is the accepted next-production bridge route and is
  the current MassageIthaca K8s shadow runtime.
- Modal is legacy proofing context. Automatic Modal deploys are disabled; the
  manual workflow requires explicit acknowledgement while TIN-981 closes the
  surface.
- Provider state, tailnet exposure, and public-edge routing are managed by the
  infrastructure repo.
- Docker is the local/container compatibility target and must mirror the same
  `dist/server/handler.js` entrypoint.
- Consumer apps should name the remote endpoint with `SCHEDULING_BRIDGE_URL`
  and `SCHEDULING_BRIDGE_AUTH_TOKEN`; legacy `MODAL_*` aliases are transition
  compatibility, not the forward contract.

## Flow Runner (`runFlow` is the only execution path)

As of 0.7.0, `runFlow` (the fold) is the **only** path for async bridge jobs
(`booking_create_with_payment` and both availability-refresh kinds). The 0.7.0
deletion gate (design
[Flow DAG Formalization](design/flow-dag-formalization.md) §10, the anti-renaming
guarantee) deleted the three legacy hand-written compositions
(`wizard.ts createBookingWithPaymentRefProgram`, the `handler.ts` inline
`Effect.gen`, and the `server/worker.ts` legacy executors), the
`BRIDGE_FLOW_RUNNER` flag, the kill switch, and shadow mode. There is no
alternate execution path and nothing to fall back to.

**No flag, no rollback knob.** The dual-path window was capped to one minor by
design; it is now closed. Earlier releases gated the fold behind
`BRIDGE_FLOW_RUNNER` and kept a byte-for-byte legacy worker behind
`BRIDGE_FLOW_RUNNER=0` — both are gone. The variable is no longer read; setting
it has no effect.

**Parity is permanent.** The fold's parity with the (now-removed) legacy path is
locked by the recorded golden fixtures
(`src/server/__tests__/__fixtures__/trace-golden/`), captured from the real
legacy path before deletion, and asserted byte-for-byte by the trace-conformance
harness (`docs/design/parity-evidence.md`): ordered step ids, per-step outcomes,
terminal job status (incl. the bypass-proof and `reconcile_required` boundaries),
and the worker's page-per-step segment layout. A regression in fold step
order/outcome turns the suite red.

**Metrics.** The fold emits per-stepId Prometheus metrics
(`acuity_flow_step_attempts_total`, `acuity_flow_step_failures_total`,
`acuity_flow_step_landings_total`, `acuity_flow_step_reroutes_total`, and the
step-duration histogram), with cardinality bounded by the registered plan step
ids. The shadow-comparison counters were removed with shadow mode.
