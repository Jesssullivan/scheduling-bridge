# scheduling-bridge

Backend-agnostic scheduling adapter hub. Currently bridges Acuity Scheduling via Playwright browser automation, with architecture designed to support additional scheduling backends.

> Formerly `acuity-middleware`. The GitHub repo and npm package history retain the old name.

## Ownership Boundary

`@tummycrypt/scheduling-bridge` is the canonical owner of the Acuity path:

- Acuity browser automation
- service/date/slot/booking semantics for the Acuity backend
- remote bridge protocol
- Modal runtime behavior and release metadata

It does **not** own:

- the homegrown backend
- adopter-specific payment policy
- site-specific booking UX

Those belong to:

- `@tummycrypt/scheduling-kit` for the reusable homegrown scheduling platform
- adopter apps such as `MassageIthaca` for explicit site policy and composition

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
- **browser-service.ts** -- Effect TS Layer managing Playwright browser/page lifecycle
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

## Deployment

### Standalone Node.js

```bash
pnpm install
pnpm dev           # Development with tsx against src/server/handler.ts
# or
pnpm build && pnpm start  # Production via dist/server/handler.js
```

### Docker

```bash
docker build -t scheduling-bridge .
docker run -p 3001:3001 \
  -e AUTH_TOKEN=your-secret-token \
  -e ACUITY_BASE_URL=https://YourBusiness.as.me \
  -e ACUITY_BYPASS_COUPON=your-coupon-code \
  scheduling-bridge
```

### Modal Labs

```bash
# Set secrets in Modal dashboard first:
#   AUTH_TOKEN, ACUITY_BASE_URL, ACUITY_BYPASS_COUPON
# The Modal image builds the same dist/server/handler.js artifact used by pnpm start.
modal deploy modal-app.py
```

Current truth: Modal deploy is still a separate release lane from package
publish and adopter app deploy. Downstream apps must treat the live system as a
release tuple:

- app commit
- consumed package versions
- bridge package version
- Modal release SHA

### Nix

```bash
nix develop   # Enter dev shell with Node.js + Playwright
pnpm install
pnpm dev
```

## Development

```bash
pnpm install      # Install dependencies
pnpm dev          # Start dev server with tsx
pnpm typecheck    # Run TypeScript type checking
pnpm build        # Compile TypeScript to dist/
pnpm test         # Run tests
```

## License

MIT
