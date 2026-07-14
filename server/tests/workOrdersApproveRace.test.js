"use strict";

/**
 * Concurrency regression (2026-07-12 Claude-Security-category audit, race
 * siblings finding): POST /api/work-orders/:id/approve did a plain
 * findFirst-then-update-by-id with no re-check of status at write time --
 * `prisma.workOrder.update({ where: { id }, data: {...} })` unconditionally
 * overwrites regardless of the row's CURRENT status. Two near-simultaneous
 * /approve calls against the same AWAITING_APPROVAL work order can both pass
 * the findFirst read (same precondition, unchanged by this fix) BEFORE
 * either write happens, then both blindly "succeed" (200) with the old
 * `update()` call -- silently double-applying approvedBy/approvedAt/
 * startedAt -- a lost-update race, not a rejected conflict. This is the same
 * missing-atomic-guard bug class already fixed in this file's COMPLETE
 * transition (workOrders.ts, F9 2026-06-20, commit 925eaed): a guarded
 * `updateMany({ where: { id, status: existing.status }, data })` claims the
 * row only if it is still in the expected status; a losing concurrent
 * request gets count 0 -> 409 instead of a silent double-apply.
 *
 * Fix (this commit): /approve now does the same guarded-updateMany claim
 * (where: { id, accountId, status: 'AWAITING_APPROVAL' }), checks
 * claim.count === 0 -> 409, and only then re-fetches the row for the
 * response.
 *
 * This suite uses a fake Prisma client (same pattern as
 * disasterEventsResolveGate.test.js). To actually exercise the race window
 * deterministically (rather than depend on incidental event-loop timing,
 * which can accidentally serialize two "concurrent" calls), the mocked
 * findFirst uses a small read-gate: it snapshots the row's state
 * synchronously, then blocks until N reads are in flight before resolving
 * any of them. That reproduces the real-Postgres shape of "two
 * transactions' SELECT both happen before either UPDATE" without needing
 * real threads or a live DB (this sandbox has none available). Two
 * supertest requests are then fired via Promise.all (same style as the
 * real-DB F9 race test at server/__tests__/routes/securityF9F10F11.test.ts).
 *
 * Verified red->green (see task report): reverting this file's fix (git
 * apply -R the diff) and re-running this suite produces 2×200 (both
 * "succeed", no conflict raised) on the concurrent-approve case --
 * reproducing the exact bug -- while the fixed code produces exactly one
 * 200 and one 409.
 */

function makeStore() {
  return {
    "wo-race": { id: "wo-race", accountId: "acct-a", assetId: "asset-1", status: "AWAITING_APPROVAL" },
    "wo-other-status": { id: "wo-other-status", accountId: "acct-a", assetId: "asset-2", status: "SCHEDULED" },
  };
}

let store;
let readGate;
function resetReadGate(need) {
  readGate = { need, resolvers: [] };
}

jest.mock("../lib/prisma", () => {
  const client = {
    workOrder: {
      findFirst: async ({ where }) => {
        const rec = store[where.id];
        let result = null;
        if (rec) {
          const accountOk = where.accountId === undefined || rec.accountId === where.accountId;
          const statusOk = where.status === undefined || rec.status === where.status;
          if (accountOk && statusOk) result = { id: rec.id, assetId: rec.assetId };
        }
        // Read-gate: hold this resolution open until `need` reads are in
        // flight, so concurrent callers' reads all observe the SAME
        // pre-write snapshot before any of them proceeds to write --
        // faithfully modeling two simultaneous transactions' SELECT.
        await new Promise((resolve) => {
          readGate.resolvers.push(resolve);
          if (readGate.resolvers.length >= readGate.need) {
            const fire = readGate.resolvers.splice(0);
            fire.forEach((r) => r());
          }
        });
        return result;
      },
      // Old (pre-fix) code path: blind update, no guard. Kept here so the
      // sibling "buggy behavior" test below can demonstrate the bug this
      // suite guards against, independent of which code (pre/post fix) the
      // route itself currently runs.
      update: async ({ where, data }) => {
        store[where.id] = { ...store[where.id], ...data };
        return { ...store[where.id] };
      },
      // Real-Postgres-shaped guarded update: only writes if the row still
      // matches every field in `where` (id/accountId/status) at the moment
      // this runs. This is a faithful model of `UPDATE ... WHERE id=? AND
      // account_id=? AND status=?` -- not a stub that always returns count 1.
      updateMany: async ({ where, data }) => {
        const rec = store[where.id];
        if (!rec) return { count: 0 };
        if (where.accountId !== undefined && rec.accountId !== where.accountId) return { count: 0 };
        if (where.status !== undefined && rec.status !== where.status) return { count: 0 };
        store[where.id] = { ...rec, ...data };
        return { count: 1 };
      },
      findUnique: async ({ where }) => {
        const rec = store[where.id];
        return rec ? { ...rec } : null;
      },
    },
  };
  client.default = client;
  return client;
});

