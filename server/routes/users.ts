const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { z } = require('zod'); // (B6)
const { requireAdmin, requireViewer } = require('../middleware/roles');
const { sendEmail, inviteHtml } = require('../lib/email');
const { defaultFlagsForRole, sanitizeFlags, ALL_FEATURES, sanitizeHiddenFeatures } = require('../lib/featureFlags');
const { validateBody } = require('../lib/validate'); // (B6)
const { writeLog: writeActivityLog } = require('../lib/activityLog'); // GDPR export/erasure audit trail
const { validate: validatePassword, validateStrength, loadAccountPolicy } = require('../lib/passwordPolicy'); // W4 audit + audit-7
import prisma from '../lib/prisma';

const router = express.Router();

// v0.68.5 (audit Medium): rate limit POST /invite to 5/hour/admin.
const rateLimit = require('express-rate-limit');
const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      5,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => `invite:${req.user?.id || 'anon'}`,
  message: { success: false, error: 'Too many invites in the last hour -- try again later.' },
});

// ── B6 zod schemas ──────────────────────────────────────────────────────────
// These run BEFORE the existing manual validation (last-admin checks etc.)
// so the existing business rules continue to apply unchanged.
const ROLES = ['admin', 'manager', 'viewer', 'consultant', 'field_tech'];
// field_tech = phone-only field-labor login; scoped to assigned work orders only.

const CreateUserSchema = z.object({
  name:     z.string().trim().min(1).max(200),
  email:    z.string().trim().email().max(254),
  password: z.string().min(8).max(200),
  role:     z.enum(ROLES),
});

const UpdateMeSchema = z.object({
  name:           z.string().trim().min(1).max(200).optional(),
  // v0.71.3 (audit Quick Win): cross-device onboarding step persistence.
  // Wizard step is now sync'd to user.onboardingStep so switching devices
  // doesn't reset progress (was localStorage-only).
  onboardingStep: z.number().int().min(0).max(20).optional(),
});

const ChangeMyPasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword:     z.string().min(1).max(200), // policy min is enforced inside the handler
});

// ── GET /api/users/members ────────────────────────────────────────────────────
// Lightweight list of id+name for all active users in the account.
// Available to all roles — used by the owner filter dropdown in ContractsList.
// Must be declared BEFORE /:id so "members" isn't treated as an id param.
router.get('/members', requireViewer, async (req, res) => { // (L1)
  try {
    const users = await prisma.user.findMany({
      where: { accountId: req.user.accountId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return res.json({ success: true, data: { users } });
  } catch (err) {
    console.error('List members error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch members' });
  }
});

// ── POST /api/users/invite ────────────────────────────────────────────────────
// Send an invite email to a new user (admin only).
// Must be declared before /:id to avoid param collision.
router.post('/invite', requireAdmin, inviteLimiter, async (req, res) => {
  const { email, role } = req.body;
  // Audit Cluster A P1: validate email shape + cap input size BEFORE any
  // DB write or Brevo send. A 100kB malformed email would otherwise create
  // a UserInvite row and attempt an SMTP send. Reuse the same 254-char cap
  // that RegisterSchema uses for self-register.
  const InviteEmailSchema = z.string().trim().email().max(254);
  const emailParsed = InviteEmailSchema.safeParse(email);
  if (!emailParsed.success) {
    return res.status(400).json({ success: false, error: 'A valid email address is required (max 254 chars)' });
  }
  const validatedEmail = emailParsed.data;

  const validRoles = ['admin', 'manager', 'viewer', 'consultant'];
  if (!validRoles.includes(role))
    return res.status(400).json({ success: false, error: 'Role must be admin, manager, viewer, or consultant' });

  try {
    const normalizedEmail = validatedEmail.toLowerCase();

    // Reject if user already exists in any account
    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) return res.status(400).json({ success: false, error: 'A user with that email already exists' });

    // Expire any pending invites for this email+account
    await prisma.userInvite.updateMany({
      where: { accountId: req.user.accountId, email: normalizedEmail, acceptedAt: null },
      data: { expiresAt: new Date() },
    });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours

    await prisma.userInvite.create({
      data: {
        accountId: req.user.accountId,
        email: normalizedEmail,
        role,
        token,
        expiresAt,
        invitedBy: req.user.id,
      },
    });

    const account = await prisma.account.findUnique({
      where: { id: req.user.accountId },
      select: { companyName: true },
    });

    const appUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const link = `${appUrl}/accept-invite/${token}`;

    await sendEmail({
      to: normalizedEmail,
      subject: `You've been invited to join ${account.companyName} on ServiceCycle`,
      html: inviteHtml({ inviterName: req.user.name, companyName: account.companyName, role, link }),
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Send invite error:', err);
    return res.status(500).json({ success: false, error: 'Failed to send invite' });
  }
});

// ── GET /api/users ────────────────────────────────────────────────────────────
// List all users in the account (admin only)
router.get('/', requireAdmin, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { accountId: req.user.accountId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        lastLogin: true,
        featureFlags: true,
        assetScopeRestricted: true,
        createdAt: true,
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });

    return res.json({ success: true, data: { users } });
  } catch (err) {
    console.error('List users error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch users' });
  }
});

