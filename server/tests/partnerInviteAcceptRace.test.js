"use strict";

const crypto = require("crypto");
function hashOf(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/**
 * Concurrency regression (2026-07-12 race-siblings sweep). POST
 * /api/invite/accept did an array-form `prisma.$transaction([account.update,
 * partnerInvite.update])` with NO re-check of either row's state at write
 * time. TWO distinct races share this one missing-guard mechanism:
 *
 * 1. Same invite accepted twice concurrently (single-record double-apply,
 *    same shape as the rest of this sweep): both requests read
 *    acceptedAt===null before either write, then both blindly "succeed".
 *
 * 2. TWO DIFFERENT invites (from two different partner orgs) racing to link
 *    the SAME account -- the shape the task instructions specifically flag
 *    as different from a single-record double-apply. If an invitee has a
 *    pending invite from org A and org B and accepts both nearly
 *    simultaneously, both requests read the account's `currentOrgId` as null
 *    BEFORE either transaction commits, both pass the pre-write
 *    "already linked elsewhere" check, then both unconditionally overwrite
 *    account.partnerOrgId. Whichever transaction commits last silently wins
 *    -- but BOTH invites still get marked accepted and BOTH callers see
 *    `{ success: true }`, so the losing org's caller believes it's linked
 *    when the account is actually linked to the other org.
 *
 * Fix (this commit): the transaction now does TWO guarded-updateMany claims:
 *   - partnerInvite: where { id, acceptedAt: null } -- guards race #1.
 *   - account: where { id, OR: [{partnerOrgId:null},{partnerOrgId:sameOrg}] }
 *     -- guards race #2 (re-checks the SAME precondition the read-time check
 *     above encodes, but atomically, at write time).
 * Either claim losing -> 409 with the same message the pre-existing
 * read-time checks already used, not a new response shape.
 *
 * Verified red->green (see task report): reverting this file's fix and
 * re-running this suite lets two different-org invites both "succeed" (both
 * acceptedAt set, no 409), while the fixed code produces exactly one 200 and
 * one 409 for the losing org's invite.
 */

function makeAccountStore() {
  return {
    "acct-1": { id: "acct-1", partnerOrgId: null },
  };
}
function makeInviteStore() {
  return {
    "invite-orgA": {
      id: "invite-orgA", partnerOrgId: "org-A", inviteeEmail: "user@example.com",
      tokenHash: hashOf("orgA-plaintext"), acceptedAt: null, revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000), accountId: null,
      partnerOrg: { name: "Org A Contracting" },
    },
    "invite-orgB": {
      id: "invite-orgB", partnerOrgId: "org-B", inviteeEmail: "user@example.com",
      tokenHash: hashOf("orgB-plaintext"), acceptedAt: null, revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000), accountId: null,
      partnerOrg: { name: "Org B Services" },
    },
    "invite-same-race": {
      id: "invite-same-race", partnerOrgId: "org-A", inviteeEmail: "user@example.com",
      tokenHash: hashOf("same-race-plaintext"), acceptedAt: null, revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000), accountId: null,
      partnerOrg: { name: "Org A Contracting" },
    },
    "invite-already-accepted": {
      id: "invite-already-accepted", partnerOrgId: "org-A", inviteeEmail: "user@example.com",
      tokenHash: hashOf("already-accepted-plaintext"), acceptedAt: new Date("2026-01-01T00:00:00Z"), revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000), accountId: "acct-1",
      partnerOrg: { name: "Org A Contracting" },
    },
  };
}

let accountStore;
let inviteStore;
let readGate;
function resetReadGate(need) {
  readGate = { need, resolvers: [] };
}

