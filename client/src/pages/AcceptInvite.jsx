import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import PasswordInput from '../components/PasswordInput';
// Pass-4 audit L3-09: shared TERMS_VERSION (was drifting across
// Register / SetupWizard / AcceptInvite; AcceptInvite previously sent
// no version at all).
import { TERMS_VERSION_SELF_HOST } from '../legal/termsVersion';

const ROLE_LABELS = { admin: 'Admin', manager: 'Manager', viewer: 'Viewer', consultant: 'Consultant' }; // H5 (audit): consultant invites no longer render 'as a undefined'

export default function AcceptInvite() {
  useDocumentTitle('Accept invitation');
  const { token } = useParams();
  const navigate = useNavigate();
  const { setAuthData } = useAuth();

  const [invite, setInvite] = useState(null);   // { email, role, companyName }
  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState(false);

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // Pass-3 audit MUST #2: invite-acceptance previously bypassed the legal
  // click-through that self-signup (Register.jsx) enforces. Invited
  // production users now must affirmatively agree to the same four docs
  // before the form submits. The server-side TERMS_VERSION write at the
  // accept route already exists (in routes/auth.js); this just brings
  // the UI gate to parity.
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    api.get(`/api/auth/invite/${token}`)
      .then(r => setInvite(r.data.data))
      .catch(() => setInvalid(true))
      .finally(() => setLoading(false));
  }, [token]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!name.trim()) { setError('Please enter your name.'); return; }
    if (!password)   { setError('Please enter a password.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (!accepted) { setError('Please review and accept the legal documents below to continue.'); return; }

    setSubmitting(true);
    try {
      // Pass-4 audit L1-03: send the explicit consent payload the server
      // now requires so it can stamp acceptedTermsAt + acceptedTermsVersion
      // on the new User row (GDPR Art. 7(1) demonstrability of consent).
      const res = await api.post(`/api/auth/invite/${token}/accept`, {
        name,
        password,
        acceptedTerms:        true,
        acceptedTermsVersion: TERMS_VERSION_SELF_HOST,
      });
      const { token: jwt, user } = res.data.data;
      // Log user in directly
      setAuthData(jwt, user);
      navigate('/dashboard');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create your account. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-box">
        <div className="login-logo">
          <div className="login-logo-name">LapseIQ</div>
          <div className="login-logo-tagline">Software Renewal Management</div>
        </div>

        {loading && (
          <p style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-text-secondary)', textAlign: 'center' }}>
            Validating invite…
          </p>
        )}

        {!loading && invalid && (
          <>
            <div className="login-title">Invite not found</div>
            <p style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
              This invite link is invalid or has expired. Please ask your administrator to send a new invite.
            </p>
          </>
        )}

        {!loading && invite && (
          <>
            <div className="login-title">Set up your account</div>
            <div style={{
              background: 'var(--color-surface)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius)',
              padding: '12px 14px',
              marginBottom: 20,
              fontSize: 'var(--font-size-ui)',
              color: 'var(--color-text-secondary)',
              lineHeight: 1.6,
            }}>
              You've been invited to join <strong style={{ color: 'var(--color-text)' }}>{invite.companyName}</strong>{' '}
              as a <strong style={{ color: 'var(--color-text)' }}>{ROLE_LABELS[invite.role]}</strong>.
              <br />
              Signing in as <strong style={{ color: 'var(--color-text)' }}>{invite.email}</strong>
            </div>

            {error && <div role="alert" className="alert alert-error">{error}</div>}

            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label className="form-label" htmlFor="acceptinvite-your-full-name">Your full name</label>
                <input
                  id="acceptinvite-your-full-name"
                 
                  type="text"
                  className="form-control"
                  placeholder="e.g. Jane Smith"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoFocus
                  autoComplete="name"
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="acceptinvite-password">Password</label>
                <PasswordInput
                  id="acceptinvite-password"
                 
                  
                  className="form-control"
                  placeholder="Min. 12 chars, 1 number, 1 special character"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="acceptinvite-confirm-password">Confirm password</label>
                <PasswordInput
                  id="acceptinvite-confirm-password"
                 
                  
                  className="form-control"
                  placeholder="Re-enter your password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </div>

              <div className="form-group" style={{ marginTop: 12 }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 'var(--font-size-ui)', lineHeight: 1.5 }}>
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={e => setAccepted(e.target.checked)}
                    required
                    style={{ marginTop: 3, flexShrink: 0 }}
                  />
                  <span>
                    {/* Pass-3 audit MUST #2: same consent gate as the
                        self-signup path. All four docs that ship in the
                        server's TERMS_VERSION write must be visibly
                        linked here so the consent is specific (GDPR
                        Art. 7) rather than implied. */}
                    I have read and agree to the{' '}
                    <a href="/legal/eula" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)', textDecoration: 'underline' }}>End-User License Agreement</a>,{' '}
                    <a href="/legal/terms" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)', textDecoration: 'underline' }}>Terms of Service</a>
                    ,{' '}and{' '}
                    <a href="/legal/privacy" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)', textDecoration: 'underline' }}>Privacy Policy</a>.
                  </span>
                </label>
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                style={{ width: '100%', justifyContent: 'center', padding: '10px' }}
                disabled={submitting || !accepted}
              >
                {submitting ? 'Creating account…' : 'Create account & sign in'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
