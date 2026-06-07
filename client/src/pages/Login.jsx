import { useState, useEffect } from 'react';
import { useNavigate, Navigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import PasswordInput from '../components/PasswordInput';
import BrandMark from '../components/BrandMark';

export default function Login() {
  useDocumentTitle('Sign in');
  const { user, loading, login, verify2fa, demoMode } = useAuth();
  const navigate = useNavigate();

  // L7+legal: surface the "Create an account" link only when the server
  // accepts public registrations (REGISTRATION_OPEN=true on self-hosted, or
  // DEMO_MODE=true on the demo box). Avoids showing a dead link on a
  // locked-down on-prem install.
  const [registrationOpen, setRegistrationOpen] = useState(false);
  useEffect(() => {
    api.get('/api/setup/status')
      .then(r => setRegistrationOpen(!!r?.data?.data?.registrationOpen))
      .catch(() => setRegistrationOpen(false));
  }, []);

  const [email, setEmail]         = useState('');
  const [password, setPassword]   = useState('');
  const [error, setError]         = useState('');
  // H1-7 (v0.76.6): track failed login attempts to nudge towards forgot-password
  const [loginAttempts, setLoginAttempts] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // 2FA step state
  const [pending2fa, setPending2fa]   = useState(false);  // are we on the TOTP step?
  const [twoFactorToken, setTwoFactorToken] = useState('');
  const [totpCode, setTotpCode]       = useState('');

  // v0.37.2 W6 MT-116: read the session-expired flag api/client.js sets when
  // a refresh-token failure forces a re-login. Cleared immediately so a
  // subsequent deliberate visit to /login doesn't re-show the toast.
  const [sessionExpired, setSessionExpired] = useState(false);
  useEffect(() => {
    try {
      if (sessionStorage.getItem('servicecycle_session_expired') === 'true') {
        setSessionExpired(true);
        sessionStorage.removeItem('servicecycle_session_expired');
      }
    } catch (_) { /* ignore */ }
  }, []);

  // Already logged in — redirect
  if (!loading && user) {
    return <Navigate to="/dashboard" replace />;
  }

  // ── Step 1: Email + password ───────────────────────────────────────────────

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const data = await login(email, password);

      if (data?.requires2fa) {
        // Server wants a TOTP code — switch to step 2
        setTwoFactorToken(data.twoFactorToken);
        setPending2fa(true);
        return;
      }

      navigate('/dashboard');
    } catch (err) {
      const msg = err.response?.data?.error || 'Login failed. Please try again.';
      setError(msg);
      setLoginAttempts(n => n + 1);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Step 2: TOTP code ──────────────────────────────────────────────────────

  const handleTotpSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      await verify2fa(twoFactorToken, totpCode);
      navigate('/dashboard');
    } catch (err) {
      const msg = err.response?.data?.error || 'Invalid code. Please try again.';
      setError(msg);
      setTotpCode('');
    } finally {
      setSubmitting(false);
    }
  };

  const handleBackToLogin = () => {
    setPending2fa(false);
    setTwoFactorToken('');
    setTotpCode('');
    setError('');
  };

  return (
    <div className="login-page">
      <div className="login-box">
        <div className="login-logo">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
            {/* Public routes always render light (theme-bootstrap UX-THEME-001),
                so the onLight variant is correct here. */}
            <BrandMark size={40} variant="light" />
            <span className="login-logo-name">Service<span style={{ color: '#65a30d' }}>C</span>ycle</span>
          </div>
          <div className="login-logo-tagline">Renewal management</div>
        </div>

        {!pending2fa ? (
          <>
            <h1 className="login-title">Sign in to your account</h1>

            {/* v0.37.2 W6 MT-116: session-expired feedback. Renders only on
                the first /login mount after a refresh-token failure; once
                dismissed (and the flag cleared on mount), subsequent visits
                don't re-show it. Distinct from the form-level error alert
                below — different colour so a user who comes back from an
                expiry sees one signal, then a separate one if they fail
                login. */}
            {sessionExpired && (
              <div
                role="status"
                aria-live="polite"
                style={{
                  marginBottom: 12,
                  padding:       '10px 14px',
                  borderRadius:  6,
                  background:    'rgba(234, 179, 8, 0.10)',
                  border:        '1px solid rgba(234, 179, 8, 0.35)',
                  color:         'rgb(133, 77, 14)',
                  fontSize: 'var(--font-size-ui)',
                  lineHeight:    1.45,
                }}
              >
                Your session expired. Please sign in again to pick up where you left off.
              </div>
            )}

            {error && <div role="alert" className="alert alert-error">{error}</div>}
            {loginAttempts >= 2 && (
              <p style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginTop: 6, marginBottom: 0 }}>
                Forgotten your password? Use the{' '}
                <a href="/forgot-password" style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Forgot password</a>{' '}
                link below.
              </p>
            )}

            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label className="form-label" htmlFor="login-email">Email address</label>
                <input
                  id="login-email"
                  type="email"
                  className="form-control"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                  autoComplete="email"
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="login-password">Password</label>
                <PasswordInput
                  id="login-password"
                  className="form-control"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />
                <div style={{ marginTop: 6, textAlign: 'right' }}>
                  <Link
                    to="/forgot-password"
                    style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-primary)' }}
                  >
                    Forgot password?
                  </Link>
                </div>
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                style={{ width: '100%', justifyContent: 'center', padding: '10px' }}
                disabled={submitting}
              >
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            {registrationOpen ? (
              <p style={{ marginTop: 20, fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', textAlign: 'center' }}>
                {demoMode ? 'Want your own sandbox?' : 'No account yet?'}
                {/* 2026-05-10 review H4 fix: belt-and-braces — the previous
                    <Link> rendered an <a href="/register"> with React Router's
                    intercepted onClick. The review caught one repro where the
                    click didn't navigate; pairing it with an explicit
                    onClick → navigate() guarantees activation regardless of
                    Router event-handler timing. */}
                <br />
                <Link
                  to="/register"
                  onClick={(e) => {
                    if (e.defaultPrevented) return;
                    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    navigate('/register');
                  }}
                  style={{ color: 'var(--color-primary)', fontWeight: 500 }}
                >
                  {demoMode ? 'Create your demo sandbox →' : 'Create an account →'}
                </Link>
              </p>
            ) : (
              <p style={{ marginTop: 20, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', textAlign: 'center' }}>
                Need access? Contact your ServiceCycle administrator.
              </p>
            )}
          </>
        ) : (
          <>
            <h1 className="login-title">Two-factor authentication</h1>
            <p style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-text-secondary)', marginBottom: 20 }}>
              Enter the 6-digit code from your authenticator app, or one of your backup codes.
            </p>

            {error && <div role="alert" className="alert alert-error">{error}</div>}
            {loginAttempts >= 2 && (
              <p style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginTop: 6, marginBottom: 0 }}>
                Forgotten your password? Use the{' '}
                <a href="/forgot-password" style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Forgot password</a>{' '}
                link below.
              </p>
            )}

            <form onSubmit={handleTotpSubmit}>
              <div className="form-group">
                <label className="form-label" htmlFor="login-totp">Verification code</label>
                <input
                  id="login-totp"
                  type="text"
                  className="form-control"
                  placeholder="000 000"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\s/g, ''))}
                  required
                  autoFocus
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={8}
                  style={{ letterSpacing: '0.15em', fontSize: 20, textAlign: 'center' }}
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                style={{ width: '100%', justifyContent: 'center', padding: '10px' }}
                disabled={submitting || totpCode.length < 6}
              >
                {submitting ? 'Verifying…' : 'Verify'}
              </button>
            </form>

            <p style={{ marginTop: 16, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', textAlign: 'center' }}>
              <button
                onClick={handleBackToLogin}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-primary)', fontSize: 'var(--font-size-sm)', padding: 0 }}
              >
                ← Back to login
              </button>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
