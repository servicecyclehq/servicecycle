// ─────────────────────────────────────────────────────────────────────────────
// InviteAcceptPage.jsx — public page for accepting a partner invite
//
// Route: /invite/accept?token=<hex>
// Calls: GET  /api/invite/accept?token=  (preview — no auth required)
//        POST /api/invite/accept          (accept — no auth required)
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';

export default function InviteAcceptPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const token = params.get('token') ?? '';

  const [preview, setPreview] = useState(null);   // loaded from GET
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) {
      setError('No invite token found in URL.');
      setLoading(false);
      return;
    }
    api.get(`/api/invite/accept?token=${encodeURIComponent(token)}`)
      .then((r) => setPreview(r.data))
      .catch((e) => setError(e.response?.data?.error ?? 'Failed to load invite details.'))
      .finally(() => setLoading(false));
  }, [token]);

  async function handleAccept() {
    if (accepting) return;
    // Accepting links your account — it requires being signed in as the invited
    // user. If logged out, send them to login and return here to finish.
    if (!user) {
      navigate(`/login?next=${encodeURIComponent(`/invite/accept?token=${token}`)}`);
      return;
    }
    setAccepting(true);
    setError('');
    try {
      await api.post('/api/invite/accept', { token });
      setAccepted(true);
    } catch (e) {
      setError(e.response?.data?.error ?? 'Failed to accept invite. Please try again.');
      setAccepting(false);
    }
  }

  return (
    <div style={S.page}>
      <div style={S.card}>
        {/* Logo / wordmark */}
        <div style={S.brand}>ServiceCycle</div>

        {loading && (
          <div style={S.center}>
            <div style={S.spinner} />
            <p style={S.muted}>Verifying invite…</p>
          </div>
        )}

        {!loading && error && !preview && (
          <div style={S.errorBox}>
            <div style={S.errorTitle}>Invite not valid</div>
            <p style={S.muted}>{error}</p>
            <button style={S.secondaryBtn} onClick={() => navigate('/login')}>
              Go to login
            </button>
          </div>
        )}

        {!loading && preview && !accepted && (
          <>
            {/* Expired / already used */}
            {(preview.expired || preview.alreadyUsed) && (
              <div style={S.errorBox}>
                <div style={S.errorTitle}>
                  {preview.expired ? 'Invite has expired' : 'Invite already used'}
                </div>
                <p style={S.muted}>
                  {preview.expired
                    ? 'This invite link has expired. Ask your service partner to send a new one.'
                    : 'This invite has already been accepted.'}
                </p>
                <button style={S.secondaryBtn} onClick={() => navigate('/login')}>
                  Go to login
                </button>
              </div>
            )}

            {/* Valid invite — show accept form */}
            {!preview.expired && !preview.alreadyUsed && (
              <>
                <div style={S.heading}>Partner connection request</div>

                <div style={S.orgBlock}>
                  <div style={S.orgLabel}>Service partner</div>
                  <div style={S.orgName}>{preview.partnerOrgName ?? 'A service partner'}</div>
                  {preview.inviteeEmail && (
                    <div style={S.orgMeta}>Invite sent to {preview.inviteeEmail}</div>
                  )}
                </div>

                <div style={S.consentBox}>
                  <p style={S.consentIntro}>
                    By accepting, {preview.partnerOrgName ?? 'this partner'} will be able to
                    view compliance alerts and service events for your account — based on the
                    sharing preferences you set in <strong>Settings → Connected Partner</strong>.
                    All sharing is opt-in and can be revoked at any time.
                  </p>
                  <ul style={S.consentList}>
                    <li>You control which event categories are shared</li>
                    <li>All toggles default to <strong>off</strong></li>
                    <li>You can disconnect the partner from your settings at any time</li>
                  </ul>
                </div>

                {error && <div style={S.inlineError}>{error}</div>}

                <button
                  style={S.acceptBtn}
                  onClick={handleAccept}
                  disabled={accepting}
                >
                  {accepting ? 'Connecting…' : (user ? 'Accept & connect' : 'Sign in to accept')}
                </button>

                <button
                  style={S.secondaryBtn}
                  onClick={() => navigate('/login')}
                  disabled={accepting}
                >
                  Decline
                </button>
              </>
            )}
          </>
        )}

        {accepted && (
          <div style={S.successBox}>
            <div style={S.successIcon}>✓</div>
            <div style={S.successTitle}>Connected!</div>
            <p style={S.muted}>
              Your account is now linked to{' '}
              <strong>{preview?.partnerOrgName ?? 'your service partner'}</strong>.
              Visit Settings → Connected Partner to configure what they can see.
            </p>
            <button style={S.acceptBtn} onClick={() => navigate('/login')}>
              {preview?.existingAccount ? 'Sign in' : 'Continue to login'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--bg, #f8fafc)',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 480,
    background: 'var(--surface, #fff)',
    border: '1px solid var(--border, #e2e8f0)',
    borderRadius: 14,
    padding: '36px 40px',
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },
  brand: {
    fontWeight: 800,
    fontSize: 18,
    color: 'var(--accent, #6366f1)',
    letterSpacing: '-0.5px',
    marginBottom: 4,
  },
  heading: {
    fontSize: 20,
    fontWeight: 700,
    color: 'var(--text-primary, #0f172a)',
  },
  center: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    padding: '20px 0',
  },
  spinner: {
    width: 28,
    height: 28,
    borderRadius: '50%',
    border: '3px solid var(--border, #e2e8f0)',
    borderTopColor: 'var(--accent, #6366f1)',
    animation: 'spin 0.7s linear infinite',
  },
  muted: {
    fontSize: 13,
    color: 'var(--color-text-secondary, #64748b)',
    margin: 0,
    lineHeight: 1.5,
  },
  orgBlock: {
    background: 'var(--bg, #f8fafc)',
    border: '1px solid var(--border, #e2e8f0)',
    borderRadius: 8,
    padding: '14px 16px',
  },
  orgLabel: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--color-text-secondary, #64748b)',
    marginBottom: 4,
  },
  orgName: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--text-primary, #0f172a)',
  },
  orgMeta: {
    fontSize: 12,
    color: 'var(--color-text-secondary, #64748b)',
    marginTop: 4,
  },
  consentBox: {
    background: '#f0fdf4',
    border: '1px solid #bbf7d0',
    borderRadius: 8,
    padding: '14px 16px',
  },
  consentIntro: {
    fontSize: 13,
    color: '#166534',
    margin: '0 0 10px',
    lineHeight: 1.55,
  },
  consentList: {
    margin: 0,
    paddingLeft: 18,
    fontSize: 12,
    color: '#15803d',
    lineHeight: 1.8,
  },
  inlineError: {
    fontSize: 13,
    color: '#b91c1c',
    background: '#fee2e2',
    border: '1px solid #fca5a5',
    borderRadius: 6,
    padding: '10px 14px',
  },
  acceptBtn: {
    width: '100%',
    padding: '12px 0',
    fontSize: 15,
    fontWeight: 600,
    background: 'var(--accent, #6366f1)',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
  },
  secondaryBtn: {
    width: '100%',
    padding: '10px 0',
    fontSize: 14,
    background: 'transparent',
    color: 'var(--color-text-secondary, #64748b)',
    border: '1px solid var(--border, #e2e8f0)',
    borderRadius: 8,
    cursor: 'pointer',
  },
  errorBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: '#b91c1c',
  },
  successBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    alignItems: 'center',
    textAlign: 'center',
  },
  successIcon: {
    width: 48,
    height: 48,
    borderRadius: '50%',
    background: '#dcfce7',
    color: '#16a34a',
    fontSize: 22,
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  successTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: '#166534',
  },
};
