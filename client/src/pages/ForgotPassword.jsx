import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import BrandMark from '../components/BrandMark';

export default function ForgotPassword() {
  useDocumentTitle('Forgot password');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await api.post('/api/auth/forgot-password', { email });
      setSent(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-box">
        <div className="login-logo">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
            {/* Public routes always render light (theme-bootstrap), matching
                Login / SsoCallback so the auth flow has one brand treatment. */}
            <BrandMark size={40} variant="light" />
            <span className="login-logo-name">Service<span style={{ color: '#65a30d' }}>C</span>ycle</span>
          </div>
          <div className="login-logo-tagline">Electrical Asset Management</div>
        </div>

        {sent ? (
          <>
            <div className="login-title">Check your email</div>
            <p style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: 24 }}>
              If <strong style={{ color: 'var(--color-text)' }}>{email}</strong> is registered, we've sent a
              password reset link. It expires in 1 hour.
            </p>
            <p style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
              Didn't get it? Check your spam folder, or{' '}
              <button
                onClick={() => setSent(false)}
                style={{ background: 'none', border: 'none', color: 'var(--color-primary)', cursor: 'pointer', fontSize: 'var(--font-size-ui)', padding: 0 }}
              >
                try again
              </button>
              .
            </p>
          </>
        ) : (
          <>
            <div className="login-title">Reset your password</div>
            <p style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-text-secondary)', marginBottom: 20 }}>
              Enter your email and we'll send you a reset link.
            </p>

            {error && <div role="alert" className="alert alert-error">{error}</div>}

            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label className="form-label" htmlFor="forgotpassword-email-address">Email address</label>
                <input
                  id="forgotpassword-email-address"
                 
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

              <button
                type="submit"
                className="btn btn-primary"
                style={{ width: '100%', justifyContent: 'center', padding: '10px' }}
                disabled={submitting}
              >
                {submitting ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
          </>
        )}

        <p style={{ marginTop: 20, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', textAlign: 'center' }}>
          <Link to="/login" style={{ color: 'var(--color-primary)' }}>← Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}
