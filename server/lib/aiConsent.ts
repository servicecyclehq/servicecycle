/**
 * aiConsent.js — server-side gate for the per-session AI consent modal.
 *
 * Phase 4 — v0.4.0; extended for Pass-4 compliance audit (2026-05-17).
 *
 * Three columns on User drive this:
 *   - aiConsentDismissedAt           — null until the user has
 *     acknowledged the consent modal at least once. POST
 *     /api/auth/ai-consent sets it.
 *   - aiConsentSilenced              — persistent "don't ask me each
 *     session" toggle. When true, the client suppresses the modal
 *     entirely.
 *   - aiConsentVersion               — opaque version of the consent
 *     text the user acknowledged (Pass-4 L3-07). The server forces a
 *     re-prompt when the active version diverges from the recorded one.
 *   - aiConsentProviderAtAcceptance  — provider string at acceptance
 *     time (Pass-4 L3-08). The server forces a re-prompt when the
 *     active AI_PROVIDER diverges from the recorded one.
 *
 * Server-side rule (per roadmap §6.1 + Pass-4 audit L3-07/L3-08):
 *   AI endpoints (maintenance brief, ingest, ask) MUST call ensureAiConsent
 *   and 403 on failure REGARDLESS of client state. The first-ever AI call
 *   for a user 403s with `ai_consent_required`; the client renders the
 *   AI consent modal, posts the acknowledgment to /api/auth/ai-consent
 *   with the active version + provider, and retries.
 *
 * Per-session re-prompt is purely client-side (sessionStorage flag). The
 * server stays happy once aiConsentDismissedAt is non-null AND the
 * recorded version+provider matches the active values.
 *
 * Fail-closed on DB lookup error so an unreachable Postgres doesn't open
 * the AI endpoints unauthenticated.
 */

'use strict';

import prisma from './prisma';

// Bump this string when the consent-modal text materially changes. The
// server gate compares it against User.aiConsentVersion and forces a
// re-prompt when they diverge. The exact string is opaque — the client
// echoes whatever it receives from /api/auth/me and posts back via
// /api/auth/ai-consent.
const CURRENT_AI_CONSENT_VERSION = 'ai-consent-2026-05-17';

function getActiveProvider() {
  return (process.env.AI_PROVIDER || 'anthropic').trim().toLowerCase();
}

function getCurrentConsentVersion() {
  return CURRENT_AI_CONSENT_VERSION;
}

/**
 * checkAiConsent(userId) → { ok: boolean, reason?: string }
 *
 *   { ok: true }                                       — proceed with AI call
 *   { ok: false, reason: 'ai_consent_required' }       — no prior acceptance
 *   { ok: false, reason: 'ai_consent_outdated' }       — version or provider changed
 *   { ok: false, reason: 'user_not_found' }            — middleware bug or stale token
 *   { ok: false, reason: 'consent_lookup_failed' }     — DB error (fail-closed)
 */
async function checkAiConsent(userId) {
  if (!userId) return { ok: false, reason: 'user_not_found' };
  // v0.92.23: DEMO_MODE sandboxes pre-ack consent at seed time, and the AI
  // cascade spans multiple providers (cloudflare/groq/huggingface) so the
  // provider/version drift check below is both meaningless and the sole source
  // of "ai_consent_outdated" breakage in the demo. Treat consent as satisfied
  // in DEMO_MODE; real self-host installs keep full enforcement.
  if (process.env.DEMO_MODE === 'true') return { ok: true };
  try {
    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: {
        aiConsentDismissedAt:          true,
        aiConsentSilenced:             true,
        aiConsentVersion:              true,
        aiConsentProviderAtAcceptance: true,
      },
    });
    if (!user) return { ok: false, reason: 'user_not_found' };

    // First-ever consent gate: no prior acceptance at all.
    if (!user.aiConsentDismissedAt) {
      return { ok: false, reason: 'ai_consent_required' };
    }

    // The aiConsentSilenced toggle is an explicit "don't ask each session"
    // user choice. It does NOT bypass the version/provider mismatch check
    // — when EITHER the consent text changed or the operator swapped
    // providers, every user re-acknowledges before AI calls succeed.
    const activeVersion  = getCurrentConsentVersion();
    const activeProvider = getActiveProvider();

    // Pass-4 L3-08: provider drift forces re-prompt. Legacy rows
    // (pre-Pass-4) have null aiConsentProviderAtAcceptance — we treat
    // those as "needs one-time re-prompt to backfill" rather than
    // silently grandfathering them.
    if (!user.aiConsentProviderAtAcceptance || user.aiConsentProviderAtAcceptance !== activeProvider) {
      return { ok: false, reason: 'ai_consent_outdated' };
    }

    // Pass-4 L3-07: version drift forces re-prompt. Same legacy rule.
    if (!user.aiConsentVersion || user.aiConsentVersion !== activeVersion) {
      return { ok: false, reason: 'ai_consent_outdated' };
    }

    return { ok: true };
  } catch (err) {
    console.error('[aiConsent] lookup failed (failing closed):', err.message);
    return { ok: false, reason: 'consent_lookup_failed' };
  }
}

/**
 * ensureAiConsent(req, res) — Express helper. Returns true if the request
 * should proceed; sends a 403 and returns false if not.
 *
 * Usage in an AI route handler:
 *   if (!(await ensureAiConsent(req, res))) return;
 *
 * The 403 carries `error: 'ai_consent_required'` or `ai_consent_outdated`
 * so the client hook can distinguish first-time consent from a re-prompt
 * triggered by version/provider change.
 */
async function ensureAiConsent(req, res) {
  const result = await checkAiConsent(req.user?.id);
  if (result.ok) return true;
  res.status(403).json({
    success: false,
    error:   result.reason,
    message: result.reason === 'ai_consent_required'
      ? 'AI provider acknowledgment required. The client should present the consent modal.'
      : result.reason === 'ai_consent_outdated'
      ? 'AI provider or consent text has changed since you last acknowledged. Please review and re-accept.'
      : 'Unable to verify AI consent state.',
  });
  return false;
}

/**
 * recordAiConsent(userId, { version, provider }) — stamp the acceptance
 * with the version + provider the user actually saw. Idempotent on
 * repeated calls (just bumps the timestamp).
 *
 * If `version` or `provider` is omitted, falls back to the server's
 * current values — defensive, so older clients posting only `{userId}`
 * still produce a record that satisfies the gate at acceptance time.
 */
async function recordAiConsent(userId, opts) {
  if (!userId) throw new Error('recordAiConsent: userId required');
  const version  = (opts && typeof opts.version === 'string' && opts.version.trim().length > 0 && opts.version.length <= 64)
    ? opts.version.trim()
    : getCurrentConsentVersion();
  const provider = (opts && typeof opts.provider === 'string' && opts.provider.trim().length > 0 && opts.provider.length <= 32)
    ? opts.provider.trim().toLowerCase()
    : getActiveProvider();
  return prisma.user.update({
    where: { id: userId },
    data:  {
      aiConsentDismissedAt:          new Date(),
      aiConsentVersion:              version,
      aiConsentProviderAtAcceptance: provider,
    },
  });
}

module.exports = {
  checkAiConsent,
  ensureAiConsent,
  recordAiConsent,
  getCurrentConsentVersion,
  getActiveProvider,
  CURRENT_AI_CONSENT_VERSION,
};

export {};
