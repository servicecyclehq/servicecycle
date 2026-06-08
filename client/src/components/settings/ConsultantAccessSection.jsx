import React, { useState, useEffect, useCallback } from 'react';
import { useConfirm } from '../../context/ConfirmContext';
import api from '../../api/client';

import { sectionHeading, sectionDesc, btnSecondary } from './sharedStyles';

// ── Consultant Access Section ─────────────────────────────────────────────────

export default function ConsultantAccessSection() {
  const confirm = useConfirm();
  const [records, setRecords]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [revoking, setRevoking]   = useState(null);
  const [restoring, setRestoring] = useState(null);
  const [err, setErr]             = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api.get('/api/consultant-access')
      .then(r => setRecords(r.data.data?.records || []))
      .catch(() => setErr('Failed to load consultant access records'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function revoke(id) {
    if (!await confirm({
      title: 'Revoke consultant access',
      message: 'Revoke this consultant\'s access? Their account will be deactivated on this tenant.',
      confirmLabel: 'Revoke',
      danger: true,
    })) return;
    setRevoking(id);
    try {
      await api.delete(`/api/consultant-access/${id}`);
      load();
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to revoke access');
    } finally {
      setRevoking(null);
    }
  }

  async function restore(id) {
    setRestoring(id);
    try {
      await api.post(`/api/consultant-access/${id}/restore`);
      load();
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to restore access');
    } finally {
      setRestoring(null);
    }
  }

  const active  = records.filter(r => r.isActive);
  const revoked = records.filter(r => !r.isActive);

  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  return (
    <section style={{ marginTop: '2.5rem', paddingTop: '2rem', borderTop: '1px solid var(--color-border)' }}>
      <h2 className={sectionHeading}>Consultant Access</h2>
      <p className={sectionDesc}>
        Consultants are external users who have been explicitly invited to this account with the Consultant role.
        Access is not granted by default and can be revoked at any time. All actions are logged.
        To add a consultant, invite them via <strong>Team Members</strong> using the Consultant role.
      </p>

      {err && <div style={{ color: 'var(--color-danger)', fontSize: '0.825rem', marginBottom: '0.75rem' }}>{err}</div>}

      {loading ? (
        <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>Loading…</div>
      ) : records.length === 0 ? (
        <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem', padding: '0.75rem 0' }}>
          No consultant access has been granted on this account.
        </div>
      ) : (
        <>
          {active.length > 0 && (
            <div style={{ marginBottom: '1.25rem' }}>
              <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
                Active ({active.length})
              </div>
              {active.map(r => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, marginBottom: 8 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--color-text)' }}>
                      {r.consultant.name}
                      <span style={{ marginLeft: 8, fontSize: '0.75rem', color: 'var(--color-text-secondary)', fontWeight: 400 }}>{r.consultant.email}</span>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                      Granted by {r.grantedBy.name} · {fmtDate(r.grantedAt)}
                      {r.notes && <span style={{ marginLeft: 8, fontStyle: 'italic' }}>"{r.notes}"</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => revoke(r.id)}
                    disabled={revoking === r.id}
                    className={btnSecondary} style={{ color: 'var(--color-danger)', borderColor: 'var(--color-danger)', fontSize: '0.8rem', padding: '0.35rem 0.75rem' }}
                  >
                    {revoking === r.id ? 'Revoking…' : 'Revoke'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {revoked.length > 0 && (
            <div>
              <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
                Revoked History ({revoked.length})
              </div>
              {revoked.map(r => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, marginBottom: 8, opacity: 0.7 }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--color-text)' }}>
                      {r.consultant.name}
                      <span style={{ marginLeft: 8, fontSize: '0.75rem', color: 'var(--color-text-secondary)', fontWeight: 400 }}>{r.consultant.email}</span>
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                      Granted {fmtDate(r.grantedAt)} · Revoked by {r.revokedBy?.name || '—'} on {fmtDate(r.revokedAt)}
                    </div>
                  </div>
                  <button
                    onClick={() => restore(r.id)}
                    disabled={restoring === r.id}
                    className={btnSecondary} style={{ fontSize: '0.8rem', padding: '0.35rem 0.75rem' }}
                  >
                    {restoring === r.id ? 'Restoring…' : 'Restore Access'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
