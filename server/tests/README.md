# LapseIQ test harness

This is a scaffold, not full coverage. The goal is regression protection
on the highest-value fixes shipped during the 2026-05-02 security pass:

- The CRITICAL IDOR fixes (scope-restricted viewer can't see unowned
  contracts; consultants can't write).
- The auth happy path (login, /me, token shape).
- The /api/health endpoint stability.

## Running

```bash
cd server
npm test
```

Tests run against the **dev database** at `DATABASE_URL` from `server/.env`.
They use known seed credentials (`admin@acme.com / Admin1234!`) — the
same ones the prisma seed creates. If your dev DB has had the admin
password changed, reset it first or the auth tests will fail.

## What's NOT covered yet

- Mutation / write paths — would need a transactional reset between
  tests, which is a bigger lift. For now the tests are read-only.
- Demo mode write-block enforcement.
- Multi-tenant isolation across two real accounts (we have one seed
  account).
- Stripe / Sprint 6 surfaces (no integration yet).

## Adding tests

`tests/<route>.test.js`. Each describe block should call `await login(...)`
once at the top to get a token, then exercise the route(s) under
review. Don't write to the DB unless you wrap it in a `try/finally` that
restores state, OR add a containerized test DB (issue tracked in
project_backlog.md).