// ── POST /api/users ───────────────────────────────────────────────────────────
// Create a new user in the account (admin only)
router.post('/', requireAdmin, async (req, res) => {
  const parsed = validateBody(req, res, CreateUserSchema); // (B6)
  if (!parsed) return;
  const { name, email, password, role } = parsed;

  // Audit Cluster A P1 (2026-05-16): enforce per-account password policy.
  // The zod schema enforces a min of 8 chars; the per-account policy may
  // require 12 + digit + special. Reject loose passwords here so admin-set
  // creates can't bypass what the user-self path enforces.
  const policy = await loadAccountPolicy(prisma, req.user.accountId);
  // audit-7 item 2.1.1: zxcvbn + HIBP layered on rule policy.
  const policyResult = await validateStrength(password, policy, { userInputs: [email, name].filter(Boolean) });
  if (!policyResult.valid) {
    return res.status(400).json({ success: false, error: policyResult.errors.join('; ') });
  }

  try {
    const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (existing) return res.status(400).json({ success: false, error: 'A user with that email already exists' });

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        accountId: req.user.accountId,
        name: name.trim(),
        email: email.toLowerCase().trim(),
        passwordHash,
        role,
        isActive: true,
        featureFlags: defaultFlagsForRole(role),
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        lastLogin: true,
        featureFlags: true,
        createdAt: true,
      },
    });

    // M11: record direct-create in audit log (distinguishable from invite-accept)
    // assetId is null — activity_logs.assetId is nullable for non-asset events.
    try {
      await prisma.activityLog.create({
        data: {
          assetId:    null,
          userId:     req.user.id,
          action:     'user_created', // (M11) noun-verb convention matching other audit actions
          details:    { newUserId: user.id, newUserEmail: user.email, role, byUserId: req.user.id },
        },
      });
    } catch (auditErr) {
      // Audit failure must not block the response — log and continue
      console.error('ActivityLog write failed for user_created:', auditErr.message);
    }

    return res.status(201).json({ success: true, data: { user } });
  } catch (err) {
    console.error('Create user error:', err);
    return res.status(500).json({ success: false, error: 'Failed to create user' });
  }
});

// ── GET /api/users/me ─────────────────────────────────────────────────────────
// Returns the current user's profile (name, email, role).
// Must be declared BEFORE /:id routes.
router.get('/me', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, name: true, email: true, role: true, featureFlags: true, hiddenFeatures: true },
    });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    return res.json({ success: true, data: { user } });
  } catch (err) {
    console.error('Get profile error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch profile' });
  }
});

// ── PUT /api/users/me ─────────────────────────────────────────────────────────
// Any authenticated user can update their own display name.
// Must be declared BEFORE /:id routes.
router.put('/me', async (req, res) => {
  const parsed = validateBody(req, res, UpdateMeSchema); // (B6)
  if (!parsed) return;
  const { name, onboardingStep } = parsed;
  // v0.71.3: at least one field must be provided.
  if (name === undefined && onboardingStep === undefined) {
    return res.status(400).json({ success: false, error: 'no_fields_to_update' });
  }
  const updateData: any = {};
  if (name !== undefined) updateData.name = name;
  if (onboardingStep !== undefined) updateData.onboardingStep = onboardingStep;

  try {
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: updateData,
      select: { id: true, name: true, email: true, role: true, featureFlags: true, hiddenFeatures: true, onboardingStep: true },
    });
    return res.json({ success: true, data: { user } });
  } catch (err) {
    console.error('Update profile error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update profile' });
  }
});

// ── PUT /api/users/me/hidden-features ─────────────────────────────────────────
// Any authenticated user can update their own hidden-features preferences.
// Users can only hide/unhide features — not grant themselves new access.
// Must be before /:id routes.
router.put('/me/hidden-features', async (req, res) => {
  try {
    const { hiddenFeatures } = req.body;
    if (!hiddenFeatures || typeof hiddenFeatures !== 'object') {
      return res.status(400).json({ success: false, error: 'hiddenFeatures object is required' });
    }

    // Only allow toggling features the admin has actually enabled for this user
    const currentUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { featureFlags: true },
    });
    const granted = currentUser?.featureFlags || {};

    // Build cleaned hidden set — grant-gated page features can only be hidden
    // when granted; UI-view prefs (infoTips) are free to toggle. See
    // sanitizeHiddenFeatures in lib/featureFlags.
    const clean = sanitizeHiddenFeatures(hiddenFeatures, granted);

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { hiddenFeatures: clean },
      select: { id: true, name: true, email: true, role: true, featureFlags: true, hiddenFeatures: true },
    });
    return res.json({ success: true, data: { user } });
  } catch (err) {
    console.error('Update hidden features error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update preferences' });
  }
});

