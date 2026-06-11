# scheduling-bridge

Backend-agnostic scheduling adapter hub. Currently bridges Acuity Scheduling via Playwright browser automation, with architecture designed to support additional scheduling backends.

> Formerly `acuity-middleware`. The GitHub repo and npm package history retain the old name.

## Architecture

An HTTP server wrapping Playwright wizard flows that automate the Acuity booking UI. The bridge uses Effect TS for resource lifecycle management (browser/page acquisition and release).

```
HTTP Request
  -> server/handler.ts (route matching, auth, JSON serialization)
    -> acuity-service-catalog.ts (static env catalog -> BUSINESS -> scraper fallback)
    -> steps/ (Effect TS programs for each wizard stage)
      -> browser-service.ts (Playwright lifecycle via Effect Layer)
        -> selectors.ts (CSS selector registry with fallback chains)
```

### Key Components

- **server/handler.ts** -- Standalone Node.js HTTP server with Bearer token auth
- **acuity-service-catalog.ts** -- Shared service source order and cache for static config, BUSINESS extraction, and scraper fallback
- **browser-service.ts** -- Effect TS Layers for a warm shared browser process plus request-scoped page sessions
- **acuity-wizard.ts** -- Full `SchedulingAdapter` implementation (local Playwright or remote HTTP proxy)
- **remote-adapter.ts** -- HTTP client adapter for proxying to a remote middleware instance
- **selectors.ts** -- Single source of truth for all Acuity DOM selectors
- **steps/** -- Individual wizard step programs plus BUSINESS extraction helpers
- **acuity-scraper.ts** -- Deprecated read fallback for services, dates, and time slots

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth required) |
| GET | `/services` | List appointment types via `SERVICES_JSON` -> BUSINESS -> scraper fallback |
| GET | `/services/:id` | Get a specific service |
| POST | `/availability/dates` | Available dates for a service |
| POST | `/availability/slots` | Time slots for a specific date |
| POST | `/availability/check` | Check if a slot is available |
| POST | `/booking/create` | Create a booking (standard) |
| POST | `/booking/create-with-payment` | Create booking with payment bypass (coupon) |

### Health Contract

`GET /health` is the stable downstream runtime-truth surface.

In addition to basic runtime data, it now publishes:

- release tuple:
  - `releaseSha`
  - `releaseRef`
  - `releaseVersion`
  - `releaseBuiltAt`
  - nested `release.{ sha, ref, version, builtAt, modalEnvironment }`
- protocol tuple:
  - `protocolVersion`
  - nested `protocol.version`
  - `protocol.flowOwner = "scheduling-bridge"`
  - `protocol.backend = "acuity"`
  - `protocol.transport = "http-json"`
  - `protocol.endpoints`
  - `protocol.capabilities`

Downstream apps should use this tuple to assert which bridge release and protocol
surface they are talking to during beta validation and rollout claims.

This tuple is the supported runtime truth surface for adopters. Downstream apps
should not infer bridge ownership from package metadata, branch names, or Modal
dashboard state when `/health` is available.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3001` | Server port |
| `ACUITY_BASE_URL` | No | `https://MassageIthaca.as.me` | Acuity scheduling page URL |
| `AUTH_TOKEN` | Recommended | -- | Bearer token for all endpoints (except /health) |
| `ACUITY_BYPASS_COUPON` | For payment bypass | -- | 100% gift certificate code |
| `PLAYWRIGHT_HEADLESS` | No | `true` | Run browser headless |
| `PLAYWRIGHT_TIMEOUT` | No | `30000` | Page operation timeout (ms) |
| `CHROMIUM_EXECUTABLE_PATH` | No | -- | Custom Chromium path (for Lambda/serverless) |
| `CHROMIUM_LAUNCH_ARGS` | No | -- | Comma-separated Chromium args |
| `SERVICES_JSON` | No | -- | Optional static service catalog to bypass live Acuity reads |
| `ACUITY_SERVICE_CACHE_TTL_MS` | No | `300000` | TTL for cached live service catalogs before BUSINESS/scraper refresh |
| `SCHEDULING_BRIDGE_SLOT_PROFILE_THRESHOLD_MS` | No | `1500` | Threshold in ms for logging long-tail slot-read profile events |
| `SCHEDULING_BRIDGE_PROFILE_SLOT_READS` | No | `false` | Force logging of slot-read profile events even when under threshold |
| `MIDDLEWARE_RELEASE_SHA` | No | -- | Release commit SHA exposed via `/health` |
| `MIDDLEWARE_RELEASE_REF` | No | -- | Release ref/tag exposed via `/health` |
| `MIDDLEWARE_RELEASE_VERSION` | No | -- | Release version exposed via `/health` |
| `MIDDLEWARE_RELEASE_BUILT_AT` | No | -- | Build timestamp exposed via `/health` |
| `MIDDLEWARE_BUILD_TIMESTAMP` | No | -- | Legacy fallback build timestamp for `/health` |

### Observability

The bridge emits NDJSON logs to stdout/stderr for runtime analysis.

- `/health` remains the authoritative runtime-truth surface for downstream apps
- request handlers emit request-scoped structured events, including `requestId`
- long-tail slot reads emit `slot_read_profile` events with phase timings
- `SCHEDULING_BRIDGE_PROFILE_SLOT_READS=1` forces profile emission for all slot reads

## Deployment

### Standalone Node.js

```bash
pnpm install
pnpm dev           # Development with tsx against src/server/handler.ts
# or
pnpm build && pnpm start  # Materialize Bazel-derived pkg/ + dist/ then run dist/server/handler.js
```

### Docker

```bash
pnpm build
docker build -t scheduling-bridge .
docker run -p 3001:3001 \
  -e AUTH_TOKEN=your-secret-token \
  -e ACUITY_BASE_URL=https://YourBusiness.as.me \
  -e ACUITY_BYPASS_COUPON=your-coupon-code \
  scheduling-bridge
```

The Docker image consumes the local derived package at `pkg/` rather than building from source inside the image.

### Modal Labs

```bash
# Set secrets in Modal dashboard first:
#   AUTH_TOKEN, ACUITY_BASE_URL, ACUITY_BYPASS_COUPON
# `pnpm build` must run first so `modal-app.py` can consume the derived `pkg/` artifact.
pnpm build
modal deploy modal-app.py
```

#### Supported deployment path

The supported deployment path for the live Acuity bridge is:

1. merge to `main`
2. let `.github/workflows/deploy-modal.yml` deploy `modal-app.py`
3. inject `MIDDLEWARE_RELEASE_SHA`, `MIDDLEWARE_RELEASE_REF`,
   `MIDDLEWARE_RELEASE_VERSION`, and `MIDDLEWARE_RELEASE_BUILT_AT`
4. verify the resulting bridge tuple via `GET /health`

Operationally, this means:

- Modal deployment is part of release truth, not a side channel
- the live bridge should be identified by the `/health` release + protocol tuple
- downstream apps should validate the tuple they expect before making rollout claims

### Nix

```bash
nix develop   # Enter dev shell with Node 24 LTS, pnpm, Bazelisk, MkDocs, Tectonic, Playwright
direnv allow  # Optional: auto-load the same flake via .envrc
pnpm install
pnpm dev
```

### Bazel And Docs

```bash
pnpm docs:generate
pnpm docs:build
bazel build //:pkg
bazel build //:typecheck
bazel test //:test
```

## Release Authority

Current release authority:

- canonical repo: `Jesssullivan/acuity-middleware`
- npm package: `@tummycrypt/scheduling-bridge`
- GitHub Packages mirror: `@jesssullivan/scheduling-bridge`

The current publish + deploy shape is:

1. release metadata declared once
2. Bazel builds the publishable artifact at `bazel-bin/pkg`
3. `pnpm build` materializes local `pkg/` and `dist/` from that Bazel artifact
4. Docker and Modal consume the derived local `pkg/` package instead of compiling source again
5. CI dry-runs that extracted Bazel package surface before release
6. GitHub Actions publishes the extracted Bazel package directory
7. GitHub Actions deploy the Modal runtime from `main`
8. downstream apps consume the published package and verify the live runtime tuple via `/health`
9. the declared Node support window is `>=24 <26`, with Node 24 as the canonical build lane and Node 25 covered as the current-release compatibility lane

This repo is the sole owner of Acuity automation concerns. App repos and shared
packages may consume the bridge and assert its runtime tuple, but they should
not duplicate bridge runtime ownership or release truth logic.

## Development

```bash
pnpm install      # Install dependencies
pnpm dev          # Start dev server with tsx
pnpm docs:generate
pnpm docs:build
pnpm typecheck    # Run TypeScript type checking
pnpm build        # Materialize pkg/ + dist/ from Bazel //:pkg
pnpm test         # Run Bazel-backed tests
pnpm check:package
bazel build //:pkg
bazel test //:test
```

## License

MIT
