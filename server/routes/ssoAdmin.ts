// THIRD-PARTY PROVENANCE: integrates the Ory Polis (formerly BoxyHQ "SAML
// Jackson") admin API. Wire-protocol shapes/behavior verified against that upstream
// (Apache-2.0, (c) Ory Corp, https://github.com/ory/polis). No upstream source is
// vendored; original integration code. See docs/THIRD_PARTY_PROVENANCE.md and NOTICE.

const router = require('express').Router();
const { z } = require('zod');
import prisma from '../lib/prisma';
const { getSsoConfig } = require('../lib/ssoConfig');
const { resolveAccountFeatures } = require('../lib/accountFeatures');
const { sanitizeRole } = require('../lib/ssoRoleMap');
const ssoPolis = require('../lib/ssoPolis');
const { writeLog: writeActivityLog } = require('../lib/activityLog');

// This router is mounted behind authenticateToken + requireAdmin in index.ts.
// Every handler is scoped to req.user.accountId — an admin can ONLY ever touch
// their own account's SSO config. The Polis tenant is DERIVED server-side from
// the account id and never taken from the client (threat T12).

function polisTenantFor(accountId: string): string {
  return `acct_${accountId}`;
}

// Account opt-in gate (ships dark behind the `sso` feature flag).
async function requireSsoFeature(req: any, res: any, next: any) {
  try {
    const features = await resolveAccountFeatures(req.user.accountId);
    if (!features.sso) return res.status(403).json({ success: false, error: 'SSO is not enabled for this account' });
    next();
  } catch (e: any) {
    return res.status(500).json({ success: false, error: 'Failed to resolve account features' });
  }
}
router.use(requireSsoFeature);

// Resolve Polis config or fail closed (503). Returns null after responding.
function cfgOrFail(res: any): any | null {
  try { return getSsoConfig(); }
  catch (e: any) {
    if (e.code === 'SSO_DISABLED') res.status(503).json({ success: false, error: 'SSO is not configured on this instance' });
    else res.status(503).json({ success: false, error: 'SSO is temporarily unavailable' });
    return null;
  }
}

// ─── GET /api/sso/admin/config ────────────────────────────────────────────────
// The account's full SSO config (no secrets returned).
router.get('/config', async (req: any, res: any) => {
  const accountId = req.user.accountId;
  try {
    const [connections, domains, directories, roleMappings, requiredSetting, defaultSetting] = await Promise.all([
      prisma.ssoConnection.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' } }),
      prisma.ssoDomain.findMany({ where: { accountId }, orderBy: { domain: 'asc' } }),
      prisma.scimDirectory.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' } }),
      prisma.ssoRoleMapping.findMany({ where: { accountId }, orderBy: { idpGroup: 'asc' } }),
      prisma.accountSetting.findUnique({ where: { accountId_key: { accountId, key: 'sso.required' } } }).catch(() => null),
      prisma.accountSetting.findUnique({ where: { accountId_key: { accountId, key: 'sso.rolemap.default' } } }).catch(() => null),
    ]);
    return res.json({
      success: true,
      data: {
        polisTenant: polisTenantFor(accountId),
        connections, domains, directories, roleMappings,
        ssoRequired: requiredSetting?.value === 'true',
        defaultRole: defaultSetting?.value || 'viewer',
      },
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: 'Failed to load SSO config' });
  }
});