// ── PUT /api/users/me/password ────────────────────────────────────────────────
// Any authenticated user can change their own password.
// IMPORTANT: must be declared BEFORE /:id — otherwise Express would treat
// "me" as an :id parameter and this route would never match.
router.put('/me/password', async (req, res) => {
  const parsed = validateBody(req, res, ChangeMyPasswordSchema); // (B6)
  if (!parsed) return;
  const { currentPassword, newPassword } = parsed;

  try {
    // audit-7 item 2.1.1: replace minLen-only check with full layered
    // validation (rules + zxcvbn score >= 3 + HIBP breach corpus). Same
    // gate as register / reset-password / invite-accept paths.
    const policy = await loadAccountPolicy(prisma, req.user.accountId);
    const meUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { email: true, name: true },
    });
    const policyResult = await validateStrength(newPassword, policy, {
      userInputs: [meUser?.email, meUser?.name].filter(Boolean),
    });
    if (!policyResult.valid) {
      return res.status(400).json({ success: false, error: policyResult.errors[0], errors: policyResult.errors });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(400).json({ success: false, error: 'Current password is incorrect' });

    const passwordHash = await bcrypt.hash(newPassword, 12);
    // L2 (2026-06-09 audit): bump tokenEpoch alongside the password change so
    // every outstanding ACCESS token (not just refresh tokens) is invalidated
    // immediately, not after its TTL.
    await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash, tokenEpoch: { increment: 1 } } });

    // C2 (audit Critical, 2026-05-22): revoke every outstanding refresh token
    // for this user so a stolen session is killed at password-change time.
    // Mirrors the inline pattern used by the admin /:id/revoke-sessions
    // handler below. Best-effort log: failure to write the activity row must
    // not block the password change.
    let revokedCount = 0;
    try {
      const revoked = await prisma.refreshToken.updateMany({
        where: { userId: req.user.id, revokedAt: null },
        data:  { revokedAt: new Date() },
      });
      revokedCount = revoked.count;
    } catch (revokeErr) {
      console.error('refresh-token revoke (password change) error:', revokeErr);
    }
    try {
      writeActivityLog({
        userId:  req.user.id,
        action:  'password_changed_sessions_revoked',
        details: {
          revokedCount,
          ip: req.ip || req.headers['x-forwarded-for'] || null,
        },
      });
    } catch (logErr) {
      console.error('activity log (password change) error:', logErr);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Change password error:', err);
    return res.status(500).json({ success: false, error: 'Failed to change password' });
  }
});

// ── PUT /api/users/:id ────────────────────────────────────────────────────────
// Update a user's name or role (admin only)
router.put('/:id', requireAdmin, async (req, res) => {
  const { name, role } = req.body;

  // Audit Cluster A P1 (2026-05-16): validate input shape + length BEFORE
  // any DB lookup. Pre-fix `name` was written verbatim with no length
  // cap — a 50kB string would survive to prisma.user.update.
  if (name !== undefined) {
    if (typeof name !== 'string' || name.length > 200) {
      return res.status(400).json({ success: false, error: 'Name must be a string ≤ 200 characters' });
    }
  }

  try {
    const target = await prisma.user.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!target) return res.status(404).json({ success: false, error: 'User not found' });

    // Prevent the last admin from being demoted
    if (role && role !== 'admin' && target.role === 'admin') {
      const adminCount = await prisma.user.count({
        where: { accountId: req.user.accountId, role: 'admin', isActive: true },
      });
      if (adminCount <= 1) {
        return res.status(400).json({
          success: false,
          error: 'Cannot change role — this is the only active admin on the account',
        });
      }
    }

    const validRoles = ['admin', 'manager', 'viewer', 'consultant', 'field_tech'];
    const updateData: any = {};
    if (name?.trim()) updateData.name = name.trim();
    if (role && validRoles.includes(role)) {
      updateData.role = role;
      // Reset feature flags to the new role's defaults whenever role changes
      updateData.featureFlags = defaultFlagsForRole(role);
      // Security: a role change (especially a demotion) must invalidate the
      // user's existing access token immediately rather than letting the old
      // privileges linger until the JWT's ~1h TTL. Bumping tokenEpoch makes the
      // auth middleware reject the stale token on the very next request.
      if (role !== target.role) updateData.tokenEpoch = { increment: 1 };
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: updateData,
      select: {
        id: true, name: true, email: true, role: true, isActive: true, lastLogin: true, featureFlags: true, createdAt: true,
      },
    });

    // SOC-3: audit log role changes
    if (role && role !== target.role) {
      try {
        await writeActivityLog({
          accountId: target.accountId,
          userId:    req.user.id,
          action:    'user_role_changed',
          details:   { targetUserId: target.id, oldRole: target.role, newRole: role },
          ipAddress: req.ip,
        });
      } catch (logErr) {
        console.error('activity log (role change) error:', logErr);
      }
    }

    return res.json({ success: true, data: { user } });
  } catch (err) {
    console.error('Update user error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update user' });
  }
});

