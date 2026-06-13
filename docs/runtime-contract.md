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

## Flow Runner (`BRIDGE_FLOW_RUNNER`)

As of 0.6.x, async bridge jobs (`booking_create_with_payment` and both
availability-refresh kinds) execute through the `runFlow` fold by default. The
flip is gated on parity evidence: the trace-conformance harness
(`docs/design/parity-evidence.md`, design
[Flow DAG Formalization](design/flow-dag-formalization.md) §10) is green in CI on
`main`, proving the fold produces traces identical to the legacy worker path
(including the bypass-proof and `reconcile_required` boundaries and the
worker's page-per-step segment layout).

- **Default (unset): ON.** The fold is the execution path.
- **`BRIDGE_FLOW_RUNNER=1` / `true`:** explicitly ON (same as the default).
- **`BRIDGE_FLOW_RUNNER=0` / `false`:** the kill switch. Falls back to the
  byte-for-byte-preserved legacy worker composition. This is the rollback knob.
- Any other value is treated as ON (fail-open to the default path).

**Rollback.** To revert a deployment to the legacy execution path, set
`BRIDGE_FLOW_RUNNER=0` and restart the worker. No data migration is required —
the legacy path is preserved unchanged behind the switch.

**Shadow mode.** Shadow comparison runs on the *non-executing* path. With the
fold as the default, the fold IS the plan, so no shadow is needed. Under the
`BRIDGE_FLOW_RUNNER=0` kill switch the legacy path runs and its real step trace
is diffed against the plan the fold would have run, surfaced via Prometheus
counters `acuity_flow_shadow_runs_total{flow_id,result}` (result ∈
`match|prefix|mismatch`) and `acuity_flow_shadow_step_mismatch_total{flow_id,step_id,kind}`
(kind ∈ `missing|unexpected`). Plans only — no dual execution of effects.
