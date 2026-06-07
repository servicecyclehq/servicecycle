'use strict';

/**
 * gpc.js -- Honor the Global Privacy Control signal (Sec-GPC: 1).
 *
 * Sets req.gpc = true when the Sec-GPC: 1 header is present on the inbound
 * request, so downstream code can read this flag and apply do-not-sell /
 * do-not-share / opt-out-of-targeted-advertising semantics without each
 * route re-parsing the header.
 *
 * Required as a legally binding opt-out mechanism by the consumer privacy
 * regimes in CA (CCPA/CPRA), CO (CPA), CT (CTDPA), DE (DPDPA), MD (MODPA),
 * MT (MCDPA), NH (NHDPA), NJ (NJDPA), OR (OCDPA), TX (TDPSA). LapseIQ does
 * not sell or share personal data with third parties for cross-context
 * behavioral advertising regardless of the signal, but honoring it explicitly
 * is required by the technical-control text of those statutes (the rule is
 * "if you accept opt-out preference signals, you must honor them"; not
 * accepting GPC at all is the worse posture under the latest enforcement
 * guidance from CA AG + CO AG).
 *
 * The flag reaches:
 *   - Any downstream route that wants to short-circuit a targeted-ad
 *     surface (none today, but the AI cross-feature pipeline + the future
 *     marketing-page personalization features must check req.gpc before
 *     personalizing).
 *   - ActivityLog.details (for the audit-trail requirement that
 *     procurement DPOs ask about during questionnaire review).
 *
 * Privacy Policy section 6 + 6A explicitly claim GPC honoring (synthesized
 * 2026-05-17). This middleware is the engineering surface that substantiates
 * that claim.
 *
 * Spec: https://globalprivacycontrol.github.io/gpc-spec/
 * Audit-pass anchor: Pass-6 / Lens 4 / L6-B04 (BLOCKING).
 */

function gpcMiddleware(req, _res, next) {
  // Per spec section 3.1: a value of '0' or absence of the header = no
  // signal; any other value = opted out. The canonical form is the
  // literal '1' but we treat any non-zero, non-empty value as opt-out
  // to forward-compat with future spec revisions.
  const raw = req.headers['sec-gpc'];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    req.gpc = trimmed.length > 0 && trimmed !== '0';
  } else {
    req.gpc = false;
  }
  next();
}

/**
 * blockIfGpc — Express middleware that rejects AI feature requests
 * when the client has sent Sec-GPC: 1.
 *
 * GPC is a user opt-out signal. The user-protective interpretation under
 * CA AG enforcement guidance (2025) is to disable AI data processing when
 * GPC is present. Any AI endpoint that processes personal data to generate
 * output (brief, ask, quote-extract, signature-extract) should mount this
 * middleware.
 *
 * Audit-pass anchor: Pass-6 T7-N1.
 */
function blockIfGpc(req, res, next) {
  if (req.gpc) {
    return res.status(403).json({
      success: false,
      error:   'AI features are disabled because your browser sent a Global Privacy Control (Sec-GPC: 1) signal. Disable GPC in your browser settings to use AI features.',
      code:    'GPC_AI_BLOCKED',
    });
  }
  next();
}

module.exports = { gpcMiddleware, blockIfGpc };

export {};