jest.mock("../middleware/roles", () => ({
  requireManager: (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));
jest.mock("../lib/activityLog", () => ({ writeLog: jest.fn() }));
jest.mock("../lib/assetAlertNotifier", () => ({
  notifyConditionDegradation: jest.fn(),
  notifyDeficiencyCreated: jest.fn(),
  notifyAssetDecommissioned: jest.fn(),
}));
// This sandbox has no generated Prisma client (network-blocked from
// binaries.prisma.sh, so `prisma generate` can't run here) -- stub the tiny
// bit of the `Prisma` namespace routes/workOrders.ts actually uses
// (Prisma.DbNull, a sentinel value, not schema-dependent) so the module can
// load under jest without a real generated client.
jest.mock("@prisma/client", () => ({ Prisma: { DbNull: Symbol("DbNull") } }));

const express = require("express");
const request = require("supertest");

let currentUser;
let app;
beforeAll(() => {
  const router = require("../routes/workOrders");
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use("/api/work-orders", router);
});

beforeEach(() => {
  store = makeStore();
  resetReadGate(1);
  currentUser = { id: "u1", accountId: "acct-a", role: "manager" };
});

describe("POST /api/work-orders/:id/approve concurrency guard", () => {
  test("two concurrent approves on the same AWAITING_APPROVAL work order -> exactly one 200, one 409", async () => {
    resetReadGate(2); // both requests' findFirst reads must land before either proceeds to write
    const fire = () => request(app).post("/api/work-orders/wo-race/approve").send({ note: "ok" });
    const [a, b] = await Promise.all([fire(), fire()]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(winner.body.success).toBe(true);
    expect(loser.body).toEqual({
      success: false,
      error: "This work order was already approved or is no longer awaiting approval.",
    });

    expect(store["wo-race"].status).toBe("IN_PROGRESS");
  });

  test("a work order not in AWAITING_APPROVAL 404s cleanly (no partial claim)", async () => {
    const res = await request(app).post("/api/work-orders/wo-other-status/approve").send({});
    expect(res.status).toBe(404);
    expect(store["wo-other-status"].status).toBe("SCHEDULED");
  });
});

describe("sibling-bug demonstration: the OLD blind-update pattern silently double-applies", () => {
  test('two concurrent unconditional updates both "succeed" with no conflict raised (this is the bug the fix above prevents)', async () => {
    const prisma = require("../lib/prisma").default;
    const race = () => prisma.workOrder.update({
      where: { id: "wo-race" },
      data: { status: "IN_PROGRESS", approvedBy: "someone" },
    });
    const [r1, r2] = await Promise.all([race(), race()]);
    // Both calls "succeed" -- no count/conflict signal at all with the old
    // `update()` API, which is exactly why the route-level fix switches to
    // `updateMany` + a count check instead.
    expect(r1.status).toBe("IN_PROGRESS");
    expect(r2.status).toBe("IN_PROGRESS");
  });
});

module.exports = {};
