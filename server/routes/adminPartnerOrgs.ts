export {};
/**
 * /api/admin/partner-orgs — super_admin management of PartnerOrganizations.
 *
 * Routes:
 *   GET    /api/admin/partner-orgs              — list all orgs with counts
 *   POST   /api/admin/partner-orgs              — create a PartnerOrganization
 *   PATCH  /api/admin/partner-orgs/:id          — update name/logo/colors/website
 *   DELETE /api/admin/partner-orgs/:id          — hard-delete if no accounts; else soft-delete
 *   POST   /api/admin/partner-orgs/:id/link-account    — link an existing account (ops bypass)
 *   POST   /api/admin/partner-orgs/:id/create-oem-user — create first oem_admin login
 *
 * Auth: authenticateToken + requireSuperAdmin (applied at mount point in index.ts)
 */

const express   = require('express');
const bcrypt    = require('bcryptjs');
const prisma    = require('../lib/prisma').default;

const router = express.Router();

// ── GET /api/admin/partner-orgs ──────────────────────────────────────────────
// List all PartnerOrganizations with account count and oem_admin user count.
router.get('/', async (req: any, res: any) => {
  try {
    // SECURITY: never serialize webhookSecret (the 32-byte HMAC-SHA256 signing
    // key) into an API response — it can land in browser history / proxy logs
    // and lets a holder forge signed webhook payloads. Explicit select omits it.
    // F10: soft-deleted orgs are marked with a "[DELETED] " name prefix (no
    // deletedAt column). Hide them from the management list so they read as gone.
    const orgs = await prisma.partnerOrganization.findMany({
      where: { NOT: { name: { startsWith: '[DELETED]' } } },
      select: {
        id: true, name: true, logoUrl: true, primaryColor: true, website: true,
        webhookUrl: true, digestIntervalDays: true, createdAt: true, updatedAt: true,
        _count: { select: { accounts: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Attach oem_admin count per org (users whose account.partnerOrgId = org.id)
    const orgIds = orgs.map((o: any) => o.id);
    const oemCounts = await prisma.user.groupBy({
      by: ['accountId'],
      where: {
        role: 'oem_admin',
        isActive: true,
        account: { partnerOrgId: { in: orgIds } },
      },
      _count: { id: true },
    });

    // Build orgId → oemAdminCount map via accounts
    const accountToOrg = await prisma.account.findMany({
      where: { partnerOrgId: { in: orgIds } },
      select: { id: true, partnerOrgId: true },
    });
    const accountOrgMap = new Map(accountToOrg.map((a: any) => [a.id, a.partnerOrgId]));
    const oemCountMap = new Map<string, number>();
    for (const row of oemCounts) {
      const orgId = accountOrgMap.get(row.accountId);
      if (orgId) {
        oemCountMap.set(orgId as string, (oemCountMap.get(orgId as string) || 0) + (row._count.id as number));
      }
    }

    const result = orgs.map((org: any) => ({
      ...org,
      accountCount: org._count.accounts,
      oemAdminCount: oemCountMap.get(org.id) || 0,
      _count: undefined,
    }));

    res.json({ orgs: result });
  } catch (err) {
    console.error('[adminPartnerOrgs GET /]', err);
    res.status(500).json({ error: 'Failed to list partner orgs' });
  }
});

// ── POST /api/admin/partner-orgs ─────────────────────────────────────────────
// Create a new PartnerOrganization.
router.post('/', async (req: any, res: any) => {
  try {
    const { name, logoUrl, primaryColor, website } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const org = await prisma.partnerOrganization.create({
      data: {
        name: name.trim(),
        logoUrl:      logoUrl      ?? null,
        primaryColor: primaryColor ?? null,
        website:      website      ?? null,
      },
      select: {
        id: true, name: true, logoUrl: true, primaryColor: true, website: true,
        webhookUrl: true, digestIntervalDays: true, createdAt: true, updatedAt: true,
      },
    });

    res.status(201).json({ org });
  } catch (err: any) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'A partner org with that name already exists' });
    }
    console.error('[adminPartnerOrgs POST /]', err);
    res.status(500).json({ error: 'Failed to create partner org' });
  }
});

// ── PATCH /api/admin/partner-orgs/:id ────────────────────────────────────────
// Update name / logoUrl / primaryColor / website.
router.patch('/:id', async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const { name, logoUrl, primaryColor, website } = req.body;

    const existing = await prisma.partnerOrganization.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Partner org not found' });

    const data: Record<string, any> = {};
    if (name !== undefined) {
      // Guard the .trim() below: a non-string name (number/object/array) would
      // throw and surface as a 500 instead of a clean 400.
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name must be a non-empty string' });
      }
      data.name = name.trim();
    }
    if (logoUrl    !== undefined) data.logoUrl       = logoUrl;
    if (primaryColor !== undefined) data.primaryColor = primaryColor;
    if (website    !== undefined) data.website       = website;

    const org = await prisma.partnerOrganization.update({
      where: { id }, data,
      select: {
        id: true, name: true, logoUrl: true, primaryColor: true, website: true,
        webhookUrl: true, digestIntervalDays: true, createdAt: true, updatedAt: true,
      },
    });
    res.json({ org });
  } catch (err) {
    console.error('[adminPartnerOrgs PATCH /:id]', err);
    res.status(500).json({ error: 'Failed to update partner org' });
  }
});