// ── PUT /api/users/:id/deactivate ─────────────────────────────────────────────
// Deactivate a user — they can no longer log in but their data is preserved
router.put('/:id/deactivate', requireAdmin, async (req, res) => {
  try {
    const target = await prisma.user.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!target) return res.status(404).json({ success: false, error: 'User not found' });

    // Prevent self-deactivation
    if (target.id === req.user.id) {
      return res.status(400).json({ success: false, error: 'You cannot deactivate your own account' });
    }

    // Prevent deactivating the last admin
    if (target.role === 'admin') {
      const adminCount = await prisma.user.count({
        where: { accountId: req.user.accountId, role: 'admin', isActive: true },
      });
      if (adminCount <= 1) {
        return res.status(400).json({
          success: false,
          error: 'Cannot deactivate — this is the only active admin on the account',
        });
      }
    }

    // NOTE: the inherited contract-owner reassignment gate is gone — assets
    // have no per-user owner column. Site-assignment cleanup for scoped
    // viewers lands with the user↔site scoping rewire.

    const targetId = req.params.id;
    await prisma.user.update({
      where: { id: targetId },
      data: { isActive: false },
    });

    // SOC-1: revoke all active refresh tokens and bump tokenEpoch so existing
    // JWTs are immediately rejected on next verification.
    await prisma.refreshToken.updateMany({
      where: { userId: targetId, revokedAt: null },
      data:  { revokedAt: new Date() },
    });
    await prisma.user.update({
      where: { id: targetId },
      data:  { tokenEpoch: { increment: 1 } },
    });

    // Audit 6.4.6 — capture optional churn reason for retention analysis.
    // The admin who triggered the deactivate fills the reason in the UI
    // prompt. Free-text capped at 500 chars; null when admin skips.
    const rawReason = (typeof req.body?.reason === 'string') ? req.body.reason : null;
    const reason = rawReason ? rawReason.trim().slice(0, 500) : null;
    try {
      writeActivityLog({
        userId:  req.user.id,
        action:  'user_deactivated',
        details: {
          targetUserId: target.id,
          reason,
        },
      });
    } catch (logErr) {
      console.error('activity log (deactivate) error:', logErr);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Deactivate user error:', err);
    return res.status(500).json({ success: false, error: 'Failed to deactivate user' });
  }
});

