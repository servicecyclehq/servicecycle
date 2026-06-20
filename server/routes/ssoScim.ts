const router = require('express').Router();
import prisma from '../lib/prisma';
const { getSsoConfig } = require('../lib/ssoConfig');
const { verifyScimSignature, isFreshTimestamp, computeEventKey, normalizeScimEvent, toEventList } = require('../lib/scim');
const { mapClaimsToRole } = require('../lib/ssoRoleMap');
const { randomToken } = require('../lib/ssoPkce');
const { writeLog: writeActivityLog } = require('../lib/activityLog');

// Replay window for the signature timestamp. The dedupe ledger is the primary
// replay defense; this bounds the window for a replay-after-secret-capture.
// 0 disables. Default 15 min (Polis delivers/retries promptly).
const TOLERANCE_MS = (() => {
  const v = parseInt(process.env.SCIM_WEBHOOK_TOLERANCE_MS || '900000', 10);
  return Number.isFinite(v) ? v : 900000;
})();

const PRIVILEGED = new Set(['admin', 'oem_admin', 'super_admin']);
const RANK: Record<string, number> = { viewer: 1, consultant: 2, manager: 3 };

/** Deactivate: flip isActive AND bump tokenEpoch to kill outstanding tokens. */
async function deactivateUser(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { isActive: false, tokenEpoch: { increment: 1 } },
  });
}

/**
 * Process one normalized event against the resolved directory's account.
 * Idempotent: user writes upsert on (scimDirectoryId, scimExternalId) / email.
 * Cross-tenant safe: never touches a user that belongs to another account.
 * Returns a short status string for the ledger.
 */
async function processEvent(ev: any, dir: any): Promise<string> {
  const accountId = dir.accountId;

  // Group lifecycle events: no per-user effect; recorded for completeness.
  if (ev.kind === 'group' && (ev.type === 'group.created' || ev.type === 'group.updated' || ev.type === 'group.deleted')) {
    return 'group_noop';
  }

  // From here on it's a user event (incl. group.user_added/removed which carry
  // the full user payload).
  const scimUserId = ev.scimUserId;
  const email = ev.email ? String(ev.email).trim().toLowerCase() : null;

  // Locate any existing user: prefer the SCIM identity, then email.
  let user = null;
  if (scimUserId) {
    user = await prisma.user.findUnique({
      where: { scimDirectoryId_scimExternalId: { scimDirectoryId: dir.id, scimExternalId: scimUserId } },
    }).catch(() => null);
  }
  if (!user && email) {
    user = await prisma.user.findUnique({ where: { email } }).catch(() => null);
  }

  // Cross-tenant guard: an existing user in a DIFFERENT account is never touched.
  if (user && user.accountId !== accountId) {
    writeActivityLog({ userId: user.id, accountId: user.accountId, action: 'scim_cross_tenant_blocked', details: { directoryAccountId: accountId, scimUserId } });
    return 'cross_tenant_blocked';
  }

  // ── Deletion / deactivation ──────────────────────────────────────────────
  if (ev.type === 'user.deleted') {
    if (user && user.isActive) {
      await deactivateUser(user.id);
      writeActivityLog({ userId: user.id, accountId, action: 'scim_user_deactivated', details: { reason: 'deleted', scimUserId } });
    }
    return 'deleted';
  }

  // Deactivation arrives as user.updated with active:false (verified finding).
  if ((ev.type === 'user.created' || ev.type === 'user.updated') && ev.active === false) {
    if (user && user.isActive) {
      await deactivateUser(user.id);
      writeActivityLog({ userId: user.id, accountId, action: 'scim_user_deactivated', details: { reason: 'inactive', scimUserId } });
    } else if (!user) {
      // create-as-inactive: nothing to provision.
      return 'created_inactive_noop';
    }
    return 'deactivated';
  }

  // ── Group membership: upgrade-only role bump (never auto-downgrade) ────────
  if (ev.type === 'group.user_added' || ev.type === 'group.user_removed') {
    if (!user) return 'membership_no_user';
    if (ev.type === 'group.user_removed') return 'membership_removed_noop'; // never auto-downgrade (lockout safety)
    if (PRIVILEGED.has(user.role)) return 'membership_privileged_noop';
    const mappings = await prisma.ssoRoleMapping.findMany({ where: { accountId } });
    const mapped = mapClaimsToRole({ claimGroups: ev.group ? [ev.group.name] : [], mappings: mappings.map((m: any) => ({ idpGroup: m.idpGroup, role: m.role })), defaultRole: user.role });
    if (RANK[mapped] > RANK[user.role]) {
      await prisma.user.update({ where: { id: user.id }, data: { role: mapped } });
      writeActivityLog({ userId: user.id, accountId, action: 'scim_role_upgraded', details: { from: user.role, to: mapped, group: ev.group?.name } });
      return 'role_upgraded';
    }
    return 'membership_no_change';
  }

  // ── Create / update (active) ─────────────────────────────────────────────
  const name = [ev.firstName, ev.lastName].filter(Boolean).join(' ').trim() || (email ? email.split('@')[0] : 'SSO User');

  if (user) {
    // Update existing: backfill SCIM identity, mark managed, refresh name +
    // reactivate. Never change a privileged role; otherwise leave role as-is
    // (role changes flow through group.user_added).
    await prisma.user.update({
      where: { id: user.id },
      data: {
        name,
        isActive: true,
        ssoManaged: true,
        scimDirectoryId: dir.id,
        scimExternalId: scimUserId || user.scimExternalId,
        ...(email ? { email } : {}),
      },
    });
    writeActivityLog({ userId: user.id, accountId, action: 'scim_user_updated', details: { scimUserId } });
    return 'updated';
  }

  // Create new: needs an email (unique key). No usable password (SCIM-managed).
  if (!email) return 'created_skipped_no_email';
  const mappings = await prisma.ssoRoleMapping.findMany({ where: { accountId } });
  const role = mapClaimsToRole({
    claimGroups: Array.isArray(ev.raw?.roles) ? ev.raw.roles : [],
    mappings: mappings.map((m: any) => ({ idpGroup: m.idpGroup, role: m.role })),
    defaultRole: 'viewer',
  });
  const created = await prisma.user.create({
    data: {
      accountId, name, email, role, isActive: true, ssoManaged: true,
      passwordHash: `!sso-no-password!${randomToken(24)}`,
      scimDirectoryId: dir.id, scimExternalId: scimUserId || null,
    },
  });
  writeActivityLog({ userId: created.id, accountId, action: 'scim_user_provisioned', details: { scimUserId, role } });
  return 'created';
}