// ── DELETE /api/admin/partner-orgs/:id ───────────────────────────────────────
// Hard-delete if no linked accounts; soft-delete (deletedAt) otherwise.
router.delete('/:id', async (req: any, res: any) => {
  try {
    const { id } = req.params;

    const existing = await prisma.partnerOrganization.findUnique({
      where: { id },
      include: { _count: { select: { accounts: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Partner org not found' });

    if (existing._count.accounts === 0) {
      // Safe to hard-delete
      await prisma.partnerOrganization.delete({ where: { id } });
      return res.json({ deleted: true, hard: true });
    }

    // Soft-delete: mark updatedAt so clients can detect the change.
    // PartnerOrganization doesn't have a deletedAt field — add it via raw update
    // using a notes/website field is not clean. Instead we'll use a sentinel
    // that signals deletion: prefix name with [DELETED] and clear webhook settings.
    // NOTE: a proper deletedAt column would require another migration. For now
    // we use a soft indicator that the UI can filter on.
    await prisma.partnerOrganization.update({
      where: { id },
      data: {
        name:       `[DELETED] ${existing.name}`,
        webhookUrl: null,
        webhookSecret: null,
      },
    });

    res.json({ deleted: true, hard: false, accountCount: existing._count.accounts });
  } catch (err) {
    console.error('[adminPartnerOrgs DELETE /:id]', err);
    res.status(500).json({ error: 'Failed to delete partner org' });
  }
});

// ── POST /api/admin/partner-orgs/:id/link-account ────────────────────────────
// Directly set Account.partnerOrgId — ops use when customer already exists.
router.post('/:id/link-account', async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ error: 'accountId is required' });

    const org = await prisma.partnerOrganization.findUnique({ where: { id } });
    if (!org) return res.status(404).json({ error: 'Partner org not found' });
    if (org.name?.startsWith('[DELETED]')) return res.status(409).json({ error: 'This partner org has been deleted.' });

    const account = await prisma.account.findUnique({ where: { id: accountId } });
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const updated = await prisma.account.update({
      where: { id: accountId },
      data:  { partnerOrgId: id },
      select: { id: true, companyName: true, partnerOrgId: true },
    });

    res.json({ account: updated });
  } catch (err) {
    console.error('[adminPartnerOrgs POST /:id/link-account]', err);
    res.status(500).json({ error: 'Failed to link account' });
  }
});

// ── POST /api/admin/partner-orgs/:id/create-oem-user ─────────────────────────
// Create a new User with role=oem_admin under a new Account linked to this org.
// This is the "create Master Tech's first login" flow.
router.post('/:id/create-oem-user', async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const { email, name, password } = req.body;

    if (!email || !name || !password) {
      return res.status(400).json({ error: 'email, name, and password are required' });
    }

    const org = await prisma.partnerOrganization.findUnique({ where: { id } });
    if (!org) return res.status(404).json({ error: 'Partner org not found' });
    if (org.name?.startsWith('[DELETED]')) return res.status(409).json({ error: 'This partner org has been deleted.' });

    // Check for duplicate email
    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (existing) return res.status(409).json({ error: 'A user with that email already exists' });

    const passwordHash = await bcrypt.hash(password, 12);

    // Create a dedicated Account for this OEM org (or reuse an existing one that
    // has no users — for simplicity we always create a fresh account here).
    const result = await prisma.$transaction(async (tx: any) => {
      const account = await tx.account.create({
        data: {
          companyName: org.name,
          planType:    'saas',
          planTier:    'enterprise',
          partnerOrgId: id,
        },
      });

      const user = await tx.user.create({
        data: {
          accountId:    account.id,
          name:         name.trim(),
          email:        email.toLowerCase().trim(),
          passwordHash,
          role:         'oem_admin',
          isActive:     true,
        },
        select: { id: true, name: true, email: true, role: true, accountId: true },
      });

      return { account, user };
    });

    res.status(201).json({
      user:    result.user,
      account: { id: result.account.id, companyName: result.account.companyName },
    });
  } catch (err: any) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }
    console.error('[adminPartnerOrgs POST /:id/create-oem-user]', err);
    res.status(500).json({ error: 'Failed to create OEM user' });
  }
});

module.exports = router;
