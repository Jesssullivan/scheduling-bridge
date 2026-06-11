# Architecture

## Request Flow

```text
HTTP request
-> src/server/handler.ts
-> shared service-catalog resolution
-> adapter step programs
-> BrowserService / BrowserProcess Effect layers
-> Playwright page session
-> Acuity UI
```

## Ownership Boundary

- This repo owns browser automation, remote bridge endpoints, and runtime packaging.
- `@tummycrypt/scheduling-kit` owns backend-agnostic scheduling contracts and shared primitives.
- `MassageIthaca` is an adopter; it should consume bridge exports instead of duplicating bridge logic.

## Effect Usage

Effect belongs where lifecycle and failure semantics are real:

- warm browser process startup and reuse
- request-scoped page acquisition and release
- retryable step orchestration
- typed failure mapping back to HTTP or downstream adapter callers

Keep synchronous utility code simple. Do not introduce Effect wrappers where there is no
resource boundary, retry surface, or compositional correctness benefit.

## Runtime Shape

- `src/server/handler.ts` is the real HTTP entrypoint.
- `src/server/health.ts` defines the supported protocol and release tuple.
- `src/shared/browser-service.ts` is the browser resource boundary.
- `src/shared/acuity-service-catalog.ts` is the service truth aggregator.
- `src/shared/remote-adapter.ts` is the downstream consumer surface for remote mode.