// ─── POST /api/sso/scim/webhook ───────────────────────────────────────────────
// Mounted BEFORE express.json so req.rawBody holds the exact bytes the HMAC
// signature covers. Fails CLOSED on any signature problem.
router.post('/webhook', async (req: any, res: any) => {
  let cfg;
  try { cfg = getSsoConfig(); }
  catch (e: any) {
    if (e.code === 'SSO_DISABLED') return res.status(404).json({ error: 'Not found' });
    console.error('[sso-scim] misconfigured (fail closed):', e.message);
    return res.status(503).json({ error: 'SCIM unavailable' });
  }

  const rawBody = typeof req.rawBody === 'string' ? req.rawBody : '';
  if (!rawBody) return res.status(400).json({ error: 'Empty body' });

  // Signature (fail closed). Accept either Polis header name.
  const header = req.headers['boxyhq-signature'] || req.headers['ory-polis-signature'];
  const { valid, t } = verifyScimSignature(rawBody, header, cfg.scimWebhookSecret);
  if (!valid) {
    console.warn('[sso-scim] signature verification FAILED — rejecting');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  if (!isFreshTimestamp(t, TOLERANCE_MS)) {
    console.warn('[sso-scim] signature timestamp outside replay window — rejecting');
    return res.status(401).json({ error: 'Stale signature' });
  }

  const events = toEventList(req.body);
  let processed = 0, skipped = 0, batchError = false;

  for (const rawEvent of events) {
    const ev = normalizeScimEvent(rawEvent);
    if (!ev) { skipped++; continue; }

    const eventKey = computeEventKey(JSON.stringify(rawEvent));

    // Idempotency/replay: a successfully-processed event is skipped on redelivery.
    const seen = await prisma.scimEvent.findUnique({ where: { eventKey } }).catch(() => null);
    if (seen && seen.status === 'processed') { skipped++; continue; }

    // Resolve the directory -> account.
    const dir = await prisma.scimDirectory.findUnique({ where: { polisDirectoryId: ev.polisDirectoryId } });
    if (!dir || !dir.isActive) {
      await recordEvent(eventKey, ev, null, 'ignored_unknown_directory');
      skipped++;
      continue;
    }

    try {
      const status = await processEvent(ev, dir);
      await recordEvent(eventKey, ev, dir.id, status.startsWith('cross_tenant') ? 'error' : 'processed');
      processed++;
    } catch (e: any) {
      console.error('[sso-scim] event processing error:', e.message);
      await recordEvent(eventKey, ev, dir.id, 'error');
      batchError = true;
    }
  }

  // If anything errored, 500 so Polis retries; processed events are skipped next
  // time (idempotent), errored events reprocess (status != 'processed').
  if (batchError) return res.status(500).json({ error: 'One or more events failed', processed, skipped });
  return res.status(200).json({ success: true, processed, skipped });
});

async function recordEvent(eventKey: string, ev: any, directoryId: string | null, status: string) {
  try {
    await prisma.scimEvent.upsert({
      where: { eventKey },
      create: { eventKey, polisDirectoryId: ev.polisDirectoryId || null, directoryId, eventType: ev.type, status },
      update: { status, directoryId },
    });
  } catch (e: any) {
    console.warn('[sso-scim] ledger write failed:', e.message);
  }
}

module.exports = router;

export {};
