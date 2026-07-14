"use strict";

/**
 * Concurrency regression (2026-07-12 race-siblings sweep). POST
 * /api/assets/:id/archive did a findFirst-then-update with NO precondition
 * on archivedAt at all (not even a sequential-call guard) -- `prisma.asset.
 * update({ where: { id }, data: { archivedAt: new Date() } })` unconditionally
 * overwrites regardless of the row's CURRENT archivedAt. Two near-simultaneous
 * archive calls against the same asset both "succeed" (200), each re-firing
 * the asset_archived activity log entry AND the decommission notification --
 * a duplicate-side-effect race (archivedAt itself is monotonic/idempotent, but
 * the side effects are not). Same missing-atomic-guard bug class as
 * workOrders.ts COMPLETE (F9, 925eaed).
 *
 * Fix (this commit): POST /:id/archive now does a guarded-updateMany claim
 * (where: { id, accountId, archivedAt: null }), checks claim.count === 0 ->
 * 409, and only fires the activity log + notification if the claim won.
 * This also closes a pre-existing NON-concurrent gap: previously even two
 * sequential (non-racing) archive calls both "succeeded" and duplicated the
 * side effects; now the second call 409s, same as standards.ts's existing
 * archive-twice guard.
 *
 * Same read-gate technique as workOrdersApproveRace.test.js: the mocked
 * findFirst blocks until N reads are in flight before resolving any of them.
 *
 * Verified red->green (see task report): reverting this file's fix and
 * re-running this suite produces 2x200 (both "succeed") on the concurrent-
 * archive case, while the fixed code produces exactly one 200 and one 409.
 */

function makeStore() {
  return {
    "asset-race": {
      id: "asset-race", accountId: "acct-a", manufacturer: "ACME", model: "X1",
      archivedAt: null,
    },
  };
}

let store;
let activityLogCalls;
let readGate;
function resetReadGate(need) {
  readGate = { need, resolvers: [] };
}

// Mocked TWICE, at both the extensionless and the explicit '.ts' path: the
// unit project's moduleNameMapper ('^(\.{1,2}/.*)/prisma$' -> a global no-op
// stub) matches assets.ts's own extensionless '../lib/prisma' import, but
// does NOT match activityLog.ts's bare "./prisma" import (no path segment
// before the trailing /prisma) -- and assets.ts pulls in activityLog.ts
// transitively via ./customFields. Mocking only the extensionless form would
// leave activityLog.ts's "./prisma" resolving to the REAL client (which then
// fails to load because this sandbox has no generated Prisma Client). Same
// fix as tests/activityLogIp.test.js.
function makePrismaMock() {
  const client = {
    asset: {
      findFirst: async ({ where }) => {
        const rec = store[where.id];
        let result = null;
        if (rec) {
          const accountOk = where.accountId === undefined || rec.accountId === where.accountId;
          const archivedOk = where.archivedAt === undefined || rec.archivedAt === where.archivedAt;
          if (accountOk && archivedOk) result = { ...rec };
        }
        // Only gate the INITIAL existence-check read (where.accountId is
        // present) -- the post-claim refetch passes only { id } and must
        // resolve immediately, since the race has already been decided by
        // the updateMany claim by then.
        if (where.accountId !== undefined) {
          await new Promise((resolve) => {
            readGate.resolvers.push(resolve);
            if (readGate.resolvers.length >= readGate.need) {
              const fire = readGate.resolvers.splice(0);
              fire.forEach((r) => r());
            }
          });
        }
        return result;
      },
      // Old (pre-fix) code path, kept for the sibling-bug demonstration below.
      update: async ({ where, data }) => {
        store[where.id] = { ...store[where.id], ...data };
        return { ...store[where.id] };
      },
      updateMany: async ({ where, data }) => {
        const rec = store[where.id];
        if (!rec) return { count: 0 };
        if (where.accountId !== undefined && rec.accountId !== where.accountId) return { count: 0 };
        if (where.archivedAt !== undefined && rec.archivedAt !== where.archivedAt) return { count: 0 };
        store[where.id] = { ...rec, ...data };
        return { count: 1 };
      },
    },
    activityLog: {
      create: async ({ data }) => {
        activityLogCalls.push(data);
        return { id: `log-${activityLogCalls.length}`, ...data };
      },
    },
  };
  client.default = client;
  return client;
}

jest.mock("../lib/prisma", makePrismaMock);
jest.mock("../lib/prisma.ts", makePrismaMock);

jest.mock("../middleware/roles", () => ({
  requireManager: (req, res, next) => next(),
  // customFields.ts (transitively required via ./customFields for the
  // validateValueForDefinition helper) also needs requireAdmin at its own
  // module load time (router.post('/', requireAdmin, ...) etc.).
  requireAdmin: (req, res, next) => next(),
}));
jest.mock("../lib/assetAlertNotifier", () => ({
  notifyConditionDegradation: jest.fn(),
  notifyAssetDecommissioned: jest.fn(() => Promise.resolve()),
}));

const express = require("express");
const request = require("supertest");

let currentUser;
let app;
beforeAll(() => {
  const router = require("../routes/assets");
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use("/api/assets", router);
});

beforeEach(() => {
  store = makeStore();
  activityLogCalls = [];
  resetReadGate(1);
  currentUser = { id: "u1", accountId: "acct-a", role: "manager", name: "Test Mgr" };
  const { notifyAssetDecommissioned } = require("../lib/assetAlertNotifier");
  notifyAssetDecommissioned.mockClear();
});

describe("POST /api/assets/:id/archive concurrency guard", () => {
  test("two concurrent archives on the same asset -> exactly one 200, one 409", async () => {
    resetReadGate(2); // both requests' findFirst reads must land before either proceeds to write
    const fire = () => request(app).post("/api/assets/asset-race/archive");
    const [a, b] = await Promise.all([fire(), fire()]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(winner.body.success).toBe(true);
    expect(loser.body).toEqual({
      success: false,
      error: "Asset was already archived by another request.",
    });

    expect(store["asset-race"].archivedAt).not.toBeNull();
    // The activity log entry must fire exactly ONCE, not twice.
    expect(activityLogCalls.filter((c) => c.action === "asset_archived").length).toBe(1);
  });

  test("archiving an already-archived asset (sequential, not concurrent) 409s cleanly", async () => {
    const first = await request(app).post("/api/assets/asset-race/archive");
    expect(first.status).toBe(200);
    const second = await request(app).post("/api/assets/asset-race/archive");
    expect(second.status).toBe(409);
    expect(activityLogCalls.filter((c) => c.action === "asset_archived").length).toBe(1);
  });
});

describe("sibling-bug demonstration: the OLD blind-update pattern silently double-applies", () => {
  test('two concurrent unconditional updates both "succeed" with no conflict raised (this is the bug the fix above prevents)', async () => {
    const prisma = require("../lib/prisma").default;
    const race = () => prisma.asset.update({
      where: { id: "asset-race" },
      data: { archivedAt: new Date() },
    });
    const [r1, r2] = await Promise.all([race(), race()]);
    expect(r1.archivedAt).toBeTruthy();
    expect(r2.archivedAt).toBeTruthy();
  });
});

module.exports = {};
