import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import PasswordInput from '../components/PasswordInput';

// Feature display config (must stay in sync with server/lib/featureFlags.ts).
// Only user-hideable features belong here — the "My View" card lets users
// hide these from their own sidebar without changing admin-granted access.
const FEATURE_META = {
  maintenance_brief: { label: 'AI Maintenance Brief', icon: '✨' },
  export:            { label: 'Export',               icon: '⬇️' },
  alerts:            { label: 'Alerts',               icon: '🔔' },
};

const ROLE_LABELS = {
  admin:      'Admin',
  manager:    'Manager',
  viewer:     'Viewer',
  consultant: 'Consultant',
};

export default function ProfilePage() {
  useDocumentTitle('My profile');
  const { user, updateUser, updateHiddenFeatures } = useAuth();

  // ── Profile (name) form ────────────────────────────────────────────────────
  const [name, setName]           = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileSaved, setProfileSaved]   = useState(false);
  const [profileError, setProfileError]   = useState('');

  useEffect(() => {
    if (user?.name) setName(user.name);
  }, [user?.name]);

  async function saveProfile(e) {
    e.preventDefault();
    if (!name.trim()) { setProfileError('Name cannot be empty.'); return; }
    setProfileError('');
    setProfileSaving(true);
    try {
      const res = await api.put('/api/users/me', { name: name.trim() });
      // Refresh the auth context so the sidebar name updates immediately
      if (res.data.data?.user) {
        updateUser({ name: res.data.data.user.name });
      }
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2500);
    } catch (err) {
      setProfileError(err.response?.data?.error || 'Failed to update profile.');
    } finally {
      setProfileSaving(false);
    }
  }

  // ── Password policy minimum (fetched from /api/settings/public) ───────────
  const [pwMinLength, setPwMinLength] = useState(12);
  useEffect(() => {
    api.get('/api/settings/public')
      .then(r => { if (r.data.data?.passwordMinLength) setPwMinLength(r.data.data.passwordMinLength); })
      .catch(() => {}); // silently fall back to default 12
  }, []);

  // ── Password change form ───────────────────────────────────────────────────
  const [currentPw, setCurrentPw]   = useState('');
  const [newPw, setNewPw]           = useState('');
  const [confirmPw, setConfirmPw]   = useState('');
  const [pwSaving, setPwSaving]     = useState(false);
  const [pwSaved, setPwSaved]       = useState(false);
  const [pwError, setPwError]       = useState('');

  async function savePassword(e) {
    e.preventDefault();
    if (!currentPw) { setPwError('Current password is required.'); return; }
    if (newPw.length < pwMinLength) { setPwError(`New password must be at least ${pwMinLength} characters.`); return; }
    if (!/\d/.test(newPw)) { setPwError('New password must contain at least one number.'); return; }
    if (!/[^a-zA-Z0-9]/.test(newPw)) { setPwError('New password must contain at least one special character.'); return; }
    if (newPw !== confirmPw) { setPwError('Passwords do not match.'); return; }

    setPwError('');
    setPwSaving(true);
    try {
      await api.put('/api/users/me/password', { currentPassword: currentPw, newPassword: newPw });
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
      setPwSaved(true);
      setTimeout(() => setPwSaved(false), 2500);
    } catch (err) {
      setPwError(err.response?.data?.error || 'Failed to change password.');
    } finally {
      setPwSaving(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">My Profile</h1>
          <div className="page-subtitle">Update your name and password</div>
        </div>
      </div>

      <div className="page-body" style={{ maxWidth: 560 }}>

        {/* ── Account Info (read-only) ────────────────────────────────────── */}
        <div className="card mb-16">
          <div className="card-header">
            <div className="card-title">Account Info</div>
          </div>
          <div style={{ padding: '4px 0 16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 24px' }}>
              <div style={{ padding: '12px 20px' }}>
                <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                  Email
                </div>
                <div style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-text)' }}>{user?.email}</div>
              </div>
              <div style={{ padding: '12px 20px' }}>
                <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                  Role
                </div>
                <div style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-text)' }}>{ROLE_LABELS[user?.role] || user?.role}</div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Display Name ────────────────────────────────────────────────── */}
        <div className="card mb-16">
          <div className="card-header">
            <div className="card-title">Display Name</div>
          </div>
          <form onSubmit={saveProfile} style={{ padding: '12px 20px 20px' }}>
            <div className="form-group">
              <label className="form-label" htmlFor="pf-name">Name</label>
              <input
                id="pf-name"
                className="form-input"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Your full name"
                maxLength={100}
              />
            </div>
            {profileError && <div role="alert" className="alert alert-error mb-12" style={{ marginBottom: 12 }}>{profileError}</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button className="btn btn-primary" type="submit" disabled={profileSaving}>
                {profileSaving ? 'Saving…' : 'Save Name'}
              </button>
              {profileSaved && <span style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-success, #15803d)' }}>Saved ✓</span>}
            </div>
          </form>
        </div>

        {/* ── Password ────────────────────────────────────────────────────── */}
        <div className="card mb-16">
          <div className="card-header">
            <div className="card-title">Change Password</div>
          </div>
          <form onSubmit={savePassword} style={{ padding: '12px 20px 20px' }}>
            <div className="form-group">
              <label className="form-label" htmlFor="pf-current-pw">Current Password</label>
              <PasswordInput
                id="pf-current-pw"
                className="form-input"
                
                value={currentPw}
                onChange={e => setCurrentPw(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="pf-new-pw">New Password</label>
              <PasswordInput
                id="pf-new-pw"
                className="form-input"
                
                value={newPw}
                onChange={e => setNewPw(e.target.value)}
                autoComplete="new-password"
                minLength={pwMinLength}
              />
              {/* v0.5.17: live requirement indicators mirroring Register.jsx so
                  users see number/special rules up-front instead of bouncing
                  off the server. Empty state stays neutral; once typing, unmet
                  rules flag red, met rules green. Server (passwordPolicy.js)
                  is still authoritative on accept/reject. */}
              <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.7 }}>
                {[
                  { ok: newPw.length >= pwMinLength, label: `At least ${pwMinLength} characters` },
                  { ok: /\d/.test(newPw), label: 'At least one number' },
                  { ok: /[^a-zA-Z0-9]/.test(newPw), label: 'At least one special character (e.g. ! @ # $ %)' },
                ].map(({ ok, label }) => {
                  const showFail = !ok && newPw.length > 0;
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
              <label className="form-label" htmlFor="pf-confirm-pw">Confirm New Password</label>
              <PasswordInput
                id="pf-confirm-pw"
                className="form-input"
                
                value={confirmPw}
                onChange={e => setConfirmPw(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            {pwError && <div role="alert" className="alert alert-error mb-12" style={{ marginBottom: 12 }}>{pwError}</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button className="btn btn-primary" type="submit" disabled={pwSaving}>
                {pwSaving ? 'Saving…' : 'Change Password'}
              </button>
              {pwSaved && <span style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-success, #15803d)' }}>Password changed ✓</span>}
            </div>
          </form>
        </div>

        {/* ── My View ─────────────────────────────────────────────────────── */}
        <MyViewCard user={user} updateHiddenFeatures={updateHiddenFeatures} />

        {/* ── Two-Factor Auth ──────────────────────────────────────────────── */}
        <TwoFactorCard />

        {/* ── Your data (GDPR Art. 15 + Art. 17) ────────────────────────────── */}
        <YourDataCard user={user} />

      </div>
    </>
  );
}

// ── Your data card — GDPR-compliance UI surface ───────────────────────────────
//
// Pass-3 audit HIGH #2 (2026-05-17): the data-export + data-erasure
// endpoints landed in W5 / W10 (server/routes/users.js) but had no
// in-app UI. Privacy Policy promised both rights with no way to
// exercise them short of emailing support. This card surfaces both
// for the signed-in user.

function YourDataCard({ user }) {
  const [exporting, setExporting]   = useState(false);
  const [deleting, setDeleting]     = useState(false);
  const [exportMsg, setExportMsg]   = useState('');
  const [deleteMsg, setDeleteMsg]   = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const downloadExport = async () => {
    if (exporting) return;
    setExporting(true);
    setExportMsg('');
    try {
      // GET /api/users/:id/export returns application/json with a
      // Content-Disposition: attachment header. Trigger a real browser
      // download via a blob URL rather than `window.location` so the
      // current SPA route stays intact.
      const res = await api.get(`/api/users/${user.id}/export`, { responseType: 'blob' });
      const blob = new Blob([res.data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `servicecycle-user-${user.id}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportMsg('Exported.');
      setTimeout(() => setExportMsg(''), 4000);
    } catch (err) {
      setExportMsg(err.response?.data?.error || 'Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  // Self-delete intentionally NOT enabled in this UI — the server-side
  // DELETE /api/users/:id requires requireAdmin AND refuses self-delete
  // (you cannot delete the account you're signed in as). To exercise
  // the GDPR Art. 17 right, contact an admin OR (when implemented)
  // email the privacy address. For admins erasing OTHER users, see
  // UsersPage's row action.

  return (
    <div className="card">
      <h2>Your data</h2>
      <p style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginTop: -4, marginBottom: 12 }}>
        Exercise your data-protection rights. The export includes every row
        in ServiceCycle that references your account, in a single JSON file.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 500, marginBottom: 4 }}>Export my data</div>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', margin: '0 0 8px' }}>
            GDPR Article 15 / CCPA right to know. Returns a JSON archive of
            your profile, activity log, refresh-token metadata, AI usage,
            alert preferences, and any communications you authored.
          </p>
          <button className="btn btn-secondary btn-sm" onClick={downloadExport} disabled={exporting}>
            {exporting ? 'Preparing export…' : 'Download my data (JSON)'}
          </button>
          {exportMsg && <span style={{ marginLeft: 10, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>{exportMsg}</span>}
        </div>

        <div>
          <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 500, marginBottom: 4 }}>Delete my account</div>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', margin: '0 0 8px' }}>
            GDPR Article 17 right to erasure. Removes your user record and
            anonymizes references in the audit log + maintenance history.
            <strong> An admin in your account must perform this action </strong>
            — you cannot delete the account you're signed in as. Ask an
            admin to use the "Erase user" action on the Users page, or
            email{' '}
            <a href="mailto:privacy@servicecycle.app" style={{ color: 'var(--color-primary)', textDecoration: 'underline' }}>
              privacy@servicecycle.app
            </a>{' '}
            if you're the only admin.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── My View component ─────────────────────────────────────────────────────────

function MyViewCard({ user, updateHiddenFeatures }) {
  const [hidden, setHidden]   = useState({});
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [error, setError]     = useState('');

  // Sync hidden state from user object
  useEffect(() => {
    setHidden(user?.hiddenFeatures || {});
  }, [user?.hiddenFeatures]);

  // Which features has the admin granted to this user?
  const granted = user?.featureFlags || {};
  const grantedFeatures = Object.keys(FEATURE_META).filter(f => granted[f] !== false);

  if (grantedFeatures.length === 0) {
    return (
      <div className="card">
        <div className="card-header"><div className="card-title">My View</div></div>
        <div style={{ padding: '16px 20px 20px', fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
          No optional features are currently enabled on your account. Contact an admin to request access.
        </div>
      </div>
    );
  }

  function toggle(feature) {
    setHidden(prev => ({ ...prev, [feature]: !prev[feature] }));
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      await updateHiddenFeatures(hidden);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      setError('Failed to save preferences.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">My View</div>
      </div>
      <div style={{ padding: '4px 20px 20px' }}>
        <p style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', margin: '12px 0 16px', lineHeight: 1.5 }}>
          Hide features you don't use from the sidebar. You can re-show them here at any time — contact an admin if a feature you need isn't listed.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {grantedFeatures.map(f => {
            const m = FEATURE_META[f];
            const isHidden = !!hidden[f];
            return (
              <label
                key={f}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '10px 14px', borderRadius: 'var(--radius)',
                  border: '1px solid var(--color-border)',
                  cursor: 'pointer', userSelect: 'none',
                  background: isHidden ? 'var(--color-surface)' : '',
                  opacity: isHidden ? 0.7 : 1,
                  transition: 'all 0.1s',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 'var(--font-size-ui)', fontWeight: 500 }}>
                  <span style={{ fontSize: 16 }}>{m.icon}</span>
                  {m.label}
                  {isHidden && (
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontWeight: 400 }}>hidden</span>
                  )}
                </span>
                {/* Toggle switch */}
                <span
                  onClick={() => toggle(f)}
                  style={{
                    display: 'inline-flex', width: 36, height: 20, borderRadius: 10,
                    background: isHidden ? 'var(--color-border)' : 'var(--color-primary)',
                    position: 'relative', transition: 'background 0.2s', flexShrink: 0,
                  }}
                >
                  <span style={{
                    position: 'absolute', top: 2, left: isHidden ? 2 : 18,
                    width: 16, height: 16, borderRadius: '50%', background: 'var(--color-surface)',
                    transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }} />
                </span>
              </label>
            );
          })}
        </div>

        {error && <div role="alert" className="alert alert-error" style={{ marginTop: 12 }}>{error}</div>}
        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save Preferences'}
          </button>
          {saved && <span style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-success, #15803d)' }}>Saved ✓</span>}
        </div>
      </div>
    </div>
  );
}

// ── Two-Factor Authentication card ────────────────────────────────────────────

function TwoFactorCard() {
  const [status, setStatus]         = useState(null);   // { enabled, backupCodesRemaining }
  const [loading, setLoading]       = useState(true);
  const [step, setStep]             = useState('idle'); // idle | setup | confirm | backup | disable | regen
  const [qrCode, setQrCode]         = useState('');
  const [secret, setSecret]         = useState('');
  const [backupCodes, setBackupCodes] = useState([]);
  const [code, setCode]             = useState('');
  const [error, setError]           = useState('');
  const [working, setWorking]       = useState(false);
  const [showManualKey, setShowManualKey] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/api/auth/2fa/status');
      setStatus(r.data.data);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const reset = () => { setStep('idle'); setCode(''); setError(''); setQrCode(''); setSecret(''); setBackupCodes([]); };

  // ── Start setup flow ────────────────────────────────────────────────────────
  async function startSetup() {
    setWorking(true); setError('');
    try {
      const r = await api.post('/api/auth/2fa/setup');
      setQrCode(r.data.data.qrCode);
      setSecret(r.data.data.secret);
      setBackupCodes(r.data.data.backupCodes);
      setStep('setup');
    } catch (e) { setError(e.response?.data?.error || 'Setup failed'); }
    finally { setWorking(false); }
  }

  // ── Confirm TOTP code to enable ──────────────────────────────────────────────
  async function confirmEnable(e) {
    e.preventDefault(); setWorking(true); setError('');
    try {
      await api.post('/api/auth/2fa/enable', { code });
      await fetchStatus();
      setStep('backup'); // show backup codes one last time
    } catch (e) { setError(e.response?.data?.error || 'Invalid code'); setCode(''); }
    finally { setWorking(false); }
  }

  // ── Disable 2FA ──────────────────────────────────────────────────────────────
  async function confirmDisable(e) {
    e.preventDefault(); setWorking(true); setError('');
    try {
      await api.delete('/api/auth/2fa/disable', { data: { code } });
      await fetchStatus();
      reset();
    } catch (e) { setError(e.response?.data?.error || 'Invalid code'); setCode(''); }
    finally { setWorking(false); }
  }

  // ── Regenerate backup codes ───────────────────────────────────────────────────
  async function confirmRegen(e) {
    e.preventDefault(); setWorking(true); setError('');
    try {
      const r = await api.post('/api/auth/2fa/backup-codes/regenerate', { code });
      setBackupCodes(r.data.data.backupCodes);
      await fetchStatus();
      setStep('backup');
      setCode('');
    } catch (e) { setError(e.response?.data?.error || 'Invalid code'); setCode(''); }
    finally { setWorking(false); }
  }

  function downloadBackupCodes() {
    const text = backupCodes.join('\n');
    const blob = new Blob([`ServiceCycle 2FA Backup Codes\n=============================\nSave these codes somewhere safe. Each code can only be used once.\n\n${text}\n`], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'servicecycle-backup-codes.txt';
    a.click();
  }

  if (loading) return null;

  return (
    <div className="card mt-16">
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div className="card-title">Two-Factor Authentication</div>
          <div className="card-subtitle">
            {status?.enabled
              ? `Enabled · ${status.backupCodesRemaining} backup code${status.backupCodesRemaining !== 1 ? 's' : ''} remaining`
              : 'Add a second layer of security to your account'}
          </div>
        </div>
        <span style={{
          fontSize: 'var(--font-size-sm)', fontWeight: 700, padding: '3px 10px', borderRadius: 20,
          background: status?.enabled ? '#f0fdf4' : 'var(--color-bg)',
          color: status?.enabled ? '#15803d' : 'var(--color-text-secondary)',
        }}>
          {status?.enabled ? '✓ Enabled' : 'Disabled'}
        </span>
      </div>

      <div style={{ padding: '16px 20px' }}>
        {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

        {/* ── IDLE: show setup or manage buttons ────────────────────────────── */}
        {step === 'idle' && !status?.enabled && (
          <div>
            <p style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-text-secondary)', marginBottom: 16 }}>
              Use an authenticator app (Google Authenticator, Authy, 1Password) to generate time-based codes at login.
            </p>
            <button className="btn btn-primary" onClick={startSetup} disabled={working}>
              {working ? 'Setting up…' : 'Set up 2FA'}
            </button>
          </div>
        )}

        {step === 'idle' && status?.enabled && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={() => { setStep('regen'); setError(''); }}>
              Regenerate backup codes
            </button>
            <button className="btn btn-secondary" onClick={() => { setStep('disable'); setError(''); }}
              style={{ color: 'var(--color-danger)', borderColor: 'var(--color-danger)' }}>
              Disable 2FA
            </button>
          </div>
        )}

        {/* ── SETUP: QR code + backup codes display ─────────────────────────── */}
        {step === 'setup' && (
          <div>
            <p style={{ fontSize: 'var(--font-size-data)', marginBottom: 16 }}>
              <strong>Step 1.</strong> Scan this QR code with your authenticator app.
            </p>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 16 }}>
              <img src={qrCode} alt="2FA QR code" style={{ width: 180, height: 180, border: '1px solid var(--color-border)', borderRadius: 8 }} />
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                  Can't scan? Enter this key manually:
                </p>
                <button onClick={() => setShowManualKey(v => !v)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-primary)', fontSize: 'var(--font-size-ui)', padding: 0, marginBottom: 8 }}>
                  {showManualKey ? '▼ Hide key' : '▶ Show manual key'}
                </button>
                {showManualKey && (
                  <code style={{ display: 'block', fontSize: 'var(--font-size-ui)', background: 'var(--color-surface-alt, #fafbfd)', padding: '8px 12px', borderRadius: 6, wordBreak: 'break-all', letterSpacing: '0.08em' }}>
                    {secret}
                  </code>
                )}
              </div>
            </div>

            <div style={{ background: 'var(--color-warning-bg)', border: '1px solid #fde68a', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
              <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 700, color: 'var(--color-warning)', marginBottom: 8 }}>
                ⚠ Save your backup codes before continuing
              </div>
              <p style={{ fontSize: 'var(--font-size-ui)', color: '#78350f', marginBottom: 10 }}>
                These 8 one-time codes let you sign in if you lose your phone. Each can only be used once.
                <strong> You won't be able to see them again.</strong>
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4, marginBottom: 10 }}>
                {backupCodes.map(c => (
                  <code key={c} style={{ fontSize: 'var(--font-size-ui)', background: 'var(--color-surface)', padding: '4px 8px', borderRadius: 4, border: '1px solid #fcd34d', letterSpacing: '0.1em' }}>{c}</code>
                ))}
              </div>
              <button className="btn btn-secondary btn-sm" onClick={downloadBackupCodes}>⬇ Download codes</button>
            </div>

            <p style={{ fontSize: 'var(--font-size-data)', marginBottom: 12 }}>
              <strong>Step 2.</strong> Enter the 6-digit code from your app to confirm setup.
            </p>
            <form onSubmit={confirmEnable} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <input
                  type="text"
                  className="form-control"
                  placeholder="000000"
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  maxLength={6}
                  style={{ width: 120, letterSpacing: '0.2em', textAlign: 'center', fontSize: 18 }}
                  autoFocus
                  inputMode="numeric"
                />
              </div>
              <button className="btn btn-primary" type="submit" disabled={working || code.length < 6}>
                {working ? 'Confirming…' : 'Enable 2FA'}
              </button>
              <button className="btn btn-secondary" type="button" onClick={reset}>Cancel</button>
            </form>
          </div>
        )}

        {/* ── BACKUP: show codes after enable/regen ─────────────────────────── */}
        {step === 'backup' && (
          <div>
            <div style={{ background: 'var(--color-success-bg)', border: '1px solid #bbf7d0', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
              <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 700, color: 'var(--color-success)', marginBottom: 8 }}>2FA enabled ✓</div>
              <p style={{ fontSize: 'var(--font-size-ui)', color: '#166534', marginBottom: 10 }}>
                Your backup codes are shown below. Save them — you won't see them again.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4, marginBottom: 10 }}>
                {backupCodes.map(c => (
                  <code key={c} style={{ fontSize: 'var(--font-size-ui)', background: 'var(--color-surface)', padding: '4px 8px', borderRadius: 4, border: '1px solid #bbf7d0', letterSpacing: '0.1em' }}>{c}</code>
                ))}
              </div>
              <button className="btn btn-secondary btn-sm" onClick={downloadBackupCodes}>⬇ Download codes</button>
            </div>
            <button className="btn btn-primary" onClick={reset}>Done</button>
          </div>
        )}

        {/* ── DISABLE: confirm with TOTP ─────────────────────────────────────── */}
        {step === 'disable' && (
          <div>
            <p style={{ fontSize: 'var(--font-size-data)', marginBottom: 14, color: 'var(--color-text-secondary)' }}>
              Enter your authenticator code (or a backup code) to disable 2FA.
            </p>
            <form onSubmit={confirmDisable} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <input
                  type="text"
                  className="form-control"
                  placeholder="Code"
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\s/g, ''))}
                  style={{ width: 160, letterSpacing: '0.15em', textAlign: 'center' }}
                  autoFocus
                />
              </div>
              <button className="btn btn-primary" type="submit" disabled={working || code.length < 6}
                style={{ background: 'var(--color-danger)', borderColor: 'var(--color-danger)' }}>
                {working ? 'Disabling…' : 'Disable 2FA'}
              </button>
              <button className="btn btn-secondary" type="button" onClick={reset}>Cancel</button>
            </form>
          </div>
        )}

        {/* ── REGEN: confirm with TOTP ──────────────────────────────────────── */}
        {step === 'regen' && (
          <div>
            <p style={{ fontSize: 'var(--font-size-data)', marginBottom: 14, color: 'var(--color-text-secondary)' }}>
              Enter your authenticator code to generate new backup codes (old ones will be invalidated).
            </p>
            <form onSubmit={confirmRegen} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <input
                  type="text"
                  className="form-control"
                  placeholder="000000"
                  value={code}
                  onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  maxLength={6}
                  style={{ width: 120, letterSpacing: '0.2em', textAlign: 'center', fontSize: 18 }}
                  autoFocus
                  inputMode="numeric"
                />
              </div>
              <button className="btn btn-primary" type="submit" disabled={working || code.length < 6}>
                {working ? 'Regenerating…' : 'Generate new codes'}
              </button>
              <button className="btn btn-secondary" type="button" onClick={reset}>Cancel</button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