// ── PUT /api/users/:id/activate ───────────────────────────────────────────────
// Reactivate a previously deactivated user
router.put('/:id/activate', requireAdmin, async (req, res) => {
  try {
    const target = await prisma.user.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!target) return res.status(404).json({ success: false, error: 'User not found' });

    await prisma.user.update({
      where: { id: req.params.id },
      data: { isActive: true },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Activate user error:', err);
    return res.status(500).json({ success: false, error: 'Failed to activate user' });  }
});

// ── POST /api/users/:id/revoke-sessions ──────────────────────────────────────
// v0.37.4 W7: incident-response primitive. Admin-only. Revokes every active
// refresh token for the target user, forcing them to re-authenticate on every
// device. Use cases: phishing suspicion, employee offboarding mid-shift,
// stolen-laptop response. Self-revoke is allowed (useful when an admin
// suspects their own session was hijacked but isn't sure yet).
//
// L2 (2026-06-09 audit): this now ALSO bumps tokenEpoch, so the current
// access JWT is invalidated immediately rather than lingering until its TTL
// (default 1h) expires. Revoke-sessions is therefore a true instant kill.
//
// Audit-logged via the shared activityLog helper so the incident response
// has a trail.
router.post('/:id/revoke-sessions', requireAdmin, async (req, res) => {
  try {
    const target = await prisma.user.findFirst({
      where:  { id: req.params.id, accountId: req.user.accountId },
      select: { id: true, name: true, email: true },
    });
    if (!target) return res.status(404).json({ success: false, error: 'User not found' });

    const result = await prisma.refreshToken.updateMany({
      where: { userId: target.id, revokedAt: null },
      data:  { revokedAt: new Date() },
    });

    // L2: invalidate outstanding access tokens too (instant, not TTL-bounded).
    await prisma.user.update({
      where: { id: target.id },
      data:  { tokenEpoch: { increment: 1 } },
    });

    try {
      // v0.38.1: use the top-level writeActivityLog import (line 9) instead
      // of re-requiring it inside the handler. Cosmetic; matches the pattern
      // used by the other writeActivityLog call-sites in this file.
      writeActivityLog({
        userId:  req.user.id,
        action:  'sessions_revoked',
        details: {
          targetUserId:    target.id,
          targetUserEmail: target.email,
          revokedCount:    result.count,
          selfRevoke:      target.id === req.user.id,
        },
      });
    } catch (logErr) {
      console.error('activity log error (revoke-sessions):', logErr);
    }

    return res.json({ success: true, data: { revokedCount: result.count } });
  } catch (err) {
    console.error('Revoke sessions error:', err);
    return res.status(500).json({ success: false, error: 'Failed to revoke sessions' });
  }
});


// T7-N1 (audit-2 2026-05-22): Better Stack, Healthchecks.io, and cloud-marketplace
// providers (AWS/Azure/GCP) were live sub-processors not listed in the snapshot.
// Added to tier3_monitoring and tier4_cloud_marketplace respectively. asOf bumped.
function _subProcessorsSnapshot() {
  return {
    asOf: '2026-05-22',
    source: 'legal/sub-processors-2026-05.md',
    note: 'These are the sub-processors that may have processed your personal data on ForgeRift\'s behalf as of the export date. See Privacy Policy section 4 for the per-activity data category mapping.',
    tier1_infrastructure_and_communications: [
      { name: 'Cloudflare, Inc.',       role: 'Edge TLS, DDoS protection, edge analytics, email routing',           dataCategories: 'Network metadata; inbound email contents in flight' },
      { name: 'DigitalOcean, LLC',      role: 'Origin compute + managed Postgres',                                    dataCategories: 'All application data at rest (encrypted by AES-256 at the volume layer)' },
      { name: 'Brevo (Sendinblue SAS)', role: 'Transactional email delivery',                                          dataCategories: 'Recipient email, message body, delivery metadata' },
      { name: 'Resend',                 role: 'Legacy transactional email (being phased out)',                         dataCategories: 'Recipient email, message body, delivery metadata' },
      { name: 'GitHub, Inc.',           role: 'Container registry (GHCR) + source hosting',                            dataCategories: 'No personal data; image pulls expose IP to GitHub' },
      { name: 'Stripe, Inc.',           role: 'Payment processing (provisioned, not yet active on demo)',              dataCategories: 'Payment-method data, billing details (when activated)' },
    ],
    tier2_ai_providers: [
      { name: 'Cloudflare Workers AI',    role: 'Primary AI provider on demo',                                       dataCategoriesSent: 'Asset metadata; uploaded document text during extraction; assistant question text' },
      { name: 'Hugging Face Inference',   role: 'Fallback AI provider (ask only)',                                   dataCategoriesSent: 'Assistant question text' },
      { name: 'Groq',                     role: 'Fallback AI provider (ask only)',                                   dataCategoriesSent: 'Assistant question text' },
      { name: 'Anthropic, PBC',           role: 'Self-host AI provider (operator opt-in)',                           dataCategoriesSent: 'Same as Cloudflare Workers AI when AI_PROVIDER=anthropic' },
      { name: 'OpenAI',                   role: 'Self-host AI provider (operator opt-in)',                           dataCategoriesSent: 'Same as Cloudflare Workers AI when AI_PROVIDER=openai' },
      { name: 'Azure OpenAI',             role: 'Self-host AI provider (operator opt-in; under operator Microsoft tenant)', dataCategoriesSent: 'Same as Cloudflare Workers AI when AI_PROVIDER=azure_openai' },
      { name: 'Google Gemini',            role: 'Self-host AI provider (operator opt-in)',                           dataCategoriesSent: 'Same as Cloudflare Workers AI when AI_PROVIDER=gemini' },
      { name: 'Tavily',                   role: 'Optional web-search enrichment for maintenance-brief lookup',       dataCategoriesSent: 'Equipment type + manufacturer/model only (no customer data, no document text)' },
    ],
    tier3_monitoring: [
      { name: 'Better Stack (Logtail)',  role: 'Log aggregation and uptime monitoring; receives structured server logs',        dataCategories: 'Server-side log payloads which may include user IDs, action names, and truncated request metadata. No raw document content.' },
      { name: 'Healthchecks.io',        role: 'Cron-job heartbeat monitoring (ping on each scheduled-job completion/failure)', dataCategories: 'Ping timestamp + optional status string only; no personal data transmitted' },
    ],
    perActivity: {
      authentication:                ['DigitalOcean (origin)', 'Cloudflare (TLS termination)'],
      demo_sandbox_storage:          ['DigitalOcean'],
      email_password_reset_invite:   ['Brevo', '(legacy) Resend'],
      ai_brief_always_on:            ['Configured AI provider (see Settings -> AI Provider)'],
      ai_brief_optin_supplementary:  ['Configured AI provider (same as always-on)'],
      ai_extraction:                 ['Configured AI provider'],
      ai_assistant:                  ['Configured AI provider', 'Hugging Face / Groq (cascade fallback when primary fails)'],
      web_search_enrichment:         ['Tavily (when enabled in Settings)'],
      log_aggregation:               ['Better Stack (Logtail)'],
      cron_monitoring:               ['Healthchecks.io'],
    },
  };
}

// ── GET /api/users/:id/export ─────────────────────────────────────────────────
// GDPR Article 15 ("right to access") + CCPA "right to know" data export.
// Returns a JSON archive of every row that references the user, so they can
// be handed an off-line copy when they exercise their data-subject rights.
//
// Scope: a regular member can request their OWN export (controller checks
// req.user.id === req.params.id); admins can export any user in the account
// (for a manager-mediated GDPR/CCPA request). Cross-account exports are not
// permitted — the accountId filter is hard-coded.
//
// Audit Cluster A P1: no data-export endpoint existed pre-2026-05-16.
router.get('/:id/export', async (req, res) => {
  try {
    const targetId = req.params.id;
    const isSelf   = req.user.id === targetId;
    const isAdmin  = req.user.role === 'admin';
    if (!isSelf && !isAdmin) {
      return res.status(403).json({ success: false, error: 'You can only export your own data, or an admin must perform the export on your behalf.' });
    }

    // Tenant-scoped lookup — refusing to even acknowledge the existence of
    // a user in another account.
    const user = await prisma.user.findFirst({
      where: { id: targetId, accountId: req.user.accountId },
      select: {
        id: true, accountId: true, name: true, email: true, role: true,
        isActive: true, lastLogin: true, createdAt: true, updatedAt: true,
        twoFactorEnabled: true, assetScopeRestricted: true,
        acceptedTermsAt: true, acceptedTermsVersion: true,
        aiConsentDismissedAt: true, aiConsentSilenced: true,
        featureFlags: true, hiddenFeatures: true,
      },
    });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    // Each block is captured defensively — a missing model on an older
    // schema shouldn't abort the export. We log and continue with the
    // partial archive so the user still gets what's there.
    async function safe(label, fn) {
      try { return await fn(); }
      catch (e) {
        console.warn(`[gdpr-export] ${label} skipped: ${e.message}`);
        return null;
      }
    }

    // Pass-4 audit L3-04: every findMany is capped at SECTION_CAP rows so
    // a single self-export of a long-lived account can't OOM the Node
    // process. If a section is truncated, the response records the cap so
    // the user can email support@servicecycle.app for a full extract.
    const SECTION_CAP = 50000;
    const cap: any = { take: SECTION_CAP };
    const truncations: any = {};
    async function capped(label, fn) {
      const rows = await safe(label, fn);
      if (Array.isArray(rows) && rows.length === SECTION_CAP) truncations[label] = SECTION_CAP;
      return rows;
    }

    const archive: any = {
      generatedAt: new Date().toISOString(),
      generatedBy: req.user.id,
      // (Pass-6 W3 MT-033) bump to /3: adds apiKeysOnAccount (account-scoped,
      // keyHash excluded) and a subProcessorsAtExportTime snapshot for
      // Art. 15(1)(c) compliance.
      schemaVersion: 'servicecycle-gdpr-export/3',
      user,
      alertPreferences:    await capped('alertPreferences',    () => prisma.alertPreference.findMany({ where: { userId: targetId }, ...cap })),
      aiUsage:             await capped('aiUsage',             () => prisma.aiUsage.findMany({ where: { userId: targetId }, ...cap })),
      activityLog:         await capped('activityLog',         () => prisma.activityLog.findMany({ where: { userId: targetId, accountId: req.user.accountId }, orderBy: { createdAt: 'desc' }, ...cap })),
      refreshTokens:       await capped('refreshTokens',       () => prisma.refreshToken.findMany({ where: { userId: targetId }, select: { id: true, createdAt: true, expiresAt: true, revokedAt: true, replacedById: true }, ...cap })),
      communicationsAuthored: await capped('communicationsAuthored', () => prisma.communication.findMany({ where: { createdBy: targetId, accountId: req.user.accountId }, ...cap })), // Pass-2 P2 fix: tenant-scope
      // Pass-4 audit L3-02 / L3-03: complete the personal-data scope so
      // Article 15 returns every row referencing the data subject, not just
      // the user-rooted graph.
      earlyAccessRequests: await capped('earlyAccessRequests', () => prisma.earlyAccessRequest.findMany({ where: { email: user.email }, ...cap })),
      invitesReceived:     await capped('invitesReceived',     () => prisma.userInvite.findMany({ where: { email: user.email, accountId: req.user.accountId }, ...cap })),
      invitesSent:         await capped('invitesSent',         () => prisma.userInvite.findMany({ where: { invitedBy: targetId, accountId: req.user.accountId }, ...cap })),
      // (Pass-6 W3 MT-033) ApiKey metadata on the user's account. The
      // keyHash is deliberately excluded -- a data-subject access request
      // should not return material that could be replayed to authenticate.
      // The metadata (name, createdAt, lastUsedAt, revokedAt) IS personal
      // data because it describes account behavior the subject performed.
      apiKeysOnAccount:    await capped('apiKeysOnAccount',    () => prisma.apiKey.findMany({ where: { accountId: req.user.accountId }, select: { id: true, name: true, createdAt: true, lastUsedAt: true, revokedAt: true }, ...cap }).catch(() => [])),
      // (Pass-6 W3 MT-033) Sub-processor snapshot for Art. 15(1)(c).
      // The data subject is entitled to know "the recipients or categories
      // of recipients" their personal data may have been disclosed to.
      // This snapshot mirrors legal/sub-processors-2026-05.md at the time
      // of export. Update when the canonical list changes.
      subProcessorsAtExportTime: _subProcessorsSnapshot(),
      truncations: Object.keys(truncations).length
        ? { ...truncations, note: 'Some sections were truncated at ' + SECTION_CAP + ' rows. Email support@servicecycle.app if a full extract is needed.' }
        : null,
    };

    // Activity log fire-and-forget so the export itself is auditable.
    writeActivityLog({
      userId:  req.user.id,
      action:  'user_data_exported',
      details: { targetUserId: targetId, schemaVersion: archive.schemaVersion },
    }).catch(() => {});

    const filename = `servicecycle-user-${targetId}-${new Date().toISOString().slice(0, 10)}.json`;
    res.set('Content-Type', 'application/json; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(JSON.stringify(archive, null, 2));
  } catch (err) {
    console.error('GDPR export error:', err);
    return res.status(500).json({ success: false, error: 'Failed to build user data export' });
  }
});

// ── DELETE /api/users/:id ─────────────────────────────────────────────────────
// GDPR Article 17 ("right to erasure") implementation. Removes the user
// row, anonymizes downstream rows that have an FK reference, and revokes
// every active refresh token in one transaction.
//
// Why this is admin-only: a paying customer's DPO/admin is the proper
// channel for an erasure request. A user clicking "delete me" with no
// admin involvement would skip the legal-hold / dispute window that
// data-protection regimes require an organization to honour.
//
// What stays: ActivityLog entries lose their userId (null) but keep the
// rest of the audit metadata, because GDPR explicitly allows preserving
// audit trail content as long as the personal identifier is dropped.
// SECURITY.md disclosure trail and incident-response logs need to remain
// reconstructable; anonymization keeps both promises.
//
// Audit Cluster A P1: pre-2026-05-16 the only erasure path was running
// SQL by hand.
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const targetId = req.params.id;
    const target = await prisma.user.findFirst({
      where: { id: targetId, accountId: req.user.accountId },
    });
    if (!target) return res.status(404).json({ success: false, error: 'User not found' });

    if (target.id === req.user.id) {
      return res.status(400).json({ success: false, error: 'You cannot delete your own account via this endpoint. Contact another admin.' });
    }
    if (target.role === 'admin') {
      const adminCount = await prisma.user.count({
        where: { accountId: req.user.accountId, role: 'admin', isActive: true },
      });
      if (adminCount <= 1) {
        return res.status(400).json({
          success: false,
          error: 'Cannot delete — this is the only active admin on the account. Promote another user first.',
        });
      }
    }

    // Anonymize-then-delete inside a single tx so a partial failure
    // doesn't leave the row half-deleted.
    await prisma.$transaction(async (tx) => {
      // Drop refresh tokens immediately — they cascade via FK but we want
      // to make the access-revocation explicit.
      await tx.refreshToken.deleteMany({ where: { userId: targetId } });
      // T7-N4 (audit-2 2026-05-22): ActivityLog rows are intentionally RETAINED
      // on erasure (not deleted). GDPR Art. 17(3)(b) permits continued
      // processing for legal obligation / legitimate interest where deletion
      // would impair audit-trail integrity required for security investigations.
      // Personal data is scrubbed: userId is nulled here; email addresses are
      // removed from JSONB details below (T1-N7). Remaining fields
      // (action, assetId, accountId, createdAt) carry no direct identifier.
      await tx.activityLog.updateMany({
        where: { userId: targetId },
        data:  { userId: null },
      });
      // Communications authored: keep the comm record (it's contractor-attached
      // maintenance context the account still needs) but null the author.
      await tx.communication.updateMany({
        where: { createdBy: targetId },
        data:  { createdBy: null },
      }).catch(() => { /* schema may have createdBy NOT NULL; harmless skip */ });
      // Pass-4 audit L3-01: erasure scope previously missed EarlyAccessRequest
      // rows that share the user's email. The rows contain name + email +
      // ipAddress + userAgent (Privacy §5 retention promise: 36 months OR
      // earlier on request). On an Article 17 erasure the right answer is
      // delete every personal-data record the controller holds about the
      // subject, including the pre-account-creation lead form record.
      await tx.earlyAccessRequest.deleteMany({ where: { email: target.email } });
      // T1-N7 (audit-2 2026-05-22): scrub erased user's email from ActivityLog.details
      // JSONB payloads (e.g. failed_login stores attemptedEmail). Without this a GDPR
      // Art. 17 erasure leaves the subject's email in structured log entries.
      // Raw SQL is intentional: avoids a Prisma findMany-then-update loop over
      // potentially thousands of log rows and executes atomically inside the transaction.
      await tx.$executeRaw`UPDATE "activity_logs" SET details = details - 'attemptedEmail' WHERE details->>'attemptedEmail' = ${target.email}`;
      // Per-user preference rows — these have onDelete: Cascade so the
      // user.delete below removes them. Listed here for code-grep
      // discoverability: alertPreference, aiUsage, userPreference,
      // refreshToken.
      await tx.user.delete({ where: { id: targetId } });
    });

    writeActivityLog({
      userId:  req.user.id,
      action:  'user_erased',
      details: { targetUserId: targetId },
    }).catch(() => {});

    return res.json({ success: true, data: { deletedUserId: targetId } });
  } catch (err) {
    console.error('GDPR erasure error:', err);
    return res.status(500).json({ success: false, error: 'Failed to erase user. Some referencing rows may need a manual cleanup; check ActivityLog for the partial state.' });
  }
});

