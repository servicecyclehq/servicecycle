"use strict";

/**
 * Concurrency regression (2026-07-12 race-siblings sweep, follow-up to the
 * workOrders.ts /approve and deficiencies.ts /resolve fixes): DELETE
 * /api/settings/api-keys/:id did a plain findFirst-then-check-revokedAt-then-
 * update, with no re-check of revokedAt at write time -- `prisma.apiKey.
 * update({ where: { id }, data: { revokedAt: new Date() } })` unconditionally
 * overwrites regardless of the row's CURRENT revokedAt. Two near-simultaneous
 * revoke calls against the same active key can both pass the `if (existing.
 * revokedAt)` guard (read from the SAME pre-write snapshot) before either
 * write happens, then both blindly "succeed" (200) -- silently double-firing
 * the api_key_revoked activity log entry -- a lost-update race, not a
 * rejected conflict. Same missing-atomic-guard bug class as workOrders.ts
 * COMPLETE (F9, 925eaed) and this sweep's other fixes: a guarded
 * `updateMany({ where: { id, accountId, revokedAt: null }, data })` claims
 * the row only if it is still active; a losing concurrent request gets
 * count 0 -> 409 instead of a silent double-apply.
 *
 * Fix (this commit): DELETE /:id now does the guarded-updateMany claim
 * (where: { id, accountId, revokedAt: null }), checks claim.count === 0 ->
 * 409, and only then writes the activity log entry.
 *
 * Same read-gate technique as workOrdersApproveRace.test.js: the mocked
 * findFirst blocks until N reads are in flight before resolving any of them,
 * deterministically reproducing "both requests' SELECT happen before either
 * UPDATE" without needing real threads or a live DB.
 *
 * Verified red->green (see task report): reverting this file's fix and
 * re-running this suite produces 2x200 (both "succeed") on the concurrent-
 * revoke case, while the fixed code produces exactly one 200 and one 409.
 */

function makeStore() {
  return {
    "key-race": { id: "key-race", accountId: "acct-a", revokedAt: null },
    "key-already-revoked": { id: "key-already-revoked", accountId: "acct-a", revokedAt: new Date("2026-01-01T00:00:00Z") },
  };
}

let store;
let readGate;
function resetReadGate(need) {
  readGate = { need, resolvers: [] };
}

jest.mock("../lib/prisma", () => {
  const client = {
    apiKey: {
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
      // Real-Postgres-shaped guarded update.
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
});

jest.mock("../middleware/roles", () => ({
  requireAdmin: (req, res, next) => next(),
}));
jest.mock("../middleware/apiKeyAuth", () => ({
  hashApiKey: (plaintext) => `hashed:${plaintext}`,
}));
jest.mock("../lib/activityLog", () => ({ writeLog: jest.fn() }));

const express = require("express");
const request = require("supertest");

let currentUser;
let app;
beforeAll(() => {
  const router = require("../routes/apiKeys");
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use("/api/settings/api-keys", router);
});

beforeEach(() => {
  store = makeStore();
  resetReadGate(1);
  currentUser = { id: "u1", accountId: "acct-a", role: "admin" };
});

describe("DELETE /api/settings/api-keys/:id concurrency guard", () => {
  test("two concurrent revokes on the same active key -> exactly one 200, one 409", async () => {
    resetReadGate(2); // both requests' findFirst reads must land before either proceeds to write
    const fire = () => request(app).delete("/api/settings/api-keys/key-race");
    const [a, b] = await Promise.all([fire(), fire()]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(winner.body.success).toBe(true);
    expect(loser.body).toEqual({
      success: false,
      error: "API key was already revoked by another request.",
    });

    expect(store["key-race"].revokedAt).not.toBeNull();
  });

  test("an already-revoked key 409s cleanly (unchanged behavior)", async () => {
    const res = await request(app).delete("/api/settings/api-keys/key-already-revoked");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, error: "API key is already revoked" });
  });
});

describe("sibling-bug demonstration: the OLD blind-update pattern silently double-applies", () => {
  test('two concurrent unconditional updates both "succeed" with no conflict raised (this is the bug the fix above prevents)', async () => {
    const prisma = require("../lib/prisma").default;
    const race = () => prisma.apiKey.update({
      where: { id: "key-race" },
      data: { revokedAt: new Date() },
    });
    const [r1, r2] = await Promise.all([race(), race()]);
    expect(r1.revokedAt).toBeTruthy();
    expect(r2.revokedAt).toBeTruthy();
  });
});

module.exports = {};
