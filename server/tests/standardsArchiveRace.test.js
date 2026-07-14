"use strict";

/**
 * Concurrency regression (2026-07-12 race-siblings sweep). POST
 * /api/standards/task-definitions/:id/archive did a gate-read-then-check-
 * archivedAt-then-update, with NO re-check of archivedAt at write time --
 * `prisma.maintenanceTaskDefinition.update({ where: { id }, data: {
 * archivedAt: new Date() } })` unconditionally overwrites regardless of the
 * row's CURRENT archivedAt. Two near-simultaneous archive calls against the
 * same task definition can both pass the `if (gate.def.archivedAt)` guard
 * (read from the SAME pre-write snapshot) before either write happens, then
 * both blindly "succeed" (200) -- a lost-update race, not a rejected
 * conflict. Same missing-atomic-guard bug class as workOrders.ts COMPLETE
 * (F9, 925eaed).
 *
 * Fix (this commit): POST /:id/archive now does a guarded-updateMany claim
 * (where: { id, archivedAt: null }), checks claim.count === 0 -> 409, and
 * only then refetches the row for the response.
 *
 * Verified red->green (see task report): reverting this file's fix and
 * re-running this suite produces 2x200 on the concurrent-archive case,
 * while the fixed code produces exactly one 200 and one 409.
 */

function makeStore() {
  return {
    "taskdef-race": { id: "taskdef-race", accountId: "acct-a", archivedAt: null },
    "taskdef-already-archived": { id: "taskdef-already-archived", accountId: "acct-a", archivedAt: new Date("2026-01-01T00:00:00Z") },
    "taskdef-global": { id: "taskdef-global", accountId: null, archivedAt: null },
  };
}

let store;
let readGate;
function resetReadGate(need) {
  readGate = { need, resolvers: [] };
}

// Mocked TWICE (extensionless + explicit '.ts') for consistency with the
// other race tests in this sweep, even though standards.ts's own transitive
// deps (validate, equipmentTypes) don't appear to import prisma themselves.
function makePrismaMock() {
  const client = {
    maintenanceTaskDefinition: {
      findFirst: async ({ where }) => {
        let rec = null;
        if (where.id !== undefined) {
          rec = store[where.id] || null;
        }
        // findEditableTaskDef's gate query: { id, OR: [{accountId:null},{accountId}] }
        if (rec && Array.isArray(where.OR)) {
          const ok = where.OR.some((clause) =>
            (clause.accountId === null && rec.accountId === null) ||
            (clause.accountId !== null && clause.accountId === rec.accountId)
          );
          if (!ok) rec = null;
        }
        if (rec && where.archivedAt !== undefined && rec.archivedAt !== where.archivedAt) {
          rec = null;
        }
        // Only gate the INITIAL gate-read (carries an OR clause) -- the
        // post-claim refetch (bare { id }) must resolve immediately.
        if (Array.isArray(where.OR)) {
          await new Promise((resolve) => {
            readGate.resolvers.push(resolve);
            if (readGate.resolvers.length >= readGate.need) {
              const fire = readGate.resolvers.splice(0);
              fire.forEach((r) => r());
            }
          });
        }
        return rec ? { ...rec } : null;
      },
      // Old (pre-fix) code path, kept for the sibling-bug demonstration below.
      update: async ({ where, data }) => {
        store[where.id] = { ...store[where.id], ...data };
        return { ...store[where.id] };
      },
      updateMany: async ({ where, data }) => {
        const rec = store[where.id];
        if (!rec) return { count: 0 };
        if (where.archivedAt !== undefined && rec.archivedAt !== where.archivedAt) return { count: 0 };
        store[where.id] = { ...rec, ...data };
        return { count: 1 };
      },
    },
  };
  client.default = client;
  return client;
}

jest.mock("../lib/prisma", makePrismaMock);
jest.mock("../lib/prisma.ts", makePrismaMock);

jest.mock("../middleware/roles", () => ({
  requireAdmin: (req, res, next) => next(),
}));

const express = require("express");
const request = require("supertest");

let currentUser;
let app;
beforeAll(() => {
  const router = require("../routes/standards");
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use("/api/standards", router);
});

beforeEach(() => {
  store = makeStore();
  resetReadGate(1);
  currentUser = { id: "u1", accountId: "acct-a", role: "admin" };
});

describe("POST /api/standards/task-definitions/:id/archive concurrency guard", () => {
  test("two concurrent archives on the same task definition -> exactly one 200, one 409", async () => {
    resetReadGate(2); // both requests' gate reads must land before either proceeds to write
    const fire = () => request(app).post("/api/standards/task-definitions/taskdef-race/archive");
    const [a, b] = await Promise.all([fire(), fire()]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(winner.body.success).toBe(true);
    expect(loser.body).toEqual({
      success: false,
      error: "Task definition was already archived by another request.",
    });

    expect(store["taskdef-race"].archivedAt).not.toBeNull();
  });

  test("an already-archived task definition 400s cleanly (unchanged behavior)", async () => {
    const res = await request(app).post("/api/standards/task-definitions/taskdef-already-archived/archive");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "Task definition is already archived" });
  });

  test("a global (accountId=null) task definition 403s cleanly (unchanged behavior)", async () => {
    const res = await request(app).post("/api/standards/task-definitions/taskdef-global/archive");
    expect(res.status).toBe(403);
  });
});

describe("sibling-bug demonstration: the OLD blind-update pattern silently double-applies", () => {
  test('two concurrent unconditional updates both "succeed" with no conflict raised (this is the bug the fix above prevents)', async () => {
    const prisma = require("../lib/prisma").default;
    const race = () => prisma.maintenanceTaskDefinition.update({
      where: { id: "taskdef-race" },
      data: { archivedAt: new Date() },
    });
    const [r1, r2] = await Promise.all([race(), race()]);
    expect(r1.archivedAt).toBeTruthy();
    expect(r2.archivedAt).toBeTruthy();
  });
});

module.exports = {};