// ── PUT /api/users/:id/reset-password ─────────────────────────────────────────
// Admin sets a new password directly for any user in the account.
// Audit (F010 / 2026-05-03 audit): admin-initiated password rotations must
// leave an ActivityLog trail because they're a user-impersonation primitive
// — after the rotation the admin can log in as the target user with the new
// password until that user changes it. The audit story requires every such
// privileged action to be reviewable post-hoc.
router.put('/:id/reset-password', requireAdmin, async (req, res) => {
  const { password } = req.body;

  // Audit Cluster A P1 (2026-05-16): enforce the per-account password policy
  // on admin-set passwords too. Pre-fix, this path accepted any string ≥8
  // chars regardless of PASSWORD_MIN_LENGTH / REQUIRE_NUMBER / REQUIRE_SPECIAL
  // — the loosest password gate in the codebase, despite being a
  // user-impersonation primitive.
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ success: false, error: 'New password is required' });
  }
  if (password.length > 200) {
    return res.status(400).json({ success: false, error: 'Password too long (max 200 characters)' });
  }
  const policy = await loadAccountPolicy(prisma, req.user.accountId);
  // audit-7 item 2.1.1: zxcvbn + HIBP layered on rule policy.
  // userInputs intentionally minimal here: target email/name are looked up later,
  // so we just pass admin's email as a weak-personalisation hint.
  const policyResult = await validateStrength(password, policy, { userInputs: [req.user.email].filter(Boolean) });
  if (!policyResult.valid) {
    return res.status(400).json({ success: false, error: policyResult.errors.join('; ') });
  }

  try {
    const target = await prisma.user.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!target) return res.status(404).json({ success: false, error: 'User not found' });

    const passwordHash = await bcrypt.hash(password, 12);

    await prisma.user.update({
      where: { id: req.params.id },
      // L2 (2026-06-09 audit): bump tokenEpoch so an admin-forced password
      // reset kills every outstanding access token for the target user.
      data: { passwordHash, passwordResetToken: null, passwordResetExpiresAt: null, tokenEpoch: { increment: 1 } },
    });

    // F010: audit the privileged action. Fire-and-forget — never blocks the
    // response. assetId stays null because this is a user event, not an
    // asset event. byUserId records who pulled the trigger; targetUserId
    // / targetUserEmail records who was hit.
    try {
      await prisma.activityLog.create({
        data: {
          assetId:    null,
          userId:     req.user.id,
          action:     'admin_password_reset',
          details: {
            byUserId:        req.user.id,
            targetUserId:    target.id,
            targetUserEmail: target.email,
            ip:              req.ip,
          },
        },
      });
    } catch (auditErr) {
      // Audit failure must not block the response — log and continue.
      console.error('ActivityLog write failed for admin_password_reset:', auditErr.message);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ success: false, error: 'Failed to reset password' });
  }
});