// ─── POST /api/sso/admin/connections ──────────────────────────────────────────
// Create a SAML or OIDC connection in Polis (tenant forced server-side) and
// persist the mapping. Body: { protocol, label, ...polisFields }.
const ConnSchema = z.object({
  protocol: z.enum(['saml', 'oidc']),
  label: z.string().max(120).optional(),
  // SAML
  rawMetadata: z.string().optional(),
  encodedRawMetadata: z.string().optional(),
  metadataUrl: z.string().url().optional(),
  // OIDC
  oidcDiscoveryUrl: z.string().url().optional(),
  oidcClientId: z.string().optional(),
  oidcClientSecret: z.string().optional(),
});
router.post('/connections', async (req: any, res: any) => {
  const cfg = cfgOrFail(res); if (!cfg) return;
  const accountId = req.user.accountId;
  const parsed = ConnSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid connection payload' });
  const b = parsed.data;
  const tenant = polisTenantFor(accountId);

  // Polis requires a redirectUrl allowlist + defaultRedirectUrl pointing at our
  // callback. Forced server-side.
  const base: any = {
    tenant, product: cfg.product, name: b.label || `${b.protocol.toUpperCase()} (${accountId.slice(0, 8)})`,
    defaultRedirectUrl: cfg.callbackUrl,
    redirectUrl: [cfg.callbackUrl],
  };

  try {
    let created: any;
    if (b.protocol === 'saml') {
      if (!b.rawMetadata && !b.encodedRawMetadata && !b.metadataUrl) {
        return res.status(400).json({ success: false, error: 'SAML requires rawMetadata, encodedRawMetadata, or metadataUrl' });
      }
      created = await ssoPolis.adminCreateSamlConnection(cfg, {
        ...base,
        ...(b.rawMetadata ? { rawMetadata: b.rawMetadata } : {}),
        ...(b.encodedRawMetadata ? { encodedRawMetadata: b.encodedRawMetadata } : {}),
        ...(b.metadataUrl ? { metadataUrl: b.metadataUrl } : {}),
      });
    } else {
      if (!b.oidcDiscoveryUrl || !b.oidcClientId || !b.oidcClientSecret) {
        return res.status(400).json({ success: false, error: 'OIDC requires oidcDiscoveryUrl, oidcClientId, oidcClientSecret' });
      }
      created = await ssoPolis.adminCreateOidcConnection(cfg, {
        ...base,
        oidcDiscoveryUrl: b.oidcDiscoveryUrl,
        oidcClientId: b.oidcClientId,
        oidcClientSecret: b.oidcClientSecret,
      });
    }

    const connection = await prisma.ssoConnection.create({
      data: {
        accountId, protocol: b.protocol, polisTenant: tenant, polisProduct: cfg.product,
        polisClientId: created?.clientID || null, label: b.label || null,
      },
    });
    writeActivityLog({ userId: req.user.id, accountId, action: 'sso_connection_created', details: { protocol: b.protocol, connectionId: connection.id } });
    return res.status(201).json({ success: true, data: { connection } });
  } catch (e: any) {
    console.error('[ssoAdmin] connection create failed:', e.message);
    return res.status(502).json({ success: false, error: 'Failed to create connection in Polis', detail: e.detail || null });
  }
});

// ─── DELETE /api/sso/admin/connections/:id ───────────────────────────────────
router.delete('/connections/:id', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const conn = await prisma.ssoConnection.findUnique({ where: { id: req.params.id } });
    if (!conn || conn.accountId !== accountId) return res.status(404).json({ success: false, error: 'Connection not found' });
    // Removing the mapping disables our use of it; the Polis-side delete is
    // best-effort (admin can also remove it in the Polis portal).
    await prisma.ssoConnection.delete({ where: { id: conn.id } }); // cascades domains + login states
    writeActivityLog({ userId: req.user.id, accountId, action: 'sso_connection_deleted', details: { connectionId: conn.id } });
    return res.json({ success: true });
  } catch (e: any) {
    console.error('[ssoAdmin] connection delete failed:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to delete connection' });
  }
});

