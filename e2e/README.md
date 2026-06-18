# ServiceCycle E2E + Smoke Tests

Playwright-driven tests targeting the live demo (or any ServiceCycle instance via `E2E_BASE_URL`).

## Test files

- **smoke.spec.js** (v0.90.2) — Authenticated deploy-smoke. Logs in as admin@demo.local, visits every protected route, asserts no `ErrorBoundary` heading; pings every documented API endpoint, asserts 200 + key body fields. **This is the gate that catches "page X crashes on load" + API shape regressions.** Run after every deploy.
- **00-smoke.spec.js** — No-auth public surface smoke (login/register/forgot-password render).
- **01-register-login.spec.js** — Auth round-trip.
- **02-contract-list.spec.js** — Contracts page renders after fresh registration.
- **03-api-key.spec.js** — Public API key creation + fetch.
- **04-admin-endpoints.spec.js** — Admin-only endpoints (db-pool-health, /admin/metrics).

## Quick reference

```bash
# Run everything against the default target (servicecycle.app)
npm run test:e2e

# Just the deploy smoke (the v0.90.2 gate — runs in ~25s)
npx playwright test smoke.spec.js

# Override target (local docker-compose, staging, etc.)
E2E_BASE_URL=http://localhost:5173 npm run test:e2e

# Override creds (for non-demo instances)
E2E_ADMIN_EMAIL=admin@example.com E2E_ADMIN_PASSWORD=secret npm run test:e2e
```

## Smoke suite design

`smoke.spec.js` is structured so a single non-zero exit blocks the deploy. It tests:

1. **Auth** — `/api/auth/login` returns a token.
2. **Every protected route** — navigates, asserts no `ErrorBoundary` heading appears, asserts body has content. Catches render-time crashes anywhere in the SPA.
3. **Every documented API endpoint** — sends authenticated GET, asserts expected status + (where applicable) key fields in response body. Catches the v0.89.7-style "wrong Prisma relation name" 500 + the v0.89.2-style "endpoint shape changed" cascade.
4. **`POST /api/errors/render`** liveness — confirms the telemetry endpoint accepts a well-formed POST.

To add a new route or endpoint check: edit the `PROTECTED_ROUTES` or `API_ENDPOINTS` array at the top of `smoke.spec.js`. No new boilerplate needed.

## Wired into deploy

Post-v0.90.3, the MCP deploy pipeline invokes this suite automatically after `compose up -d`. On non-zero exit, the wrapper script flips `SERVICECYCLE_VERSION` back to `SERVICECYCLE_VERSION_PREV` and re-composes. See `deploy/run-smoke-with-rollback.sh`.
