"use strict";

/**
 * Concurrency regression (2026-07-12 race-siblings sweep). DELETE
 * /api/consultant-access/:id did a findFirst-then-check-isActive-then-
 * transaction with NO re-check of isActive at write time --
 * `prisma.consultantAccess.update({ where: { id }, data: {...} })` inside the
 * transaction array form unconditionally overwrites regardless of the row's
 * CURRENT isActive. Two near-simultaneous revoke calls against the same
 * active grant can both pass the `if (!record.isActive)` guard (read from
 * the SAME pre-write snapshot) before either write happens, then both
 * blindly "succeed" (200) -- silently double-applying revokedById/
 * revokedAt -- a lost-update race, not a rejected conflict. Same
 * missing-atomic-guard bug class as workOrders.ts COMPLETE (F9, 925eaed).
 *
 * Fix (this commit): DELETE /:id now does a guarded-updateMany claim inside
 * the transaction (where: { id, accountId, isActive: true }), checks
 * claim.count === 0 -> 409, and only deactivates the consultant user +
 * refetches the row if the claim won.
 *
 * Same read-gate technique as workOrdersApproveRace.test.js: the mocked
 * findFirst blocks until N reads are in flight before resolving any of
 * them, deterministically reproducing "both requests' SELECT happen before
 * either UPDATE" without needing real threads or a live DB.
 *
 * Verified red->green (see task report): reverting this file's fix and
 * re-running this suite produces 2x200 on the concurrent-revoke case, while
 * the fixed code produces exactly one 200 and one 409.
 */

function makeStore() {
  return {
    "consultant-race": {
      id: "consultant-race", accountId: "acct-a", consultantId: "user-c1",
      isActive: true, revokedById: null, revokedAt: null,
    },
    "consultant-already-revoked": {
      id: "consultant-already-revoked", accountId: "acct-a", consultantId: "user-c2",
      isActive: false, revokedById: "u0", revokedAt: new Date("2026-01-01T00:00:00Z"),
    },
  };
}

let store;
let userStore;
let readGate;
function resetReadGate(need) {
  readGate = { need, resolvers: [] };
}

jest.mock("../lib/prisma", () => {
  const client = {
    consultantAccess: {
      findFirst: async ({ where }) => {
        const rec = store[where.id];
        let result = null;
        if (rec) {
          const accountOk = where.accountId === undefined || rec.accountId === where.accountId;
          if (accountOk) result = { ...rec };
        }
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
      // ORIGINAL array-form `prisma.$transaction([update(...), update(...)])`
      // route code (still reachable when this file's fix is reverted for the
      // red-side of the red->green check) can actually execute, and so the
      // sibling-bug demonstration test below can run directly against it.
      update: async ({ where, data }) => {
        store[where.id] = { ...store[where.id], ...data };
        return { ...store[where.id] };
      },
      updateMany: async ({ where, data }) => {
        const rec = store[where.id];
        if (!rec) return { count: 0 };
        if (where.accountId !== undefined && rec.accountId !== where.accountId) return { count: 0 };
        if (where.isActive !== undefined && rec.isActive !== where.isActive) return { count: 0 };
        store[where.id] = { ...rec, ...data };
        return { count: 1 };
      },
      findUnique: async ({ where }) => {
        const rec = store[where.id];
        return rec ? { ...rec } : null;
      },
    },
    user: {
      update: async ({ where, data }) => {
        userStore[where.id] = { ...(userStore[where.id] || {}), ...data };
        return { id: where.id, ...userStore[where.id] };
      },
    },
    // Supports BOTH the fixed code's function-form `$transaction(async tx =>
    // ...)` and the pre-fix code's array-form `$transaction([update(...),
    // update(...)])` (each array element is already an in-flight promise by
    // the time it gets here, since nothing defers them in this fake client --
    // a faithful-enough model for demonstrating the old code's lack of any
    // atomic guard).
    $transaction: async (arg) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg(client);
    },
  };
  client.default = client;
  return client;
});

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req, res, next) => next(),
}));
jest.mock("../middleware/roles", () => ({
  requireAdmin: (req, res, next) => next(),
}));

const express = require("express");
const request = require("supertest");

let currentUser;
let app;
beforeAll(() => {
  const router = require("../routes/consultant");
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use("/api/consultant-access", router);
});

beforeEach(() => {
  store = makeStore();
  userStore = { "user-c1": { isActive: true }, "user-c2": { isActive: false } };
  resetReadGate(1);
  currentUser = { id: "u1", accountId: "acct-a", role: "admin" };
});

describe("DELETE /api/consultant-access/:id concurrency guard", () => {
  test("two concurrent revokes on the same active grant -> exactly one 200, one 409", async () => {
    resetReadGate(2); // both requests' findFirst reads must land before either proceeds to write
    const fire = () => request(app).delete("/api/consultant-access/consultant-race");
    const [a, b] = await Promise.all([fire(), fire()]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(winner.body.success).toBe(true);
    expect(loser.body).toEqual({
      success: false,
      error: "This consultant access was already revoked by another request.",
    });

    expect(store["consultant-race"].isActive).toBe(false);
    // Deactivation side-effect fired exactly once (not lost, not doubled in
    // a way that would matter since it's idempotent -- but confirms the
    // winner's transaction actually completed the user update).
    expect(userStore["user-c1"].isActive).toBe(false);
  });

  test("an already-revoked grant 400s cleanly (unchanged behavior)", async () => {
    const res = await request(app).delete("/api/consultant-access/consultant-already-revoked");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: "This access has already been revoked" });
  });
});

describe("sibling-bug demonstration: the OLD blind-update pattern silently double-applies", () => {
  test('two concurrent unconditional updates both "succeed" with no conflict raised (this is the bug the fix above prevents)', async () => {
    const prisma = require("../lib/prisma").default;
    const race = () => prisma.consultantAccess.update({
      where: { id: "consultant-race" },
      data: { isActive: false, revokedById: "someone", revokedAt: new Date() },
    });
    const [r1, r2] = await Promise.all([race(), race()]);
    expect(r1.isActive).toBe(false);
    expect(r2.isActive).toBe(false);
  });
});

module.exports = {};