// ─── POST /api/sso/admin/domains ──────────────────────────────────────────────
const DomainSchema = z.object({
  domain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Invalid domain'),
  connectionId: z.string().uuid(),
});
router.post('/domains', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const parsed = DomainSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ success: false, error: parsed.error.issues?.[0]?.message || 'Invalid domain payload' });
    const { domain, connectionId } = parsed.data;

    const conn = await prisma.ssoConnection.findUnique({ where: { id: connectionId } });
    if (!conn || conn.accountId !== accountId) return res.status(404).json({ success: false, error: 'Connection not found' });

    // Domain is GLOBALLY unique (isolation anchor). If already claimed by another
    // account, refuse — never let one tenant hijack another's domain.
    const existing = await prisma.ssoDomain.findUnique({ where: { domain } });
    if (existing && existing.accountId !== accountId) {
      return res.status(409).json({ success: false, error: 'This domain is already claimed by another organization. Contact support to verify ownership.' });
    }
    if (existing) {
      const updated = await prisma.ssoDomain.update({ where: { domain }, data: { connectionId, isActive: true } });
      return res.json({ success: true, data: { domain: updated } });
    }
    let dom;
    try {
      dom = await prisma.ssoDomain.create({ data: { domain, accountId, connectionId } });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        return res.status(409).json({ success: false, error: 'This domain is already claimed by another account' });
      }
      throw err;
    }
    writeActivityLog({ userId: req.user.id, accountId, action: 'sso_domain_added', details: { domain } });
    return res.status(201).json({ success: true, data: { domain: dom } });
  } catch (e: any) {
    console.error('[ssoAdmin] domain add failed:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to add domain' });
  }
});

router.delete('/domains/:id', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const dom = await prisma.ssoDomain.findUnique({ where: { id: req.params.id } });
    if (!dom || dom.accountId !== accountId) return res.status(404).json({ success: false, error: 'Domain not found' });
    await prisma.ssoDomain.delete({ where: { id: dom.id } });
    writeActivityLog({ userId: req.user.id, accountId, action: 'sso_domain_removed', details: { domain: dom.domain } });
    return res.json({ success: true });
  } catch (e: any) {
    console.error('[ssoAdmin] domain delete failed:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to delete domain' });
  }
});

// ─── POST /api/sso/admin/directories (SCIM) ──────────────────────────────────
// Creates a Polis SCIM directory (tenant forced) wired to OUR webhook + secret,
// returns the SCIM endpoint + token ONCE for the admin to paste into their IdP.
const DirSchema = z.object({
  label: z.string().max(120).optional(),
  type: z.string().max(40).optional(), // okta-scim-v2 | azure-scim-v2 | generic-scim-v2 | ...
});
router.post('/directories', async (req: any, res: any) => {
  const cfg = cfgOrFail(res); if (!cfg) return;
  const accountId = req.user.accountId;
  const parsed = DirSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid directory payload' });
  const tenant = polisTenantFor(accountId);
  try {
    const created = await ssoPolis.adminCreateDirectory(cfg, {
      tenant, product: cfg.product,
      name: parsed.data.label || `SCIM (${accountId.slice(0, 8)})`,
      type: parsed.data.type || 'generic-scim-v2',
      webhook_url: `${cfg.callbackUrl.replace(/\/callback$/, '')}/scim/webhook`,
      webhook_secret: cfg.scimWebhookSecret,
      log_webhook_events: true,
    });
    const dir = await prisma.scimDirectory.create({
      data: {
        accountId, polisDirectoryId: created.id, polisTenant: tenant, polisProduct: cfg.product,
        type: created.type || parsed.data.type || null, label: parsed.data.label || null,
      },
    });
    writeActivityLog({ userId: req.user.id, accountId, action: 'scim_directory_created', details: { directoryId: dir.id } });
    // Return the SCIM endpoint + token ONCE (the admin pastes these into their IdP).
    return res.status(201).json({
      success: true,
      data: { directory: dir, scim: { endpoint: created.scim?.endpoint, path: created.scim?.path, token: created.scim?.secret } },
    });
  } catch (e: any) {
    console.error('[ssoAdmin] directory create failed:', e.message);
    return res.status(502).json({ success: false, error: 'Failed to create SCIM directory in Polis', detail: e.detail || null });
  }
});

router.delete('/directories/:id', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const dir = await prisma.scimDirectory.findUnique({ where: { id: req.params.id } });
    if (!dir || dir.accountId !== accountId) return res.status(404).json({ success: false, error: 'Directory not found' });
    await prisma.scimDirectory.delete({ where: { id: dir.id } });
    writeActivityLog({ userId: req.user.id, accountId, action: 'scim_directory_deleted', details: { directoryId: dir.id } });
    return res.json({ success: true });
  } catch (e: any) {
    console.error('[ssoAdmin] directory delete failed:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to delete directory' });
  }
});

