"use strict";

/**
 * Concurrency regression (2026-07-12 race-siblings sweep). POST
 * /api/sites/:id/archive did a findFirst-then-update with NO precondition on
 * archivedAt at all -- `prisma.site.update({ where: { id }, data: {
 * archivedAt: new Date() } })` unconditionally overwrites regardless of the
 * row's CURRENT archivedAt. Two near-simultaneous archive calls against the
 * same site both "succeed" (200), each re-firing the site_archived activity
 * log entry -- a duplicate-side-effect race. Same missing-atomic-guard bug
 * class as workOrders.ts COMPLETE (F9, 925eaed) and this sweep's assets.ts
 * fix (assetsArchiveRace.test.js).
 *
 * Fix (this commit): POST /:id/archive now does a guarded-updateMany claim
 * (where: { id, accountId, archivedAt: null }), checks claim.count === 0 ->
 * 409, and only fires the activity log if the claim won. Also closes the
 * pre-existing non-concurrent duplicate-log gap (repeated sequential archive
 * calls used to "succeed" every time too).
 *
 * Verified red->green (see task report): reverting this file's fix and
 * re-running this suite produces 2x200 on the concurrent-archive case and
 * 200 on a sequential re-archive, while the fixed code produces exactly one
 * 200 and one 409 (concurrent) / 409 (sequential re-archive).
 */

function makeStore() {
  return {
    "site-race": { id: "site-race", accountId: "acct-a", name: "West Allis Plant", archivedAt: null },
  };
}

let store;
let activityLogCalls;
let readGate;
function resetReadGate(need) {
  readGate = { need, resolvers: [] };
}

// Mocked TWICE (extensionless + explicit '.ts'): the unit project's
// moduleNameMapper matches sites.ts's own extensionless '../lib/prisma'
// import but NOT the bare "./prisma" import used by lib/oemTargetAccount.ts
// and lib/powerPath.ts (both required transitively by sites.ts). Same
// pattern as tests/activityLogIp.test.js.
function makePrismaMock() {
  const client = {
    site: {
      findFirst: async ({ where }) => {
        const rec = store[where.id];
        let result = null;
        if (rec) {
          const accountOk = where.accountId === undefined || rec.accountId === where.accountId;
          if (accountOk) result = { ...rec };
        }
        // Only gate the INITIAL existence-check read (where.accountId is
        // present) -- the post-claim refetch passes only { id } and must
        // resolve immediately.
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
}));

const express = require("express");
const request = require("supertest");

let currentUser;
let app;
beforeAll(() => {
  const router = require("../routes/sites");
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use("/api/sites", router);
});

beforeEach(() => {
  store = makeStore();
  activityLogCalls = [];
  resetReadGate(1);
  currentUser = { id: "u1", accountId: "acct-a", role: "manager" };
});

describe("POST /api/sites/:id/archive concurrency guard", () => {
  test("two concurrent archives on the same site -> exactly one 200, one 409", async () => {
    resetReadGate(2); // both requests' findFirst reads must land before either proceeds to write
    const fire = () => request(app).post("/api/sites/site-race/archive");
    const [a, b] = await Promise.all([fire(), fire()]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(winner.body.success).toBe(true);
    expect(loser.body).toEqual({
      success: false,
      error: "Site was already archived by another request.",
    });

    expect(store["site-race"].archivedAt).not.toBeNull();
    expect(activityLogCalls.filter((c) => c.action === "site_archived").length).toBe(1);
  });

  test("archiving an already-archived site (sequential, not concurrent) 409s cleanly", async () => {
    const first = await request(app).post("/api/sites/site-race/archive");
    expect(first.status).toBe(200);
    const second = await request(app).post("/api/sites/site-race/archive");
    expect(second.status).toBe(409);
    expect(activityLogCalls.filter((c) => c.action === "site_archived").length).toBe(1);
  });
});

describe("sibling-bug demonstration: the OLD blind-update pattern silently double-applies", () => {
  test('two concurrent unconditional updates both "succeed" with no conflict raised (this is the bug the fix above prevents)', async () => {
    const prisma = require("../lib/prisma").default;
    const race = () => prisma.site.update({
      where: { id: "site-race" },
      data: { archivedAt: new Date() },
    });
    const [r1, r2] = await Promise.all([race(), race()]);
    expect(r1.archivedAt).toBeTruthy();
    expect(r2.archivedAt).toBeTruthy();
  });
});

module.exports = {};
