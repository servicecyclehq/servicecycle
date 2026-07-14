"use strict";

/**
 * Concurrency regression (2026-07-12 race-siblings sweep). POST
 * /api/share-links/:id/revoke did a findFirst-then-check-revokedAt-then-
 * update, with NO re-check of revokedAt at write time -- `prisma.shareLink.
 * update({ where: { id }, data: { revokedAt: new Date() } })` unconditionally
 * overwrites regardless of the row's CURRENT revokedAt. Two near-simultaneous
 * revoke calls against the same active link can both pass the `if (!existing.
 * revokedAt)` guard (read from the SAME pre-write snapshot) before either
 * write happens, then both fire writeActivityLog -- double-logging the
 * revoke. Same missing-atomic-guard bug class as workOrders.ts COMPLETE
 * (F9, 925eaed).
 *
 * IMPORTANT judgment call (see task report): unlike the other fixes in this
 * sweep, this endpoint's contract is deliberately idempotent-quiet --
 * revoking an already-revoked link has NEVER been an error here (no 409, no
 * 400 -- just `{ success: true }` either way). The fix therefore does NOT add
 * a new 409 response; both the winner and the loser of a concurrent revoke
 * still get `{ success: true }`, matching the pre-existing contract. What the
 * atomic claim actually fixes is the duplicate activity-log write: only the
 * winner's claim (count > 0) fires writeActivityLog.
 *
 * Verified red->green (see task report): reverting this file's fix and
 * re-running this suite produces 2 activity-log entries for one concurrent
 * revoke, while the fixed code produces exactly 1 (both requests still
 * report { success: true } either way -- that part is unchanged by design).
 */

function makeStore() {
  return {
    "link-race": { id: "link-race", accountId: "acct-a", revokedAt: null },
    "link-already-revoked": { id: "link-already-revoked", accountId: "acct-a", revokedAt: new Date("2026-01-01T00:00:00Z") },
  };
}

let store;
let activityLogCalls;
let readGate;
function resetReadGate(need) {
  readGate = { need, resolvers: [] };
}

function makePrismaMock() {
  const client = {
    shareLink: {
      findFirst: async ({ where }) => {
        const rec = store[where.id];
        let result = null;
        if (rec) {
          const accountOk = where.accountId === undefined || rec.accountId === where.accountId;
          if (accountOk) result = { id: rec.id, revokedAt: rec.revokedAt };
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
      // Old (pre-fix) code path, kept for the sibling-bug demonstration below.
      update: async ({ where, data }) => {
        store[where.id] = { ...store[where.id], ...data };
        return { ...store[where.id] };
      },
      updateMany: async ({ where, data }) => {
        const rec = store[where.id];
        if (!rec) return { count: 0 };
        if (where.accountId !== undefined && rec.accountId !== where.accountId) return { count: 0 };
        if (where.revokedAt !== undefined && rec.revokedAt !== where.revokedAt) return { count: 0 };
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
  requireManager: (req, res, next) => next(),
}));
jest.mock("../lib/activityLog", () => ({
  writeLog: (...args) => { activityLogCalls.push(args[0]); },
}));
jest.mock("../lib/complianceReport", () => ({ buildComplianceGap: jest.fn() }));
jest.mock("../lib/underwritingPackage", () => ({ buildUnderwritingPackage: jest.fn() }));

const express = require("express");
const request = require("supertest");

let currentUser;
let app;
beforeAll(() => {
  const router = require("../routes/shareLinks");
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use("/api/share-links", router);
});

beforeEach(() => {
  store = makeStore();
  activityLogCalls = [];
  resetReadGate(1);
  currentUser = { id: "u1", accountId: "acct-a", role: "manager" };
});

describe("POST /api/share-links/:id/revoke concurrency guard", () => {
  test("two concurrent revokes on the same active link -> both report success, but the activity log fires exactly once", async () => {
    resetReadGate(2); // both requests' findFirst reads must land before either proceeds to write
    const fire = () => request(app).post("/api/share-links/link-race/revoke");
    const [a, b] = await Promise.all([fire(), fire()]);

    // Idempotent-quiet by design: no 409 introduced by this fix.
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual({ success: true });
    expect(b.body).toEqual({ success: true });

    expect(store["link-race"].revokedAt).not.toBeNull();
    // The real bug this fix closes: without the atomic guard, BOTH concurrent
    // requests fire the activity log. With it, exactly one does.
    expect(activityLogCalls.filter((c) => c.action === "share_link_revoked").length).toBe(1);
  });

  test("revoking an already-revoked link is a quiet no-op (unchanged behavior)", async () => {
    const res = await request(app).post("/api/share-links/link-already-revoked/revoke");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(activityLogCalls.length).toBe(0);
  });
});

describe("sibling-bug demonstration: the OLD blind-update pattern silently double-applies", () => {
  test('two concurrent unconditional updates both "succeed" with no conflict raised (this is the bug the fix above prevents)', async () => {
    const prisma = require("../lib/prisma").default;
    const race = () => prisma.shareLink.update({
      where: { id: "link-race" },
      data: { revokedAt: new Date() },
    });
    const [r1, r2] = await Promise.all([race(), race()]);
    expect(r1.revokedAt).toBeTruthy();
    expect(r2.revokedAt).toBeTruthy();
  });
});

module.exports = {};