// ─── Role mappings ────────────────────────────────────────────────────────────
const RoleMapSchema = z.object({
  idpGroup: z.string().trim().min(1).max(200),
  role: z.string(),
});
router.post('/role-mappings', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const parsed = RoleMapSchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid role-mapping payload' });
    const role = sanitizeRole(parsed.data.role);
    if (!role) {
      return res.status(400).json({ success: false, error: 'Role must be one of viewer, consultant, manager. admin/oem_admin/super_admin cannot be granted via SSO.' });
    }
    const mapping = await prisma.ssoRoleMapping.upsert({
      where: { accountId_idpGroup: { accountId, idpGroup: parsed.data.idpGroup } },
      create: { accountId, idpGroup: parsed.data.idpGroup, role },
      update: { role },
    });
    writeActivityLog({ userId: req.user.id, accountId, action: 'sso_role_mapping_set', details: { idpGroup: parsed.data.idpGroup, role } });
    return res.json({ success: true, data: { mapping } });
  } catch (e: any) {
    console.error('[ssoAdmin] role-mapping set failed:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to save role mapping' });
  }
});

router.delete('/role-mappings/:id', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const m = await prisma.ssoRoleMapping.findUnique({ where: { id: req.params.id } });
    if (!m || m.accountId !== accountId) return res.status(404).json({ success: false, error: 'Mapping not found' });
    await prisma.ssoRoleMapping.delete({ where: { id: m.id } });
    return res.json({ success: true });
  } catch (e: any) {
    console.error('[ssoAdmin] role-mapping delete failed:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to delete role mapping' });
  }
});

// ─── PUT /api/sso/admin/policy ────────────────────────────────────────────────
// Set sso.required (with last-password-admin break-glass guard) + default role.
const PolicySchema = z.object({
  ssoRequired: z.boolean().optional(),
  defaultRole: z.string().optional(),
});
router.put('/policy', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const parsed = PolicySchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid policy payload' });

    if (parsed.data.ssoRequired === true) {
      // BREAK-GLASS GUARD: there must remain at least one password-capable
      // (non-ssoManaged) active admin who can sign in if the IdP breaks.
      const breakGlassAdmins = await prisma.user.count({
        where: { accountId, role: 'admin', isActive: true, ssoManaged: false },
      });
      if (breakGlassAdmins < 1) {
        return res.status(409).json({
          success: false,
          error: 'Cannot require SSO: at least one local (non-SSO) admin must remain for break-glass access. Create or convert a local admin first.',
          code: 'NO_BREAK_GLASS_ADMIN',
        });
      }
    }

    if (parsed.data.ssoRequired !== undefined) {
      await prisma.accountSetting.upsert({
        where: { accountId_key: { accountId, key: 'sso.required' } },
        create: { accountId, key: 'sso.required', value: parsed.data.ssoRequired ? 'true' : 'false' },
        update: { value: parsed.data.ssoRequired ? 'true' : 'false' },
      });
      writeActivityLog({ userId: req.user.id, accountId, action: 'sso_required_changed', details: { ssoRequired: parsed.data.ssoRequired } });
    }
    if (parsed.data.defaultRole !== undefined) {
      const def = sanitizeRole(parsed.data.defaultRole);
      if (!def) return res.status(400).json({ success: false, error: 'Default role must be viewer, consultant, or manager' });
      await prisma.accountSetting.upsert({
        where: { accountId_key: { accountId, key: 'sso.rolemap.default' } },
        create: { accountId, key: 'sso.rolemap.default', value: def },
        update: { value: def },
      });
    }
    return res.json({ success: true });
  } catch (e: any) {
    console.error('[ssoAdmin] policy update failed:', e.message);
    return res.status(500).json({ success: false, error: 'Failed to update SSO policy' });
  }
});

module.exports = router;

export {};
