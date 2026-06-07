import { useState, useEffect } from 'react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import PasswordInput from '../components/PasswordInput';

const ROLE_LABELS = { admin: 'Admin', manager: 'Manager', viewer: 'Viewer', consultant: 'Consultant' };
const ROLE_COLORS = { admin: 'badge-cancelled', manager: 'badge-active', viewer: 'badge-under_review', consultant: 'badge-expired' };

function fmt(d) {
  if (!d) return 'Never';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Reset Password Modal ──────────────────────────────────────────────────────
function ResetPasswordModal({ user, onClose, onSuccess }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // v0.68.6 (audit Medium `Admin UX Reviewer`): fetch the live password
  // policy from /api/settings/public so the modal's min-length matches what
  // the server actually enforces. Pre-fix, the modal hard-coded 8 chars but
  // the server default is 12 (and admins can raise it further).
  const [minLen, setMinLen] = useState(12);
  useEffect(() => {
    api.get('/api/settings/public').then(r => {
      const n = r.data?.data?.passwordMinLength;
      if (typeof n === 'number' && n >= 4 && n <= 200) setMinLen(n);
    }).catch(() => { /* fallback to 12 */ });
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (password.length < minLen) { setError("Password must be at least " + minLen + " characters."); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setSaving(true); setError('');
    try {
      await api.put(`/api/users/${user.id}/reset-password`, { password });
      onSuccess();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to reset password.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" style={{ width: 400, maxWidth: '90vw' }}>
        <div className="card-header">
          <div className="card-title">Reset Password — {user.name}</div>
        </div>
        <div className="card-body">
          {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">New Password</label>
              <PasswordInput
                
                className="form-control"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoFocus
                placeholder="At least 8 characters"
              />
            </div>
            <div className="form-group">
              <label className="form-label">Confirm Password</label>
              <PasswordInput
                
                className="form-control"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="Re-enter new password"
              />
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Set Password'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ── Edit Role Modal ───────────────────────────────────────────────────────────
function EditUserModal({ user, onClose, onSaved }) {
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState(user.role);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      await api.put(`/api/users/${user.id}`, { name, role });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update user.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" style={{ width: 400, maxWidth: '90vw' }}>
        <div className="card-header">
          <div className="card-title">Edit User</div>
        </div>
        <div className="card-body">
          {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">Name</label>
              <input className="form-control" value={name} onChange={e => setName(e.target.value)} autoFocus />
            </div>
            <div className="form-group">
              <label className="form-label">Role</label>
              <select aria-label="User role" className="form-control" value={role} onChange={e => setRole(e.target.value)}>
                <option value="admin">Admin — full access including user management and settings</option>
                <option value="manager">Manager — create/edit assets, schedules, and contractors</option>
                <option value="viewer">Viewer — read-only access</option>
                <option value="consultant">Consultant — external read access, logged and revocable</option>
              </select>
            </div>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 16, padding: '8px 10px', background: 'var(--color-surface)', borderRadius: 'var(--radius)', border: '1px solid var(--color-border)' }}>
              <strong>Admin</strong> — manages users, resets passwords, and edits account settings.<br />
              <strong>Manager</strong> — creates and edits assets, maintenance schedules, and contractors.<br />
              <strong>Viewer</strong> — read-only. Cannot create or edit anything.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
              <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function UsersPage() {
  useDocumentTitle('Users');
  const { user: currentUser } = useAuth();
  const confirm = useConfirm();
  const navigate = useNavigate();

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [resetTarget, setResetTarget] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [toast, setToast] = useState('');

  // Invite form state
  const [form, setForm] = useState({ email: '', role: 'manager' });
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [inviteSent, setInviteSent] = useState('');

  // Redirect non-admins
  useEffect(() => {
    if (currentUser && currentUser.role !== 'admin') {
      navigate('/dashboard');
    }
  }, [currentUser]);

  const fetchUsers = () => {
    api.get('/api/users')
      .then(r => setUsers(r.data.data.users))
      .catch(() => setError('Failed to load users.'))
      .finally(() => setLoading(false));
  };

  useEffect(fetchUsers, []);

  function showToast(msg) {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }

  const setF = (k, v) => setForm(p => ({ ...p, [k]: v }));

  async function handleAddUser(e) {
    e.preventDefault();
    if (!form.email.trim()) { setFormError('Email is required.'); return; }
    setSaving(true); setFormError(''); setInviteSent('');
    try {
      await api.post('/api/users/invite', { email: form.email, role: form.role });
      setInviteSent(form.email);
      setForm({ email: '', role: 'manager' });
    } catch (err) {
      setFormError(err.response?.data?.error || 'Failed to send invite.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate(u) {
    if (!await confirm({
      title: 'Deactivate user',
      message: `Deactivate ${u.name}? They will no longer be able to log in.`,
      confirmLabel: 'Deactivate',
      danger: true,
    })) return;

    // Audit 6.4.6 — capture optional churn reason on deactivate so we
    // learn why users are leaving.
    // window.prompt is the right tool for a one-off optional text input.
    // Cancel returns null which we explicitly accept as "skipped".
    let reason = window.prompt(
      `Why is ${u.name} being deactivated? (Optional — helps us understand churn. Leave blank or hit Cancel to skip.)`,
      ''
    );
    if (reason !== null) reason = reason.trim().slice(0, 500);

    try {
      const body = {};
      if (reason) body.reason = reason;
      await api.put(`/api/users/${u.id}/deactivate`, body);
      fetchUsers();
      showToast(`${u.name} has been deactivated.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to deactivate user.');
    }
  }

  async function handleActivate(u) {
    try {
      await api.put(`/api/users/${u.id}/activate`);
      fetchUsers();
      showToast(`${u.name} has been reactivated.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to activate user.');
    }
  }

  // Pass-3 audit HIGH #2 (2026-05-17): GDPR Art. 17 erasure UI surface.
  // Server endpoint landed in W5, FK migration unblocked it in W10.
  // The deactivate path keeps the row + audit trail; this hard-erases
  // the user, anonymizing references (ActivityLog.userId -> null,
  // Communication.createdBy -> null) and removing the row itself.
  // Two-step confirmation: a window.confirm with the user's name AND
  // a typed confirmation of the email to prevent fat-finger accidents
  // on the row action.
  async function handleErase(u) {
    // v0.68.6 (audit Low): step 1 -- themed ConfirmDialog so users see the
    // same modal pattern as the rest of the app. Step 2 keeps window.prompt
    // for the email-typing confirmation because ConfirmDialog doesn't
    // support free-text input today (queued for a follow-up).
    if (!await confirm({
      title: 'Erase user (GDPR Article 17)',
      message: `Erasing ${u.name} (${u.email}) will: (1) delete their account and revoke all sessions, (2) anonymize their activity-log entries (userId nulled, email scrubbed), (3) anonymize communications they authored, (4) delete any early-access form submissions tied to their email. Assets and maintenance records they created remain. You will be asked to type the email address to confirm. This cannot be undone.`,
      confirmLabel: 'Proceed',
      danger: true,
    })) return;
    const typed = window.prompt(
      `Permanently erase ${u.name} (${u.email})?\n\n` +
      'GDPR Art. 17 erasure scope:\n  - Account deleted; all active sessions revoked\n  - Activity-log entries anonymized (userId removed, email scrubbed)\n  - Communications authored anonymized\n  - Early-access form submissions for this email deleted\n  - Assets and maintenance records remain (account-owned, not erased)\n\n' +
      `Type the email "${u.email}" below to confirm.`
    );
    if (typed == null) return; // cancelled
    if (typed.trim().toLowerCase() !== u.email.toLowerCase()) {
      setError('Email confirmation did not match. Erase cancelled.');
      return;
    }
    try {
      await api.delete(`/api/users/${u.id}`);
      fetchUsers();
      showToast(`${u.name} erased.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to erase user. See server logs.');
    }
  }

  async function handleToggleScope(u) {
    const newRestricted = !u.assetScopeRestricted;
    const action = newRestricted ? 'restrict' : 'expand';
    const msg = newRestricted
      ? `Restrict ${u.name} to their assigned sites? (Site-level scoping ships in a later release.)`
      : `Expand ${u.name}'s access to see all sites and assets?`;
    if (!await confirm({
      title: newRestricted ? 'Restrict access' : 'Expand access',
      message: msg,
      confirmLabel: newRestricted ? 'Restrict' : 'Expand',
      danger: newRestricted,
    })) return;
    try {
      await api.patch(`/api/users/${u.id}/scope-restriction`, { restricted: newRestricted });
      fetchUsers();
      showToast(`${u.name}'s access has been ${action}ed.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update access.');
    }
  }

  const activeUsers = users.filter(u => u.isActive);
  const inactiveUsers = users.filter(u => !u.isActive);

  return (
    <>
      {/* Toast */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, background: 'var(--color-success)', color: 'var(--color-surface)', padding: '10px 20px', borderRadius: 'var(--radius)', zIndex: 2000, fontSize: 'var(--font-size-data)', fontWeight: 500, boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
          ✓ {toast}
        </div>
      )}

      {/* Modals */}
      {resetTarget && (
        <ResetPasswordModal
          user={resetTarget}
          onClose={() => setResetTarget(null)}
          onSuccess={() => { setResetTarget(null); showToast('Password reset successfully.'); }}
        />
      )}
      {editTarget && (
        <EditUserModal
          user={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => { setEditTarget(null); fetchUsers(); showToast('User updated.'); }}
        />
      )}

      <div className="page-header">
        <div>
          <h1 className="page-title">Team Members</h1>
          <div className="page-subtitle">{activeUsers.length} active user{activeUsers.length !== 1 ? 's' : ''}</div>
        </div>
        <button className="btn btn-primary" onClick={() => { setShowAddForm(true); setInviteSent(''); setFormError(''); }}>
          + Invite User
        </button>
      </div>

      <div className="page-body">

        {/* Invite User Form */}
        {showAddForm && (
          <div className="card mb-16">
            <div className="card-header">
              <div className="card-title">Invite a Team Member</div>
            </div>
            <div className="card-body">
              {formError && <div role="alert" className="alert alert-error" style={{ marginBottom: 16 }}>{formError}</div>}
              {inviteSent && (
                <div className="alert alert-success" style={{ marginBottom: 16 }}>
                  ✓ Invite sent to <strong>{inviteSent}</strong> — they'll receive an email with a link to set up their account.
                </div>
              )}
              <form onSubmit={handleAddUser}>
                <div className="form-row form-row-2">
                  <div className="form-group">
                    <label className="form-label">Email Address <span className="required">*</span></label>
                    <input type="email" className="form-control" placeholder="jane@company.com" value={form.email} onChange={e => setF('email', e.target.value)} autoFocus />
                    <div className="form-hint">They'll receive an email invite to set their name and password.</div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Role <span className="required">*</span></label>
                    <select aria-label="New user role" className="form-control" value={form.role} onChange={e => setF('role', e.target.value)}>
                      <option value="admin">Admin</option>
                      <option value="manager">Manager</option>
                      <option value="viewer">Viewer</option>
                      <option value="consultant">Consultant</option>
                    </select>
                    <div className="form-hint" style={{ marginTop: 6 }}>
                      {form.role === 'admin' && <><strong>Admin</strong> — full access: manages users, resets passwords, and edits account settings.</>}
                      {form.role === 'manager' && <><strong>Manager</strong> — creates and edits assets, maintenance schedules, and contractors.</>}
                      {form.role === 'viewer' && <><strong>Viewer</strong> — read-only access. Cannot create or edit any records. New viewers start with restricted access to their assigned sites (site-level scoping ships in a later release). An admin can expand this from the Users page.</>}
                      {form.role === 'consultant' && <><strong>Consultant</strong> — external read access. Must be explicitly granted and can be revoked by an admin at any time from Settings. A consultant access record is automatically created when they accept the invite.</>}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Sending…' : 'Send Invite'}</button>
                  <button type="button" className="btn btn-secondary" onClick={() => { setShowAddForm(false); setFormError(''); setInviteSent(''); }}>Close</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        {/* Active Users */}
        <div className="card mb-16">
          {loading ? (
            <div className="loading">Loading users…</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Last Login</th>
                    <th style={{ width: 160 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {activeUsers.map(u => (
                    <tr key={u.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{u.name}</div>
                        {u.id === currentUser.id && (
                          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>You</div>
                        )}
                      </td>
                      <td className="td-muted">{u.email}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span className={`badge ${ROLE_COLORS[u.role]}`}>{ROLE_LABELS[u.role]}</span>
                          {u.role === 'viewer' && u.assetScopeRestricted && (
                            <span
                              title="Restricted to assigned sites (site-level scoping ships in a later release)"
                              style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'var(--color-warning-bg)', color: 'var(--color-warning)', border: '1px solid #fde68a', cursor: 'default' }}
                            >
                              Restricted
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="td-muted" style={{ fontSize: 'var(--font-size-ui)' }}>{fmt(u.lastLogin)}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                          {u.role === 'viewer' && (
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleToggleScope(u)}
                              title={u.assetScopeRestricted ? 'Expand access to all sites and assets' : 'Restrict to assigned sites (site-level scoping ships in a later release)'}
                            >
                              {u.assetScopeRestricted ? '🔓 Expand' : '🔒 Restrict'}
                            </button>
                          )}
                          <button className="btn btn-secondary btn-sm" onClick={() => setEditTarget(u)}>Edit</button>
                          <button className="btn btn-secondary btn-sm" onClick={() => setResetTarget(u)}>Reset PW</button>
                          {u.id !== currentUser.id && (
                            <button className="btn btn-danger btn-sm" onClick={() => handleDeactivate(u)}>Deactivate</button>
                          )}
                          {/* Pass-3 audit HIGH #2: GDPR Art. 17 erasure
                              action. Distinct from Deactivate — that just
                              flips isActive=false but keeps the row.
                              Erase deletes the row + anonymizes refs. */}
                          {u.id !== currentUser.id && (
                            <button className="btn btn-danger btn-sm" onClick={() => handleErase(u)} title="Permanently erase user (GDPR Art. 17)">Erase Data (GDPR)…</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Inactive Users */}
        {inactiveUsers.length > 0 && (
          <div className="card">
            <div className="card-header">
              <div className="card-title" style={{ color: 'var(--color-text-secondary)' }}>
                Deactivated Users ({inactiveUsers.length})
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {inactiveUsers.map(u => (
                    <tr key={u.id} style={{ opacity: 0.6 }}>
                      <td style={{ fontWeight: 600 }}>{u.name}</td>
                      <td className="td-muted">{u.email}</td>
                      <td><span className={`badge ${ROLE_COLORS[u.role]}`}>{ROLE_LABELS[u.role]}</span></td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => handleActivate(u)}>
                          Reactivate
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
