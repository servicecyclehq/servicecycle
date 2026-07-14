"use strict";

/**
 * Concurrency regression (2026-07-12 race-siblings sweep). DELETE
 * /api/fleet/invites/:id did a findFirst-then-check-revokedAt-then-update,
 * with NO re-check of revokedAt at write time -- `prisma.partnerInvite.
 * update({ where: { id }, data: { revokedAt: new Date() } })`
 * unconditionally overwrites regardless of the row's CURRENT revokedAt. Two
 * near-simultaneous revoke calls against the same pending invite can both
 * pass the `if (invite.revokedAt)` guard (read from the SAME pre-write
 * snapshot) before either write happens, then both blindly "succeed" (200)
 * -- a lost-update race, not a rejected conflict. Same missing-atomic-guard
 * bug class as workOrders.ts COMPLETE (F9, 925eaed).
 *
 * Fix (this commit): DELETE /invites/:id now does a guarded-updateMany
 * claim (where: { id, partnerOrgId, revokedAt: null }), checks
 * claim.count === 0 -> 409.
 *
 * Verified red->green (see task report): reverting this file's fix and
 * re-running this suite produces 2x200 on the concurrent-revoke case,
 * while the fixed code produces exactly one 200 and one 409.
 */

function makeStore() {
  return {
    "invite-race": { id: "invite-race", partnerOrgId: "org-1", revokedAt: null },
    "invite-already-revoked": { id: "invite-already-revoked", partnerOrgId: "org-1", revokedAt: new Date("2026-01-01T00:00:00Z") },
  };
}

let store;
let readGate;
function resetReadGate(need) {
  readGate = { need, resolvers: [] };
}

function makePrismaMock() {
  const client = {
    account: {
      findUnique: async ({ where }) => {
        // Caller's own account resolves to org-1's partnerOrgId for this suite.
        if (where.id === "acct-oem") return { partnerOrgId: "org-1" };
        return null;
      },
    },
    partnerInvite: {
      findFirst: async ({ where }) => {
        const rec = store[where.id];
        let result = null;
        if (rec) {
          const orgOk = where.partnerOrgId === undefined || rec.partnerOrgId === where.partnerOrgId;
          if (orgOk) result = { ...rec };
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
        if (where.partnerOrgId !== undefined && rec.partnerOrgId !== where.partnerOrgId) return { count: 0 };
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
  requireOemAdmin: (req, res, next) => next(),
}));

const express = require("express");
const request = require("supertest");

let currentUser;
let app;
beforeAll(() => {
  const router = require("../routes/fleetDashboard");
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use("/api/fleet", router);
});

beforeEach(() => {
  store = makeStore();
  resetReadGate(1);
  currentUser = { id: "u1", accountId: "acct-oem", role: "oem_admin" };
});

describe("DELETE /api/fleet/invites/:id concurrency guard", () => {
  test("two concurrent revokes on the same pending invite -> exactly one 200, one 409", async () => {
    resetReadGate(2); // both requests' findFirst reads must land before either proceeds to write
    const fire = () => request(app).delete("/api/fleet/invites/invite-race");
    const [a, b] = await Promise.all([fire(), fire()]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(winner.body.success).toBe(true);
    expect(loser.body).toEqual({ error: "Invite was already revoked by another request." });

    expect(store["invite-race"].revokedAt).not.toBeNull();
  });

  test("an already-revoked invite 409s cleanly (unchanged behavior)", async () => {
    const res = await request(app).delete("/api/fleet/invites/invite-already-revoked");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Already revoked" });
  });
});

describe("sibling-bug demonstration: the OLD blind-update pattern silently double-applies", () => {
  test('two concurrent unconditional updates both "succeed" with no conflict raised (this is the bug the fix above prevents)', async () => {
    const prisma = require("../lib/prisma").default;
    const race = () => prisma.partnerInvite.update({
      where: { id: "invite-race" },
      data: { revokedAt: new Date() },
    });
    const [r1, r2] = await Promise.all([race(), race()]);
    expect(r1.revokedAt).toBeTruthy();
    expect(r2.revokedAt).toBeTruthy();
  });
});

module.exports = {};
