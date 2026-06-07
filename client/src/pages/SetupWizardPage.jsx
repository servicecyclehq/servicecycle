import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import PasswordInput from '../components/PasswordInput';
// Pass-4 audit L3-09: shared TERMS_VERSION constants (was drifting across
// Register / SetupWizard / AcceptInvite).
import { TERMS_VERSION_SELF_HOST as TERMS_VERSION } from '../legal/termsVersion';

/**
 * SetupWizardPage
 * ---------------
 * First-run operator wizard. Reachable on a fresh instance via /setup. The
 * route exists in App.jsx as a top-level (pre-auth) route. Once the wizard
 * completes, the backend's setupCompletedAt is set and subsequent requests
 * pass the gate; the operator is redirected to /login.
 *
 * NOT to be confused with src/components/OnboardingWizard — that is the
 * post-login overlay that walks a new admin through their first vendor /
 * contract / alert. This page runs PRE-auth, before any User exists.
 *
 * Steps:
 *   1. Account     — required (creates first Account + admin User)
 *   2. Email       — optional skip (mock mode) OR Resend key
 *   3. AI provider — optional skip OR Anthropic/OpenAI key
 *   4. Done        — show completion summary + MASTER_KEY save acknowledgement
 *                    (Pass-6 W4 MT-039: required before Continue to login)
 */

const STEPS = ['account', 'email', 'ai', 'done'];

// EULA / ToS / Privacy acceptance — TERMS_VERSION is imported above from
// the shared module so Register / SetupWizard / AcceptInvite stay aligned.

