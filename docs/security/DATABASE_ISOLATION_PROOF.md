# Database Isolation Proof

**Purpose:** answer the auditor/acquirer question "how do you make sure Company A can't see
Company B's data?" with exact code references, not a description of typical SaaS practice.
Verified against the live codebase 2026-07-07.

## Tenant identifier

Every tenant-scoped table carries a required `accountId` foreign key to `Account`
(`server/prisma/schema.prisma`) — e.g. `Site`, `Asset`, `WorkOrder`, `Deficiency`,
`MaintenanceSchedule`. `MaintenanceTaskDefinition.accountId` is the one intentional exception:
it's nullable to support globally-seeded system rows shared across all tenants (task
templates), not a gap in per-tenant data. Compound unique constraints and indexes are keyed on
`accountId` (e.g. `@@unique([accountId, equipmentType, taskCode])`), so uniqueness itself is
tenant-scoped, not global.

## How accountId reaches a request

`server/middleware/auth.ts` — `authenticateToken()`:
1. Verifies the Bearer JWT (dual-secret rotation supported).
2. Looks up the user **fresh from the database** on every request —
   `prisma.user.findUnique({ where: { id: decoded.userId }, select: { accountId, ... } })` —
   rather than trusting an `accountId` claim baked into the token itself. This means a stale
   or forged token claim can't smuggle a different account's ID through; the account
   assignment is re-checked against current DB state on every call.
3. Sets `req.user.accountId`, available to every downstream route handler.
4. A `tokenEpoch` check invalidates all previously-issued tokens instantly on password change —
   revocation doesn't wait for token TTL expiry.

## How the tenant filter is enforced

**Application-layer filtering, not database-layer.** There is no Postgres row-level security
and no Prisma middleware/extension that auto-injects the tenant filter. Every route handler
manually includes `accountId: req.user.accountId` in its Prisma `where` clause — for example
`server/routes/assets.ts` carries an explicit header comment ("TENANCY: every prisma query in
this file filters by req.user.accountId") and every list/read/write query follows it.

**What this means in practice, stated plainly for diligence purposes:** isolation is a
discipline enforced by code review and test coverage, not a database-level guarantee that
would hold even if a query forgot the filter. This is a common and defensible pattern for a
single-database multi-tenant SaaS at this stage, but it is not the same claim as "the database
itself cannot return cross-tenant rows regardless of application code" (true row-level
security). Worth knowing precisely which claim you're making to an auditor.

## Test coverage proving isolation

At least 15 tests explicitly verify cross-tenant queries return zero rows or 404, not partial
or leaked data, including:
- `server/__tests__/routes/accountExport.test.ts` — a full account-data export for account B
  never contains account A's asset serial numbers.
- `server/__tests__/routes/accessBlockers.test.ts` — a different account gets 404 (not an
  empty list, an outright not-found) when trying to read or delete another account's blocker.
- `server/__tests__/routes/arcFlashDevice.test.ts` and `arcFlashIngest.test.ts` — multiple
  tests named `cross-account` covering the arc-flash module specifically.

## Field-tech sub-scoping (narrower than account-wide)

`server/lib/fieldRoleScope.ts` implements a second, narrower isolation layer: the `field_tech`
role is restricted below the account level to only its assigned work, enforced at the
middleware chokepoint (`server/middleware/auth.ts`) before a request ever reaches a route
handler.

## Honest gap to name if asked

No Postgres-level RLS policy exists. If an auditor specifically asks "would a query that
forgot the accountId filter still be blocked by the database," the accurate answer today is
no — it would return cross-tenant data. The mitigations are: (a) the explicit per-file
tenancy-invariant comments, (b) 15+ regression tests that would fail if a route regressed, and
(c) every new tenant-touching route going through the same reviewed pattern. Adding RLS as a
defense-in-depth second layer is a reasonable future hardening item, not something broken today.
