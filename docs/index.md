# scheduling-bridge

`scheduling-bridge` is the remote Acuity automation service published as
`@tummycrypt/scheduling-bridge`.

The repo owns browser automation, HTTP bridge endpoints, Modal and Docker
runtime surfaces, K8s/container runtime packaging, and the bridge runtime truth
exposed by `/health`.

It does not own app deployment, business-specific UI, or reusable
backend-agnostic checkout components. It also does not own cluster state or
public-edge routing. Those are consumer app, infrastructure, and
`scheduling-kit` responsibilities.

## Authority Summary

- Bazel `//:pkg` builds the publishable package artifact.
- `pnpm build` materializes local `pkg/` and `dist/` from `bazel-bin/pkg`.
- CI and publish workflows extract `./bazel-bin/pkg`.
- Modal, Docker, and K8s/container runtimes consume the materialized `pkg/`
  artifact rather than rebuilding from source inside runtime images.
- Modal is the current live primary provider; K8s is the active next-primary
  lane until `TIN-189` closes.
- Generated facts live in `docs/generated/repo-facts.md`.