export default function SetupWizardPage() {
  useDocumentTitle('Setup');
  const navigate = useNavigate();
  const [step, setStep]     = useState('account');
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState('');

  // Step 1 (account)
  const [companyName, setCompanyName] = useState('');
  const [name,        setName]        = useState('');
  const [email,       setEmail]       = useState('');
  const [password,    setPassword]    = useState('');
  const [accepted,    setAccepted]    = useState(false); // EULA / ToS / Privacy

  // Step 2 (email)
  const [emailMock,    setEmailMock]    = useState(true);
  const [brevoApiKey,  setBrevoApiKey]  = useState('');
  const [emailFrom,    setEmailFrom]    = useState('');

  // Step 3 (AI)
  const [aiSkip,    setAiSkip]    = useState(false);
  const [aiKey,     setAiKey]     = useState('');
  const [aiProvider,setAiProvider]= useState('anthropic');

  // Step 4 (done) — populated by /complete response; +MASTER_KEY save ack
  const [completion, setCompletion] = useState(null);
  const [masterKeySaved, setMasterKeySaved] = useState(false);

  // Bail out if the wizard is already done (e.g. operator hand-typed /setup
  // after configuring). Send them to /login.
  useEffect(() => {
    let alive = true;
    api.get('/api/setup/status')
      .then((r) => {
        if (alive && r.data?.data?.configured) navigate('/login', { replace: true });
      })
      .catch(() => { /* on error, stay on wizard — better safe than redirect-loop */ });
    return () => { alive = false; };
  }, [navigate]);

  // ── Step submitters ────────────────────────────────────────────────────────

  const submitAccount = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await api.post('/api/setup/account', {
        companyName, name, email, password,
        acceptedTerms:        true,
        acceptedTermsVersion: TERMS_VERSION,
      });
      setStep('email');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create account.');
    } finally { setBusy(false); }
  };

  const submitEmail = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const body = emailMock
        ? { mock: true }
        : { mock: false, brevoApiKey, emailFrom };
      await api.post('/api/setup/email', body);
      setStep('ai');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save email settings.');
    } finally { setBusy(false); }
  };

  const submitAi = async (e) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const body = aiSkip
        ? { skip: true }
        : { skip: false, provider: aiProvider, apiKey: aiKey };
      await api.post('/api/setup/ai', body);
      // Immediately call /complete — there's nothing else to gather.
      const completeRes = await api.post('/api/setup/complete', {});
      setCompletion(completeRes.data?.data || null);
      setStep('done');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to finalise setup.');
    } finally { setBusy(false); }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const stepIdx = STEPS.indexOf(step);

  return (
    <div className="login-page">
      <div className="login-box" style={{ maxWidth: 520 }}>
        <div className="login-logo">
          <div className="login-logo-name">LapseIQ Setup</div>
          <div className="login-logo-tagline">First-run configuration</div>
        </div>

        {/* Progress indicator */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 24 }}>
          {STEPS.map((s, i) => (
            <div key={s} style={{
              flex: 1, height: 4, borderRadius: 2,
              background: i <= stepIdx ? 'var(--color-primary, #0d4f6e)' : '#e5e7eb',
            }} />
          ))}
        </div>

        {error && (
          <div style={{
            background: 'var(--color-danger-bg)', color: 'var(--color-danger)', padding: '10px 14px',
            borderRadius: 6, marginBottom: 16, fontSize: 'var(--font-size-data)',
          }}>{error}</div>
        )}

        {step === 'account' && (
          <form onSubmit={submitAccount}>
            <h2 style={{ marginTop: 0 }}>Step 1 of 4 · Admin account</h2>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-data)' }}>
              Create your administrator account. You can invite teammates after first login.
            </p>
            <div className="form-group">
              <label className="form-label" htmlFor="setupwizard-company-name">Company name</label>
              <input
                id="setupwizard-company-name"
                className="form-control" value={companyName} onChange={(e) => setCompanyName(e.target.value)} required autoFocus />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="setupwizard-your-name">Your name</label>
              <input
                id="setupwizard-your-name"
                className="form-control" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="setupwizard-email">Email</label>
              <input
                id="setupwizard-email"
                className="form-control" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="setupwizard-password">Password</label>
              <PasswordInput
                id="setupwizard-password"
                className="form-control" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <small style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', marginTop: 4, display: 'block' }}>At least 12 characters, one digit, one special character.</small>
            </div>

            {/* EULA / ToS / Privacy click-through. Server enforces
                acceptedTerms===true and stamps acceptedTermsAt +
                acceptedTermsVersion on the User row (matches /api/auth/register).
                Required by EULA §1(c). */}
            <div style={{
              marginTop: 18,
              padding: '12px 14px',
              background: 'var(--color-warning-bg)',
              border: '1px solid #b45309',
              borderRadius: 6,
              fontSize: 12.5,
              lineHeight: 1.5,
              color: '#7c2d12',
            }}>
              <strong>Before creating your admin account:</strong> please read the{' '}
              <a href="/legal/eula" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary, #0d4f6e)', textDecoration: 'underline' }}>End-User License Agreement</a>,{' '}
              <a href="/legal/terms" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary, #0d4f6e)', textDecoration: 'underline' }}>Terms of Service</a>, and{' '}
              <a href="/legal/privacy" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary, #0d4f6e)', textDecoration: 'underline' }}>Privacy Policy</a>.
              By creating an account you affirmatively agree to all three. We record the timestamp of acceptance for audit purposes.
            </div>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 12, cursor: 'pointer', fontSize: 'var(--font-size-ui)', lineHeight: 1.55 }}>
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
                required
                style={{ marginTop: 3, flexShrink: 0 }}
              />
              <span>I have read and agree to the End-User License Agreement, Terms of Service, and Privacy Policy.</span>
            </label>

            <button type="submit" className="btn btn-primary" disabled={busy || !accepted} style={{ marginTop: 16 }}>
              {busy ? 'Creating…' : 'Create account →'}
            </button>
          </form>
        )}

        {step === 'email' && (
          <form onSubmit={submitEmail}>
            <h2 style={{ marginTop: 0 }}>Step 2 of 4 · Email delivery</h2>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-data)' }}>
              How should LapseIQ send password resets, alerts, and invites?
            </p>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <input type="radio" checked={emailMock} onChange={() => setEmailMock(true)} />
              <span>Skip for now — log emails to console (set <code>EMAIL_MOCK=true</code> in .env later)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <input type="radio" checked={!emailMock} onChange={() => setEmailMock(false)} />
              <span>Use Brevo (brevo.com)</span>
            </label>
            {!emailMock && (
              <>
                <div className="form-group">
                  <label className="form-label" htmlFor="setupwizard-brevo-api-key">Brevo API key</label>
                  <input
                    id="setupwizard-brevo-api-key"
                    className="form-control" value={brevoApiKey} onChange={(e) => setBrevoApiKey(e.target.value)} required={!emailMock} placeholder="xkeysib-…" />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="setupwizard-from-address">From address</label>
                  <input
                    id="setupwizard-from-address"

                    className="form-control"
                    placeholder='LapseIQ <noreply@yourdomain.com>'
                    value={emailFrom}
                    onChange={(e) => setEmailFrom(e.target.value)}
                    required={!emailMock}
                  />
                </div>
              </>
            )}
            <button type="submit" className="btn btn-primary" disabled={busy} style={{ marginTop: 16 }}>
              {busy ? 'Saving…' : 'Continue →'}
            </button>
          </form>
        )}

        {step === 'ai' && (
          <form onSubmit={submitAi}>
            <h2 style={{ marginTop: 0 }}>Step 3 of 4 · AI provider</h2>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-data)' }}>
              Powers contract field extraction and renewal briefs. Optional — you can add it later in Settings.
            </p>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <input type="radio" checked={aiSkip} onChange={() => setAiSkip(true)} />
              <span>Skip — disable AI features for now</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <input type="radio" checked={!aiSkip} onChange={() => setAiSkip(false)} />
              <span>Configure now</span>
            </label>
            {!aiSkip && (
              <>
                <div className="form-group">
                  {/* Pass-2 audit (2026-05-17): the W3 htmlFor codemod
                      collapsed this Provider label + the API-key input
                      together and produced a 90-char id stamped on the
                      wrong element. Hand-fixed: each control gets a
                      short, stable id matching its label. */}
                  <label className="form-label" htmlFor="setup-ai-provider">Provider</label>
                  <select id="setup-ai-provider" className="form-control" value={aiProvider} onChange={(e) => setAiProvider(e.target.value)}>
                    <option value="anthropic">Anthropic (Claude)</option>
                    <option value="openai">OpenAI</option>
                    <option value="azure_openai">Azure OpenAI</option>
                    <option value="gemini">Google Gemini</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="setup-ai-key">API key</label>
                  <PasswordInput
                    id="setup-ai-key"
                    className="form-control"
                    
                    value={aiKey}
                    onChange={(e) => setAiKey(e.target.value)}
                    required={!aiSkip}
                    placeholder="sk-ant-…"
                  />
                  <small style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', marginTop: 4, display: 'block' }}>
                    Stored in the database. For at-rest encryption, re-save via Settings → AI after first login.
                  </small>
                </div>
              </>
            )}
            <button type="submit" className="btn btn-primary" disabled={busy} style={{ marginTop: 16 }}>
              {busy ? 'Finishing…' : 'Finish setup →'}
            </button>
          </form>
        )}

        {step === 'done' && (
          <div>
            <h2 style={{ marginTop: 0 }}>✓ Setup complete</h2>
            <p style={{ color: 'var(--color-text-secondary)' }}>
              Your LapseIQ instance is ready. You can now sign in as <strong>{email || 'your admin user'}</strong>.
            </p>

            {completion?.completedSteps && (
              <ul style={{ fontSize: 'var(--font-size-data)', color: '#444' }}>
                <li>Admin account: ✓ created</li>
                <li>Email: {completion.completedSteps.email ? '✓ configured' : '⚠ skipped (mock mode)'}</li>
                <li>AI provider: {completion.completedSteps.ai ? '✓ configured' : '⚠ skipped'}</li>
              </ul>
            )}

            {completion?.persistenceNotes?.length > 0 && (
              <div style={{
                background: 'var(--color-warning-bg)', border: '1px solid #fcd34d',
                borderRadius: 6, padding: '10px 14px', fontSize: 'var(--font-size-ui)', color: '#78350f',
                marginTop: 12,
              }}>
                <strong>Before you restart the server:</strong>
                <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>
                  {completion.persistenceNotes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            )}

            {/* Pass-6 W4 MT-039 — MASTER_KEY save acknowledgement gate.
                The wizard never sees the actual MASTER_KEY value (it's
                generated by install.sh and lives in .env on the host),
                so this is generic guidance + a required ack.

                Why the gate exists: every encrypted document, every
                nightly backup blob, and every cloud-connector credential
                in the DB is decrypted with MASTER_KEY. If the operator
                loses it AND the host dies, that data is unrecoverable.
                install.sh's gate already covers the fresh-install path;
                this gate covers the upgrade / manual-configure path
                where install.sh may not have run. */}
            <div style={{
              background: '#fef3c7',
              border: '1px solid var(--color-warning)',
              borderRadius: 6,
              padding: '12px 14px',
              fontSize: 'var(--font-size-ui)',
              lineHeight: 1.55,
              color: '#7c2d12',
              marginTop: 16,
            }}>
              <strong>Important — back up your MASTER_KEY now.</strong>
              <p style={{ margin: '6px 0 8px' }}>
                The <code>MASTER_KEY</code> in your <code>.env</code> file decrypts every
                encrypted document, nightly backup blob, and cloud-connector credential
                LapseIQ stores. Save it to a password manager (1Password, Bitwarden,
                Vaultwarden, etc.) — somewhere that is <em>not</em> on this host.
              </p>
              <p style={{ margin: '6px 0 0' }}>
                If you lose this key, LapseIQ <strong>cannot</strong> recover that
                data for you. There is no central key escrow — LapseIQ is self-hosted
                by design. The same is true for <code>POSTGRES_PASSWORD</code>; save
                that too while you're in the password manager.
              </p>
            </div>
            <label
              htmlFor="setup-master-key-saved"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                marginTop: 12,
                cursor: 'pointer',
                fontSize: 'var(--font-size-ui)',
                lineHeight: 1.55,
              }}
            >
              <input
                id="setup-master-key-saved"
                type="checkbox"
                checked={masterKeySaved}
                onChange={(e) => setMasterKeySaved(e.target.checked)}
                style={{ marginTop: 3, flexShrink: 0 }}
              />
              <span>
                I have saved <code>MASTER_KEY</code> (and <code>POSTGRES_PASSWORD</code>)
                from <code>.env</code> to a password manager. I understand LapseIQ cannot
                recover encrypted documents or backups if I lose this key.
              </span>
            </label>

            <button
              onClick={() => navigate('/login')}
              className="btn btn-primary"
              disabled={!masterKeySaved}
              title={masterKeySaved ? '' : 'Acknowledge MASTER_KEY backup before continuing.'}
              style={{ marginTop: 20 }}
            >
              Continue to login
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
