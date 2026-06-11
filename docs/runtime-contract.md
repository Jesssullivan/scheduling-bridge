# Runtime Contract

## Stable Surfaces

- `GET /health`
- `GET /services`
- `GET /services/:id`
- `POST /availability/dates`
- `POST /availability/slots`
- `POST /availability/check`
- `POST /booking/create`
- `POST /booking/create-with-payment`

## Health Tuple

`GET /health` is the release and protocol truth surface. Downstream apps should verify:

- release identity: SHA, ref, version, build time
- transport identity: `http-json`
- flow owner: `scheduling-bridge`
- backend: `acuity`
- protocol version and capabilities

Do not infer deployment truth from branch names, package metadata alone, or dashboard state
when `/health` is available.

## Supported Runtime Targets

- Modal is the current primary remote deployment surface.
- Docker must mirror the same built Node entrypoint as Modal.
- K8s work is active, but it is not the only authoritative runtime until promotion work closes.

## Entry Point Rule

All supported runtime targets must launch `dist/server/handler.js`.
If Docker, Modal, or future K8s manifests drift from that entrypoint, treat it as an operational bug.
