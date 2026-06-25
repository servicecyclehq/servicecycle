// ─────────────────────────────────────────────────────────────────────────────
// AccessBlockerCard.jsx — Missing-access / open-items blocker log (stretch).
//
// Customer-owned log of assets that couldn't be fully inspected (locked door,
// outage needed, missing label, access limit), each tied to a compliance impact
// (how many scheduled tasks are blocked). Keeps the contractor blameless and the
// deal moving — the customer clears the blocker.
//
// Props: { assetId?: string|null }  — when set, scopes + pre-fills new blockers.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { DoorClosed } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import Toast from './Toast';

const KIND_LABEL = {
  LOCKED_DOOR: 'Locked door',
  OUTAGE_NEEDED: 'Outage needed',
  MISSING_LABEL: 'Missing label',
  ACCESS_LIMIT: 'Access limit',
  OTHER: 'Other',
};

export default function AccessBlockerCard({ assetId = null }) {
  const { role } = useAuth();
  const canDelete = ['admin', 'manager'].includes(role);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ kind: 'LOCKED_DOOR', description: '' });
  const [busy, setBusy] = useState(false);

  const qs = assetId ? `?assetId=${assetId}` : '';

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get(`/api/access-blockers${qs}`);
      setData(res.data.data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load blockers');
    } finally { setLoading(false); }
  }, [qs]);

  useEffect(() => { load(); }, [load]);

  async function createBlocker() {
    setBusy(true);
    try {
      await api.post('/api/access-blockers', { kind: form.kind, description: form.description || null, assetId: assetId || null });
      setForm({ kind: 'LOCKED_DOOR', description: '' });
      setAdding(false);
      setToast({ message: 'Blocker logged', type: 'success' });
      await load();
    } catch (e) {
      setToast({ message: e?.response?.data?.error || 'Failed to log blocker', type: 'error' });
    } finally { setBusy(false); }
  }

  async function setStatus(b, status) {
    try {
      await api.patch(`/api/access-blockers/${b.id}`, { status });
      await load();
    } catch (e) {
      setToast({ message: e?.response?.data?.error || 'Update failed', type: 'error' });
    }
  }

  if (loading) return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--color-text-secondary)' }}>Loading blockers…</div></div>;
  if (error)   return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--chip-red-fg)' }}>{error}</div></div>;
  if (!data)   return null;

  const blockers = data.blockers || [];

  return (
    <div className="card mb-16">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <DoorClosed size={18} />
        <div className="card-title" style={{ flex: 1 }}>Access &amp; Open-Items Blockers{data.openCount ? ` (${data.openCount} open)` : ''}</div>
        <button className="btn btn-secondary btn-sm" onClick={() => setAdding((v) => !v)}>{adding ? 'Cancel' : 'Log blocker'}</button>
      </div>
      <div className="card-body">
        {adding && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12, padding: 10, border: '1px solid var(--color-border)', borderRadius: 8 }}>
            <select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))} style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--color-border)' }}>
              {Object.entries(KIND_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            <input
              placeholder="What's blocking access? (optional)"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              style={{ flex: 1, minWidth: 200, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--color-border)' }}
            />
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={createBlocker}>{busy ? '…' : 'Add'}</button>
          </div>
        )}

        {blockers.length === 0 ? (
          <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>No access blockers logged. Everything is reachable.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {blockers.map((b) => (
              <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--color-border)', opacity: b.status === 'resolved' ? 0.6 : 1 }}>
                <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 10, background: b.status === 'resolved' ? '#dcfce7' : '#fef3c7', color: b.status === 'resolved' ? '#15803d' : '#92400e', whiteSpace: 'nowrap' }}>
                  {KIND_LABEL[b.kind] || b.kind}
                </span>
                <div style={{ flex: 1, minWidth: 200, fontSize: 'var(--font-size-sm)' }}>
                  {b.assetLabel && <strong>{b.assetLabel}</strong>}
                  {b.assetLabel && b.description ? ' — ' : ''}
                  {b.description || (!b.assetLabel ? '(no detail)' : '')}
                  {b.siteName && <span style={{ color: 'var(--color-text-secondary)' }}> · {b.siteName}</span>}
                  {b.blockedSchedules > 0 && (
                    <span style={{ color: 'var(--chip-amber-fg)', fontSize: 11 }}> · blocks {b.blockedSchedules} task{b.blockedSchedules === 1 ? '' : 's'}</span>
                  )}
                </div>
                {b.status === 'open'
                  ? <button className="btn btn-secondary btn-sm" onClick={() => setStatus(b, 'resolved')}>Mark resolved</button>
                  : <button className="btn btn-secondary btn-sm" onClick={() => setStatus(b, 'open')}>Reopen</button>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
