import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import PasswordInput from '../components/PasswordInput';

export default function ResetPassword() {
  useDocumentTitle('Reset password');
  const { token } = useParams();
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!password) {
      setError('Please enter a password.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/api/auth/reset-password', { token, password });
      setDone(true);
      setTimeout(() => navigate('/login'), 3000);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to reset password. The link may have expired.');
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

        {done ? (
          <>
            <div className="login-title">Password updated</div>
            <p style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
              Your password has been reset. Redirecting you to sign in…
            </p>
          </>
        ) : (
          <>
            <div className="login-title">Choose a new password</div>

            {error && <div role="alert" className="alert alert-error">{error}</div>}

            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label className="form-label" htmlFor="resetpassword-new-password">New password</label>
                <PasswordInput
                  id="resetpassword-new-password"
                 
                  
                  className="form-control"
                  placeholder="Min. 12 chars, 1 number, 1 special character"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoFocus
                  autoComplete="new-password"
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="resetpassword-confirm-new-password">Confirm new password</label>
                <PasswordInput
                  id="resetpassword-confirm-new-password"
                 
                  
                  className="form-control"
                  placeholder="Re-enter your password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </div>

              <button
                type="submit"
                className="btn btn-primary"
                style={{ width: '100%', justifyContent: 'center', padding: '10px' }}
                disabled={submitting}
              >
                {submitting ? 'Saving…' : 'Set new password'}
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
