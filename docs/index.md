# scheduling-bridge

`scheduling-bridge` is the remote Acuity automation service published as
`@tummycrypt/scheduling-bridge`.

The repo owns browser automation, HTTP bridge endpoints, Modal and Docker
runtime surfaces, and the bridge runtime truth exposed by `/health`.

It does not own app deployment, business-specific UI, or reusable
backend-agnostic checkout components. Those are consumer app and
`scheduling-kit` responsibilities.

## Authority Summary

- Bazel `//:pkg` builds the publishable package artifact.
- `pnpm build` materializes local `pkg/` and `dist/` from `bazel-bin/pkg`.
- CI and publish workflows extract `./bazel-bin/pkg`.
- Modal and Docker consume the materialized `pkg/` artifact rather than
  rebuilding from source inside runtime images.
- Generated facts live in `docs/generated/repo-facts.md`.