// ── GET /api/users/permissions ────────────────────────────────────────────────
// Returns all active users with their current featureFlags for the matrix view.
// Admin + manager only.
router.get('/permissions', requireAdmin, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { accountId: req.user.accountId, isActive: true },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        featureFlags: true,
      },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });

    // Fill in role defaults for any users who predate the feature flags system
    const enriched = users.map(u => ({
      ...u,
      featureFlags: u.featureFlags || defaultFlagsForRole(u.role),
    }));

    return res.json({ success: true, data: { users: enriched, features: ALL_FEATURES } });
  } catch (err) {
    console.error('Get permissions error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch permissions' });
  }
});

// ── PUT /api/users/permissions ────────────────────────────────────────────────
// Batch-update feature flags for multiple users in one save.
// Payload: { updates: [{ userId, flags: { news, budget, ingest, alerts } }] }
// Admin only.
router.put('/permissions', requireAdmin, async (req, res) => {
  const { updates } = req.body;
  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ success: false, error: 'updates array is required' });
  }

  try {
    // Verify all target users belong to this account
    const targetIds = updates.map(u => u.userId);
    const owned = await prisma.user.findMany({
      where: { id: { in: targetIds }, accountId: req.user.accountId },
      select: { id: true, role: true },
    });
    const ownedIds = new Set(owned.map(u => u.id));

    const ops = [];
    for (const { userId, flags } of updates) {
      if (!ownedIds.has(userId)) continue;
      const user = owned.find(u => u.id === userId);
      // Admins always keep full access — skip flag writes for admin role
      if (user.role === 'admin') continue;

      const clean = sanitizeFlags(flags);
      if (!clean) continue;

      ops.push(
        prisma.user.update({
          where: { id: userId },
          data: { featureFlags: clean },
        })
      );
    }

    await prisma.$transaction(ops);
    return res.json({ success: true, updated: ops.length });
  } catch (err) {
    console.error('Save permissions error:', err);
    return res.status(500).json({ success: false, error: 'Failed to save permissions' });
  }
});

