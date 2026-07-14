"use strict";

/**
 * Concurrency regression (2026-07-12 Claude-Security-category audit, race
 * siblings finding): POST /api/deficiencies/:id/resolve did a plain
 * findFirst-then-check-resolvedAt-then-update, with no re-check of
 * resolvedAt at write time -- `prisma.deficiency.update({ where: { id:
 * existing.id }, data: updateData })` unconditionally overwrites regardless
 * of the row's CURRENT resolvedAt. Two near-simultaneous /resolve calls
 * against the same open deficiency can both pass the `if (existing.
 * resolvedAt)` guard (read from the SAME pre-write snapshot) before either
 * write happens, then both blindly "succeed" (200) -- silently
 * double-applying resolvedById/correctiveAction (the second caller's note
 * gets appended on top of the first's, and resolvedById is overwritten) --
 * a lost-update race, not a rejected conflict. This is the same
 * missing-atomic-guard bug class already fixed in workOrders.ts' COMPLETE
 * transition (F9, 2026-06-20, commit 925eaed) and this same audit's
 * workOrders.ts /approve fix (workOrdersApproveRace.test.js): a guarded
 * `updateMany({ where: { id, resolvedAt: null }, data })` claims the row
 * only if it is still unresolved; a losing concurrent request gets count 0
 * -> 409 instead of a silent double-apply.
 *
 * Fix (this commit): /resolve now does a guarded-updateMany claim (where:
 * { id, accountId, resolvedAt: null }), checks claim.count === 0 -> 409, and
 * only then re-fetches the row (with its include) for the response.
 *
 * Same read-gate technique as workOrdersApproveRace.test.js: the mocked
 * findFirst used for the INITIAL existence/resolvedAt check blocks until N
 * reads are in flight before resolving any of them, deterministically
 * reproducing "both transactions' SELECT happen before either UPDATE"
 * without needing real threads or a live DB. The POST-claim refetch (which
 * passes an `include`) is answered immediately -- it happens after the
 * atomic claim has already resolved the race, so gating it would only
 * reintroduce false serialization into the test itself.
 *
 * Verified red->green (see task report): reverting this file's fix (git
 * apply -R the diff) and re-running this suite produces 2x200 (both
 * "succeed", no conflict raised, corrective-action note doubled) on the
 * concurrent-resolve case -- reproducing the exact bug -- while the fixed
 * code produces exactly one 200 and one 409.
 */

function makeStore() {
  return {
    "def-race": {
      id: "def-race", accountId: "acct-a", assetId: "asset-1", severity: "ADVISORY",
      resolvedAt: null, resolvedById: null, correctiveAction: null, workOrderId: null,
    },
    "def-already-resolved": {
      id: "def-already-resolved", accountId: "acct-a", assetId: "asset-2", severity: "ADVISORY",
      resolvedAt: new Date("2026-01-01T00:00:00Z"), resolvedById: "u0", correctiveAction: "done", workOrderId: null,
    },
  };
}

let store;
let readGate;
function resetReadGate(need) {
  readGate = { need, resolvers: [] };
}

jest.mock("../lib/prisma", () => {
  const client = {
    deficiency: {
      findFirst: async ({ where, include }) => {
        const rec = store[where.id];
        let result = null;
        if (rec) {
          const accountOk = where.accountId === undefined || rec.accountId === where.accountId;
          const resolvedOk = where.resolvedAt === undefined || rec.resolvedAt === where.resolvedAt;
          if (accountOk && resolvedOk) result = { ...rec };
        }
        // Only gate the INITIAL bare read (no `include`) -- the post-claim
        // refetch passes `include` and must resolve immediately, since the
        // race has already been decided by the updateMany claim by then.
        if (!include) {
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
      // Old (pre-fix) code path: blind update, no guard.
      update: async ({ where, data }) => {
        store[where.id] = { ...store[where.id], ...data };
        return { ...store[where.id] };
      },
      // Real-Postgres-shaped guarded update: only writes if the row still
      // matches every field in `where` (id/accountId/resolvedAt) at the
      // moment this runs.
      updateMany: async ({ where, data }) => {
        const rec = store[where.id];
        if (!rec) return { count: 0 };
        if (where.accountId !== undefined && rec.accountId !== where.accountId) return { count: 0 };
        if (where.resolvedAt !== undefined && rec.resolvedAt !== where.resolvedAt) return { count: 0 };
        store[where.id] = { ...rec, ...data };
        return { count: 1 };
      },
    },
  };
  client.default = client;
  return client;
});

jest.mock("../middleware/roles", () => ({
  requireManager: (req, res, next) => next(),
}));
jest.mock("../lib/activityLog", () => ({ writeLog: jest.fn() }));
jest.mock("../lib/assetAlertNotifier", () => ({
  notifyConditionDegradation: jest.fn(),
  notifyDeficiencyCreated: jest.fn(),
  notifyAssetDecommissioned: jest.fn(),
}));

const express = require("express");
const request = require("supertest");

let currentUser;
let app;
beforeAll(() => {
  const router = require("../routes/deficiencies");
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use("/api/deficiencies", router);
});

beforeEach(() => {
  store = makeStore();
  resetReadGate(1);
  currentUser = { id: "u1", accountId: "acct-a", role: "manager" };
});

describe("POST /api/deficiencies/:id/resolve concurrency guard", () => {
  test("two concurrent resolves on the same open deficiency -> exactly one 200, one 409", async () => {
    resetReadGate(2); // both requests' findFirst reads must land before either proceeds to write
    const fire = () => request(app).post("/api/deficiencies/def-race/resolve").send({ resolution: "fixed it" });
    const [a, b] = await Promise.all([fire(), fire()]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(winner.body.success).toBe(true);
    expect(loser.body).toEqual({
      success: false,
      error: "This deficiency was already resolved by another request.",
    });

    expect(store["def-race"].resolvedAt).not.toBeNull();
    // Exactly one resolution note landed -- not both callers' notes stacked.
    expect((store["def-race"].correctiveAction.match(/\[Resolved\]/g) || []).length).toBe(1);
  });

  test("an already-resolved deficiency 400s cleanly (unchanged behavior)", async () => {
    const res = await request(app).post("/api/deficiencies/def-already-resolved/resolve").send({ resolution: "again" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Deficiency is already resolved" });
  });
});

describe("sibling-bug demonstration: the OLD blind-update pattern silently double-applies", () => {
  test('two concurrent unconditional updates both "succeed" with no conflict raised (this is the bug the fix above prevents)', async () => {
    const prisma = require("../lib/prisma").default;
    const race = () => prisma.deficiency.update({
      where: { id: "def-race" },
      data: { resolvedAt: new Date(), resolvedById: "someone" },
    });
    const [r1, r2] = await Promise.all([race(), race()]);
    expect(r1.resolvedAt).toBeTruthy();
    expect(r2.resolvedAt).toBeTruthy();
  });
});

module.exports = {};
