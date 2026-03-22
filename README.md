# acuity-middleware

Playwright-based Acuity Scheduling booking middleware. Proxies booking operations through browser automation, enabling programmatic access to Acuity's scheduling wizard without API access.

## Architecture

An HTTP server wrapping Playwright wizard flows that automate the Acuity booking UI. The middleware uses Effect TS for resource lifecycle management (browser/page acquisition and release) and fp-ts for composable error handling.

```
HTTP Request
  -> server.ts (route matching, auth, JSON serialization)
    -> steps/ (Effect TS programs for each wizard stage)
      -> browser-service.ts (Playwright lifecycle via Effect Layer)
        -> selectors.ts (CSS selector registry with fallback chains)
```

### Key Components

- **server.ts** -- Standalone Node.js HTTP server with Bearer token auth
- **browser-service.ts** -- Effect TS Layer managing Playwright browser/page lifecycle
- **acuity-wizard.ts** -- Full `SchedulingAdapter` implementation (local Playwright or remote HTTP proxy)
- **remote-adapter.ts** -- HTTP client adapter for proxying to a remote middleware instance
- **selectors.ts** -- Single source of truth for all Acuity DOM selectors
- **steps/** -- Individual wizard step programs (navigate, fill-form, bypass-payment, submit, extract)
- **acuity-scraper.ts** -- Read-only scraper for services, dates, and time slots

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth required) |
| GET | `/services` | List all appointment types |
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

## Deployment

### Standalone Node.js

```bash
pnpm install
pnpm dev           # Development with tsx
# or
pnpm build && pnpm start  # Production
```

### Docker

```bash
docker build -t acuity-middleware .
docker run -p 3001:3001 \
  -e AUTH_TOKEN=your-secret-token \
  -e ACUITY_BASE_URL=https://YourBusiness.as.me \
  -e ACUITY_BYPASS_COUPON=your-coupon-code \
  acuity-middleware
```

### Modal Labs

```bash
# Set secrets in Modal dashboard first:
#   AUTH_TOKEN, ACUITY_BASE_URL, ACUITY_BYPASS_COUPON
modal deploy modal-app.py
```

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
