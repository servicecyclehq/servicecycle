/**
 * demoPrune.js  (L3)
 *
 * Per-visitor demo account lifecycle: deletion of one account's owned
 * data + the account row, plus the nightly inactivity sweep that calls
 * it for every per-visitor sandbox the visitor hasn't touched in 5 days.
 *
 * Lives ONLY for DEMO_MODE instances. The on-prem product never calls any
 * of this — Account.lastActiveAt is null on those rows and stays that way.
 *
 * Hard cap: DEMO_MAX_ACCOUNTS (env, default 1000). When the account count
 * exceeds the cap after the TTL sweep, we additionally prune the oldest
 * by lastActiveAt regardless of TTL so registration never starts failing
 * on a busy demo. This is the operator's "registration is open, infra is
 * fixed-cost, accept the cap" policy lever.
 *
 * The legacy DEMO_ACCOUNT_ID account (4 fixed users seeded by
 * scripts/seed-demo.js) is excluded from every prune so visitors using
 * the documented seeded credentials still have a sandbox to land in.
 */

import prisma from './prisma';
const { DEMO_ACCOUNT_ID } = require('../scripts/seed-demo');

const TTL_DAYS_DEFAULT = 5;
const MAX_ACCOUNTS_DEFAULT = 1000;

function getTtlDays() {
  const raw = process.env.DEMO_INACTIVITY_TTL_DAYS;
  if (!raw) return TTL_DAYS_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : TTL_DAYS_DEFAULT;
}

function getMaxAccounts() {
  const raw = process.env.DEMO_MAX_ACCOUNTS;
  if (!raw) return MAX_ACCOUNTS_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : MAX_ACCOUNTS_DEFAULT;
}

/**
 * Delete every row owned by one Account, then the Account row itself.
 * Mirrors the dependency-ordered delete chain in scripts/seed-demo.js
 * _resetDemoAccount — keeps both in sync if you add a new owned model.
 *
 * Idempotent: if the account doesn't exist (or never had child rows)
 * this returns { deleted: false } without throwing.
 */
async function pruneAccount(accountId) {
  if (!accountId) throw new Error('pruneAccount: accountId required');
  if (accountId === DEMO_ACCOUNT_ID) {
    // Hard guard — caller bug if we ever try to prune the legacy seed.
    throw new Error('pruneAccount: refusing to prune the legacy DEMO_ACCOUNT_ID');
  }

  const filter = { accountId };

  // Order matters: delete child rows before the account, descending by
  // dependency depth. Each `.catch(() => {})` swallows P2025 "not found"
  // so the chain is safe on accounts that had nothing of a given type.
  //
  // v0.7.3 sandbox-isolation audit (carried into the asset model): explicitly
  // drop rows in the child-of-child tables BEFORE their parent records get
  // deleted. Most of these would cascade via Prisma's `onDelete: Cascade`
  // declarations, but several required FKs are "no-action" (WorkOrder.assetId,
  // Asset.siteId, ContractorTech.contractorId, Building/Area/Position.siteId)
  // and would FK-error if the parent went first. Belt-and-suspenders:
  // explicit deletes first; cascade handles the rest. Order matters within
  // each block — deepest leaves first.

  // ── Activity / audit (some rows have null assetId; cascade won't catch them)
  await prisma.activityLog.deleteMany({
    where: {
      OR: [
        { accountId },
        { asset: { accountId } },
        { user: { accountId } },
      ],
    },
  }).catch(() => {});

  // ── User-scoped per-user state (cascade-from-user is set on these but
  // the explicit delete makes the chain order-independent)
  await prisma.refreshToken.deleteMany({ where: { user: { accountId } } }).catch(() => {});
  await prisma.aiUsage.deleteMany({ where: { user: { accountId } } }).catch(() => {}); // L1 added
  await prisma.alertPreference.deleteMany({ where: { user: { accountId } } }).catch(() => {});
  await prisma.userPreference.deleteMany({ where: { user: { accountId } } }).catch(() => {});

  // ── Work-order / schedule leaves (TestMeasurement cascades from WorkOrder
  // but is deleted explicitly so the chain order never matters)
  await prisma.testMeasurement.deleteMany({ where: filter }).catch(() => {});
  await prisma.deficiency.deleteMany({ where: filter }).catch(() => {});
  await prisma.labSample.deleteMany({ where: filter }).catch(() => {});
  await prisma.alert.deleteMany({ where: filter }).catch(() => {});
  await prisma.workOrder.deleteMany({ where: filter }).catch(() => {});       // BEFORE assets (assetId is no-action)
  await prisma.maintenanceSchedule.deleteMany({ where: filter }).catch(() => {});
  // Tenant custom task definitions only — global seed rows have accountId NULL
  // and are shared by every sandbox, so the accountId filter must never widen.
  await prisma.maintenanceTaskDefinition.deleteMany({ where: filter }).catch(() => {});

  // ── Asset-scoped leaves
  await prisma.customFieldValue.deleteMany({ where: { asset: { accountId } } }).catch(() => {});
  await prisma.communication.deleteMany({ where: filter }).catch(() => {});
  await prisma.ingestionSession.deleteMany({ where: filter }).catch(() => {});
  await prisma.document.deleteMany({ where: filter }).catch(() => {});

  // ── Assets, then the site hierarchy bottom-up (all required site FKs are
  // no-action, so children must go before sites)
  await prisma.asset.deleteMany({ where: filter }).catch(() => {});
  await prisma.equipmentPosition.deleteMany({ where: filter }).catch(() => {});
  await prisma.area.deleteMany({ where: filter }).catch(() => {});
  await prisma.building.deleteMany({ where: filter }).catch(() => {});
  await prisma.systemStudy.deleteMany({ where: filter }).catch(() => {});
  await prisma.blackoutWindow.deleteMany({ where: filter }).catch(() => {});
  await prisma.site.deleteMany({ where: filter }).catch(() => {});

  // ── Contractor-scoped leaves (ContractorTech.contractorId is no-action)
  await prisma.contractorTech.deleteMany({ where: { contractor: { accountId } } }).catch(() => {});
  await prisma.contractor.deleteMany({ where: filter }).catch(() => {});

  // ── Account-scoped lookups + integration surfaces
  await prisma.standardRevisionAlert.deleteMany({ where: filter }).catch(() => {});
  await prisma.customFieldDefinition.deleteMany({ where: filter }).catch(() => {});
  await prisma.notificationLog.deleteMany({ where: filter }).catch(() => {});
  await prisma.outboundWebhookDLQ.deleteMany({ where: filter }).catch(() => {});
  await prisma.webhookEndpoint.deleteMany({ where: filter }).catch(() => {});
  await prisma.apiKey.deleteMany({ where: filter }).catch(() => {});
  await prisma.consultantAccess.deleteMany({ where: filter }).catch(() => {});
  await prisma.userInvite.deleteMany({ where: filter }).catch(() => {});
  await prisma.accountSetting.deleteMany({ where: filter }).catch(() => {});
  await prisma.backupLog.deleteMany({ where: filter }).catch(() => {});
  await prisma.user.deleteMany({ where: filter }).catch(() => {});

  try {
    await prisma.account.delete({ where: { id: accountId } });
    return { deleted: true };
  } catch (err) {
    if (err.code === 'P2025') return { deleted: false }; // already gone
    throw err;
  }
}

