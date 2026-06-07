/**
 * termsVersion.js
 *
 * Pass-4 audit L3-09 (2026-05-17) — single source of truth for the
 * acceptedTermsVersion string that the three signup paths
 * (Register / AcceptInvite / SetupWizard) stamp on the User row.
 *
 * Before this module existed, each page had its own const string and
 * they drifted: Register listed four documents including the
 * demo-notice; SetupWizardPage listed three (no demo-notice); the
 * AcceptInvite path wrote nothing at all. Importing from here keeps
 * them aligned.
 *
 * Bump the date suffix on each constant whenever the corresponding
 * legal document changes, so the server-side acceptedTermsVersion
 * column records exactly which version of the doc set the user
 * acknowledged.
 */

// Demo sandbox signup (Register.jsx, DEMO_MODE=true). Includes the
// Demo Sandbox Notice on top of the four core docs.
export const TERMS_VERSION_DEMO =
  'eula-2026-05-04, tos-2026-05-04, privacy-2026-05-04, demo-notice-2026-05-04';

// Self-host setup wizard + invite-accept on a self-hosted instance.
// The Demo Sandbox Notice does not apply.
export const TERMS_VERSION_SELF_HOST =
  'eula-2026-05-04, tos-2026-05-04, privacy-2026-05-04';