function makePrismaMock() {
  const client = {
    user: {
      findUnique: async ({ where }) => {
        if (where.id !== "u1") return null;
        const acct = accountStore["acct-1"];
        return {
          id: "u1", accountId: "acct-1", email: "user@example.com",
          account: { partnerOrgId: acct.partnerOrgId },
        };
      },
    },
    partnerInvite: {
      // Old (pre-fix) code path: blind update, no guard. Kept here so the
      // ORIGINAL array-form `prisma.$transaction([account.update(...),
      // partnerInvite.update(...)])` route code (reachable when this file's
      // fix is reverted for the red-side of the red->green check) can
      // actually execute.
      update: async ({ where, data }) => {
        inviteStore[where.id] = { ...inviteStore[where.id], ...data };
        return { ...inviteStore[where.id] };
      },
      findUnique: async ({ where }) => {
        const rec = Object.values(inviteStore).find((i) => i.tokenHash === where.tokenHash);
        let result = rec ? { ...rec } : null;
        // Gate the invite lookup so both concurrent requests' initial reads
        // (of THEIR OWN, possibly different, invite rows) land before either
        // proceeds to the account read / write. Faithfully models "both
        // transactions' SELECTs happen before either UPDATE" even across two
        // DIFFERENT invite rows racing on the same account.
        await new Promise((resolve) => {
          readGate.resolvers.push(resolve);
          if (readGate.resolvers.length >= readGate.need) {
            const fire = readGate.resolvers.splice(0);
            fire.forEach((r) => r());
          }
        });
        return result;
      },
      updateMany: async ({ where, data }) => {
        const rec = inviteStore[where.id];
        if (!rec) return { count: 0 };
        if (where.acceptedAt !== undefined && rec.acceptedAt !== where.acceptedAt) return { count: 0 };
        inviteStore[where.id] = { ...rec, ...data };
        return { count: 1 };
      },
    },
    account: {
      updateMany: async ({ where, data }) => {
        const rec = accountStore[where.id];
        if (!rec) return { count: 0 };
        if (Array.isArray(where.OR)) {
          const ok = where.OR.some((clause) => rec.partnerOrgId === clause.partnerOrgId);
          if (!ok) return { count: 0 };
        }
        accountStore[where.id] = { ...rec, ...data };
        return { count: 1 };
      },
      // Old (pre-fix) code path, kept for the sibling-bug demonstration below.
      update: async ({ where, data }) => {
        accountStore[where.id] = { ...accountStore[where.id], ...data };
        return { ...accountStore[where.id] };
      },
    },
    $transaction: async (arg) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg(client);
    },
  };
  client.default = client;
  return client;
}

jest.mock("../lib/prisma", makePrismaMock);
jest.mock("../lib/prisma.ts", makePrismaMock);

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req, res, next) => next(),
}));

const express = require("express");
const request = require("supertest");

let currentUser;
let app;
beforeAll(() => {
  const router = require("../routes/partnerInvitePublic");
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use("/api/invite", router);
});

beforeEach(() => {
  accountStore = makeAccountStore();
  inviteStore = makeInviteStore();
  resetReadGate(1);
  currentUser = { id: "u1", accountId: "acct-1", role: "admin" };
});

describe("POST /api/invite/accept concurrency guard", () => {
  test("two different invites (different partner orgs) racing on the same account -> exactly one 200, one 409", async () => {
    resetReadGate(2); // both requests' invite reads must land before either proceeds to write
    const [a, b] = await Promise.all([
      request(app).post("/api/invite/accept").send({ token: "orgA-plaintext" }),
      request(app).post("/api/invite/accept").send({ token: "orgB-plaintext" }),
    ]);
    // Map tokens to hashes the mock understands directly (bypass real sha256
    // by matching via the same tokenHash convention the mock's findUnique
    // uses) -- see note below; this test asserts on outcome shape, not on
    // which specific org wins.
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    expect(winner.body.success).toBe(true);

    // The account ended up linked to EXACTLY the winner's org -- not silently
    // overwritten by the loser after the fact.
    const linkedOrg = accountStore["acct-1"].partnerOrgId;
    expect(["org-A", "org-B"]).toContain(linkedOrg);
    expect(winner.body.partnerOrgName).toBe(linkedOrg === "org-A" ? "Org A Contracting" : "Org B Services");
  });

  test("the same invite accepted twice concurrently -> exactly one 200, one 409", async () => {
    resetReadGate(2);
    const fire = () => request(app).post("/api/invite/accept").send({ token: "same-race-plaintext" });
    const [a, b] = await Promise.all([fire(), fire()]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);
    expect(inviteStore["invite-same-race"].acceptedAt).not.toBeNull();
    expect(accountStore["acct-1"].partnerOrgId).toBe("org-A");
  });

  test("an already-accepted invite 409s cleanly (unchanged behavior)", async () => {
    const res = await request(app).post("/api/invite/accept").send({ token: "already-accepted-plaintext" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Invite already accepted" });
  });
});

describe("sibling-bug demonstration: the OLD blind-update pattern silently double-applies", () => {
  test('two concurrent unconditional account updates both "succeed" with no conflict raised (this is the bug the fix above prevents)', async () => {
    const prisma = require("../lib/prisma").default;
    const race = (org) => prisma.account.update({
      where: { id: "acct-1" },
      data: { partnerOrgId: org },
    });
    const [r1, r2] = await Promise.all([race("org-A"), race("org-B")]);
    expect(r1.partnerOrgId).toBeTruthy();
    expect(r2.partnerOrgId).toBeTruthy();
  });
});

module.exports = {};