// ── PATCH /api/users/:id/scope-restriction ────────────────────────────────────
// Toggle assetScopeRestricted for a viewer user.
// Only meaningful for viewers — admins and managers always see everything.
router.patch('/:id/scope-restriction', requireAdmin, async (req, res) => {
  const { restricted } = req.body;
  if (typeof restricted !== 'boolean') {
    return res.status(400).json({ success: false, error: 'restricted (boolean) is required' });
  }

  try {
    const target = await prisma.user.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!target) return res.status(404).json({ success: false, error: 'User not found' });

    if (target.role !== 'viewer') {
      return res.status(400).json({
        success: false,
        error: 'Scope restriction only applies to viewer-role users',
      });
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { assetScopeRestricted: restricted },
      select: {
        id: true, name: true, email: true, role: true, isActive: true,
        lastLogin: true, featureFlags: true, assetScopeRestricted: true, createdAt: true,
      },
    });

    // SOC-3: audit log scope restriction changes
    try {
      await writeActivityLog({
        accountId: target.accountId,
        userId:    req.user.id,
        action:    'user_scope_restriction_changed',
        details:   { targetUserId: target.id, restricted },
        ipAddress: req.ip,
      });
    } catch (logErr) {
      console.error('activity log (scope restriction) error:', logErr);
    }

    return res.json({ success: true, data: { user } });
  } catch (err) {
    console.error('Toggle scope restriction error:', err);
    return res.status(500).json({ success: false, error: 'Failed to update scope restriction' });
  }
});

module.exports = router;

export {};
