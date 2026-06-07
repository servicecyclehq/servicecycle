/**
 * Register.jsx (L3 / legal click-through)
 *
 * Per-visitor demo sandbox registration. Only meaningfully reachable when
 * registrationOpen=true (forced true in DEMO_MODE; settable via the
 * REGISTRATION_OPEN env on self-hosted instances that want to allow signups).
 *
 * Visitor sees the Demo Sandbox Notice rendered inline (the four points that
 * matter — no real data, 5-day TTL, AS-IS, AI cap), is required to check
 * the ToS+Privacy box, and submits. POST /api/auth/register requires
 * acceptedTerms: true and stamps acceptedTermsAt + acceptedTermsVersion on
 * the User row for audit purposes.
 *
 * On success, the AuthContext picks up the new tokens and the visitor lands
 * on /dashboard with their seeded sandbox already populated (per L3's
 * seedAccountForUser hook in routes/auth.js).
 */

import { useState, useEffect } from 'react';
import { useNavigate, Navigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
// Pass-4 audit L3-09: single source of truth for the acceptedTermsVersion
// string. Was drifting across Register / SetupWizard / AcceptInvite.
import { TERMS_VERSION_DEMO as TERMS_VERSION } from '../legal/termsVersion';
import PasswordInput from '../components/PasswordInput';
import BrandMark from '../components/BrandMark';

export default function Register() {
  useDocumentTitle('Create account');
  const { user, loading, demoMode, setAuthData } = useAuth();
  const navigate = useNavigate();

  // Registration-open gate. The same value drives the Login page's
  // "Create an account" link visibility.
  const [registrationOpen, setRegistrationOpen] = useState(null); // null = unknown

  const [companyName, setCompanyName] = useState('');
  const [name,        setName]        = useState('');
  const [email,       setEmail]       = useState('');
  const [password,    setPassword]    = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [accepted,    setAccepted]    = useState(false);
  // (Pass-6 W3 MT-026) US-scope attestation -- companion to the
  // server-side CF-IPCountry check. Required for demo registration so
  // visitors affirm their business operates in the U.S. (the documented
  // marketing scope cited by Privacy, ToS, TIA). Hidden on self-host.
  const [acceptedUsScope, setAcceptedUsScope] = useState(false);
  const [error,       setError]       = useState('');
  const [submitting,  setSubmitting]  = useState(false);
  // 2026-05-10 v0.2.30 (M1 follow-up): track whether the user just typed
  // a '<' or '>' so we can flash a brief inline hint that those chars are
  // rejected. The HTML5 `pattern` only fires on submit, which the role-tier
  // walk flagged as user-hostile (no feedback while typing).
  const [bracketHint, setBracketHint] = useState({ name: false, company: false });

  // Strip '<' and '>' from name/company on input. Mirrors the server-side
  // regex in routes/auth.js and the `pattern` attr below. Returns the
  // cleaned string and whether anything was stripped, so the caller can
  // flash an inline hint.
  function stripAngleBrackets(v) {
    const cleaned = v.replace(/[<>]/g, '');
    return { cleaned, stripped: cleaned !== v };
  }

  useEffect(() => {
    api.get('/api/setup/status')
      .then(r => setRegistrationOpen(!!r?.data?.data?.registrationOpen))
      .catch(() => setRegistrationOpen(false));
  }, []);

  if (!loading && user) {
    return <Navigate to="/dashboard" replace />;
  }

  // v0.32.1 — Pass-4 audit takedown: while counsel review of the legal
  // documents was in progress (Terms / Privacy / EULA / Demo Sandbox Notice
  // — see audit/audit-pass4.md L1-01), public sign-up was paused. The
  // checkbox below references documents that were temporarily offline at
  // /legal/* (see LegalDocPage.jsx), so the click-through could not honestly
  // be presented.
  //
  // v0.35.0 (2026-05-17) — restored: legal docs now render as drafts via
  // LegalDocPage.jsx (OFFLINE_FOR_REVIEW=false) following the 6-agent legal
  // review (audit/legal-pass-2026-05-17/SYNTHESIS.md). The "DRAFT — pending
  // counsel review" banner is presented at every /legal/* route so visitors
  // see the pre-counsel status. Re-pause registration by flipping this
  // constant back to true AND setting OFFLINE_FOR_REVIEW=true in
  // LegalDocPage.jsx.
  const REGISTRATION_PAUSED_FOR_LEGAL_REVIEW = false;

  if (REGISTRATION_PAUSED_FOR_LEGAL_REVIEW && registrationOpen) {
    return (
      <div className="login-page">
        <div className="login-box" style={{ maxWidth: 480 }}>
          <div className="login-logo">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
              <BrandMark size={40} variant="light" />
              <span className="login-logo-name">Service<span style={{ color: '#65a30d' }}>C</span>ycle</span>
            </div>
            <div className="login-logo-tagline">
              {demoMode ? 'Demo sandbox' : 'Self-host'}
            </div>
          </div>
          <div className="login-title">Sign-up is temporarily paused</div>
          <p style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-text-secondary)', marginTop: 16, marginBottom: 12, lineHeight: 1.6 }}>
            We're updating our legal documents — Terms of Service, Privacy
            Policy, End-User License Agreement, and Demo Sandbox Notice —
            and having them reviewed by counsel before we publish the
            authoritative versions. Because the sign-up form requires you
            to accept those documents, we've paused new sign-ups while the
            review is in progress.
          </p>
          <p style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-text-secondary)', marginBottom: 18, lineHeight: 1.6 }}>
            We expect to re-open sign-ups within a few business days. If
            you'd like to be notified when sign-ups re-open, or you need
            access to the documents now for procurement or due-diligence,
            email{' '}
            <a href="mailto:privacy@servicecycle.com" style={{ color: 'var(--color-primary)', textDecoration: 'underline' }}>privacy@servicecycle.com</a>.
          </p>
          <Link to="/login" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  if (registrationOpen === false) {
    // Self-hosted, REGISTRATION_OPEN unset — treat /register as a polite
    // 404 instead of a confusing error. Send them at the login page.
    return (
      <div className="login-page">
        <div className="login-box">
          <div className="login-logo">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
              <BrandMark size={40} variant="light" />
              <span className="login-logo-name">Service<span style={{ color: '#65a30d' }}>C</span>ycle</span>
            </div>
            <div className="login-logo-tagline">Renewal management</div>
          </div>
          <div className="login-title">Registration is closed on this instance</div>
          <p style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-text-secondary)', marginTop: 16, marginBottom: 16 }}>
            Public sign-up isn't enabled on this ServiceCycle install. Contact your
            administrator for an invite, or visit the public demo at{' '}
            <a href="https://demo.servicecycle.com" style={{ color: 'var(--color-primary)' }}>demo.servicecycle.com</a>.
          </p>
          <Link to="/login" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    setError(''); setSubmitting(true);
    try {
      const res = await api.post('/api/auth/register', {
        companyName: companyName.trim() || `${name.trim()}'s sandbox`,
        name:        name.trim(),
        email:       email.trim().toLowerCase(),
        password,
        acceptedTerms:        true,
        acceptedTermsVersion: TERMS_VERSION,
        // (Pass-6 W3 MT-026) Only send the attestation when in demo mode;
        // self-host server-side gate ignores the field anyway, but sending
        // a true value from a self-host UI would misrepresent intent.
        ...(demoMode ? { acceptedUsScope } : {}),
      });
      // AuthContext.setAuthData persists the tokens + sets user state in
      // one call; mirrors the AcceptInvite path. /api/auth/register returns
      // {token, refreshToken, user}.
      const data = res?.data?.data;
      if (data?.token && data?.user) {
        setAuthData(data.token, data.refreshToken || null, data.user);
      }
      navigate('/dashboard');
    } catch (err) {
      const msg = err.response?.data?.error
        || err.response?.data?.errors?.[0]
        || 'Registration failed. Please try again.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-box" style={{ maxWidth: 460 }}>
        <div className="login-logo">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
            <BrandMark size={40} variant="light" />
            <span className="login-logo-name">Service<span style={{ color: '#65a30d' }}>C</span>ycle</span>
          </div>
          <div className="login-logo-tagline">
            {demoMode ? 'Demo sandbox' : 'Self-host'}
          </div>
        </div>

        <div className="login-title">
          {demoMode ? 'Create your demo sandbox' : 'Create your account'}
        </div>

        {/* Demo Sandbox Notice — inline summary the visitor actually reads.
            Backed by the full Terms / Privacy / Demo Sandbox Notice docs. */}
        {demoMode && (
          <div id="demo-sandbox-notice-inline" style={{
            background: 'var(--color-warning-bg, #fffbeb)',
            border: '1px solid var(--color-warning, #b45309)',
            borderRadius: 'var(--radius)',
            padding: '12px 14px',
            marginBottom: 18,
            fontSize: 12.5,
            lineHeight: 1.55,
            color: 'var(--color-warning)',
          }}>
            <strong>Before you create a sandbox — this is a binding agreement:</strong>
            <ul style={{ margin: '6px 0 0 0', paddingLeft: 18 }}>
              <li><strong>No real data.</strong> Demo is for clicking around — don't upload real contracts, customer data, or anything under NDA. We may suspend or delete accounts that misuse the sandbox.</li>
              <li><strong>5 consecutive calendar days of inactivity = deletion.</strong> If you don't log in for 5 calendar days, the entire sandbox is permanently deleted. No backup, no warning email. We do not access sandbox content as a matter of course, but we may where reasonably necessary to investigate abuse, respond to a security incident, comply with law, or enforce these terms.</li>
              <li><strong>AS-IS, no SLA.</strong> Demo might be slow or down. No support tickets against it.</li>
              <li><strong>AI features run on a shared key with usage caps.</strong> PDF/image equipment data extraction is capped at <strong>1 per day per user</strong>; renewal-brief generation at <strong>3 per day per user</strong>; Ask ServiceCycle chat at <strong>10 per day per user</strong>. Caps reset at midnight UTC and may be adjusted; on-prem installs use your own AI key with no cap by default. Full breakdown in the Demo Sandbox Notice below.</li>
            </ul>
          </div>
        )}

        {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 14 }}>{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label" htmlFor="register-your-name">Your name</label>
            <input
              id="register-your-name"
             
              type="text" className="form-control"
              value={name}
              onChange={e => {
                const { cleaned, stripped } = stripAngleBrackets(e.target.value);
                setName(cleaned);
                if (stripped) setBracketHint(h => ({ ...h, name: true }));
              }}
              required minLength={1} maxLength={200}
              autoComplete="name" autoFocus
              placeholder="Sarah Chen"
              /* 2026-05-10 review M1: pattern is defense-in-depth; the
                 onChange handler above strips '<' and '>' as they're typed
                 so the user sees rejection in real time (v0.2.30). */
              pattern="[^<>]*"
              title="Name cannot contain < or >"
            />
            {bracketHint.name && (
              <div style={{ marginTop: 6, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                {'< and > are not allowed in names.'}
              </div>
            )}
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="register-work-email">Work email</label>
            <input
              id="register-work-email"
             
              type="email" className="form-control"
              value={email} onChange={e => setEmail(e.target.value)}
              required maxLength={254}
              autoComplete="email"
              placeholder="sarah@acme.com"
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="register-company">Company {demoMode && <span style={{ fontWeight: 400, color: 'var(--color-text-secondary)' }}>(optional)</span>}</label>
            <input
              id="register-company"
             
              type="text" className="form-control"
              value={companyName}
              onChange={e => {
                const { cleaned, stripped } = stripAngleBrackets(e.target.value);
                setCompanyName(cleaned);
                if (stripped) setBracketHint(h => ({ ...h, company: true }));
              }}
              maxLength={200}
              autoComplete="organization"
              placeholder={demoMode ? 'Acme Inc.' : 'Required'}
              required={!demoMode}
              /* 2026-05-10 review M1 / v0.2.30: onChange strips '<' and '>'
                 in real time; pattern is defense-in-depth. */
              pattern="[^<>]*"
              title="Company name cannot contain < or >"
            />
            {bracketHint.company && (
              <div style={{ marginTop: 6, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                {'< and > are not allowed in company names.'}
              </div>
            )}
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="register-password">Password</label>
            <PasswordInput
              id="register-password"
             
               className="form-control"
              value={password} onChange={e => setPassword(e.target.value)}
              required minLength={12} maxLength={200}
              autoComplete="new-password"
            />
            {/* Live requirement indicators - matches default server policy
                (passwordPolicy.js: minLength=12, requireNumber=true,
                requireSpecial=true). Self-hosted instances may override
                via account settings; the server is authoritative on
                accept/reject, this is just the up-front UX hint so users
                aren't surprised by the rejection at submit time. */}
            <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.7 }}>
              {/* 2026-05-10 review L3: while the user is typing (password
                  non-empty), explicitly flag UNMET rules in red instead of
                  leaving them as a neutral grey circle. The grey-circle UI
                  read as "not applicable" rather than "still missing".
                  Empty-password state stays neutral so the rules don't
                  scream red on initial focus. */}
              {[
                { ok: password.length >= 12, label: 'At least 12 characters' },
                { ok: /\d/.test(password), label: 'At least one number' },
                { ok: /[^a-zA-Z0-9]/.test(password), label: 'At least one special character (e.g. ! @ # $ %)' },
              ].map(({ ok, label }) => {
                const showFail = !ok && password.length > 0;
                const color = ok
                  ? 'var(--color-success, #15803d)'
                  : (showFail ? 'var(--color-danger, #b91c1c)' : 'var(--color-text-secondary)');
                const glyph = ok ? '✓' : (showFail ? '✕' : '○');
                return (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, color }}>
                    <span aria-hidden="true" style={{ display: 'inline-block', width: 14, textAlign: 'center', fontWeight: 700 }}>
                      {glyph}
                    </span>
                    <span>{label}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="register-confirm-password">Confirm password</label>
            <PasswordInput
              id="register-confirm-password"
              className="form-control"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              required
              minLength={12}
              maxLength={200}
              autoComplete="new-password"
            />
            {confirmPassword.length > 0 && password !== confirmPassword && (
              <div role="alert" style={{ marginTop: 6, fontSize: 'var(--font-size-sm)', color: 'var(--color-danger, #b91c1c)' }}>
                Passwords don't match
              </div>
            )}
          </div>
          {/* (Pass-6 W3 MT-026) US-scope attestation. Demo only -- the
              ToS/Privacy/TIA all cite a U.S.-only marketing scope and the
              server-side CF-IPCountry middleware enforces that scope on
              demo traffic; this checkbox is the user-facing acknowledgment
              that pairs with it for defense-in-depth. */}
          {demoMode && (
            <div className="form-group" style={{ marginTop: 18, marginBottom: 6 }}>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', fontSize: 'var(--font-size-ui)', lineHeight: 1.55, color: 'var(--color-text)' }}>
                <input
                  type="checkbox"
                  checked={acceptedUsScope}
                  onChange={e => setAcceptedUsScope(e.target.checked)}
                  required
                  style={{ marginTop: 3, flexShrink: 0 }}
                />
                <span>
                  I confirm my business operates in the{' '}
                  <strong>United States</strong>. The ServiceCycle demo sandbox is
                  currently available to U.S.-based businesses only. If you
                  need access from outside the U.S., email{' '}
                  <a href="mailto:sales@servicecycle.com" style={{ color: 'var(--color-primary)' }}>sales@servicecycle.com</a>.
                </span>
              </label>
            </div>
          )}

          {/* L7+legal: ToS + Privacy + (demo) Sandbox Notice click-through.
              Server enforces acceptedTerms===true on the body; the box is also
              gated client-side so the submit button stays disabled. */}
          <div className="form-group" style={{ marginTop: 18, marginBottom: 18 }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', fontSize: 'var(--font-size-ui)', lineHeight: 1.55, color: 'var(--color-text)' }}>
              <input
                type="checkbox"
                checked={accepted}
                onChange={e => setAccepted(e.target.checked)}
                required
                style={{ marginTop: 3, flexShrink: 0 }}
              />
              <span>
                {/* Pass-3 audit MUST #1: EULA was stamped into TERMS_VERSION
                    server-side but the checkbox label never named it.
                    Consent was being recorded for a document the user
                    never saw — GDPR Art. 7 specific-consent failure. Now
                    every document in TERMS_VERSION appears as a visible
                    link before the box can be ticked. */}
                I have read and agree to the{' '}
                <a href="/legal/eula" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)', textDecoration: 'underline' }}>End-User License Agreement</a>,{' '}
                <a href="/legal/terms" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)', textDecoration: 'underline' }}>Terms of Service</a>
                ,{' '}and{' '}
                <a href="/legal/privacy" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)', textDecoration: 'underline' }}>Privacy Policy</a>
                {demoMode && <>{' '}and the{' '}<a href="#demo-sandbox-notice-inline" style={{ color: 'var(--color-primary)', textDecoration: 'underline' }}>Demo Sandbox Notice above</a></>}.
              </span>
            </label>
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center', padding: '10px' }}
            disabled={submitting || !accepted || (demoMode && !acceptedUsScope) || password !== confirmPassword}
          >
            {submitting ? 'Creating account…' : (demoMode ? 'Create demo sandbox' : 'Create account')}
          </button>
        </form>

        <p style={{ marginTop: 18, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', textAlign: 'center' }}>
          Already have an account?{' '}
          <Link to="/login" style={{ color: 'var(--color-primary)' }}>Sign in</Link>
        </p>
      </div>
    </div>
  );
}