/**
 * Inactivity sweep: prune every per-visitor demo account whose last activity
 * is older than the TTL, plus extra-old ones if we're over the hard cap.
 *
 * Returns a summary of what was deleted. Cheap on a fresh demo (the
 * lastActiveAt index makes the SELECT bounded).
 */
async function pruneInactiveDemoAccounts() {
  const ttlDays = getTtlDays();
  const cap     = getMaxAccounts();
  const cutoff  = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);

  // ── Pass 1: TTL prune ────────────────────────────────────────────────────
  // lastActiveAt < cutoff       → user was active but went idle
  // lastActiveAt IS NULL AND createdAt < cutoff
  //                             → user registered but never logged back in
  const ttlVictims = await prisma.account.findMany({
    where: {
      id: { not: DEMO_ACCOUNT_ID },
      OR: [
        { lastActiveAt: { lt: cutoff } },
        { AND: [{ lastActiveAt: null }, { createdAt: { lt: cutoff } }] },
      ],
    },
    select: { id: true },
  });

  let prunedTtl = 0;
  for (const a of ttlVictims) {
    try {
      const r = await pruneAccount(a.id);
      if (r.deleted) prunedTtl++;
    } catch (e) {
      console.error(`[demoPrune] TTL prune ${a.id} failed:`, e.message);
    }
  }

  // ── Pass 2: cap enforcement ──────────────────────────────────────────────
  // Counts AFTER pass 1 so we don't over-prune. Excludes the legacy seed
  // from the count so it never eats a slot.
  const remaining = await prisma.account.count({
    where: { id: { not: DEMO_ACCOUNT_ID } },
  });

  let prunedCap = 0;
  if (remaining > cap) {
    const overflow = remaining - cap;
    // Oldest-first by lastActiveAt; nulls sorted as oldest by COALESCE
    // because null lastActiveAt means "never returned".
    const capVictims = await prisma.account.findMany({
      where:   { id: { not: DEMO_ACCOUNT_ID } },
      orderBy: [{ lastActiveAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
      take:    overflow,
      select:  { id: true },
    });
    for (const a of capVictims) {
      try {
        const r = await pruneAccount(a.id);
        if (r.deleted) prunedCap++;
      } catch (e) {
        console.error(`[demoPrune] cap prune ${a.id} failed:`, e.message);
      }
    }
  }

  return {
    ttlDays,
    cap,
    cutoff:    cutoff.toISOString(),
    prunedTtl,
    prunedCap,
    remaining: remaining - prunedCap,
  };
}

module.exports = {
  pruneAccount,
  pruneInactiveDemoAccounts,
  getTtlDays,
  getMaxAccounts,
};

export {};
