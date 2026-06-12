// ─────────────────────────────────────────────────────────────────────────────
// IncidentLogCard.jsx — #24 protective-device / incident log (NFPA 70B element 9).
//
// Quick-log breaker trips, relay operations, and alarms against an asset, with a
// resolve/reopen toggle. An open (unresolved) incident is a C2/C3 condition
// input per §9.3.1 and feeds the EMP's incident-feedback section.
//
// Props: { assetId: string, compact?: bool }
// Endpoints: GET/POST /api/assets/:id/incidents, PATCH /api/assets/:id/incidents/:incidentId
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';

const TYPE_LABELS = {
  PROTECTIVE_TRIP: 'Breaker / device tripped',
  RELAY_OPERATION: 'Relay operated',
  ALARM:           'Alarm',
  ARC_FLASH_EVENT: 'Arc-flash event',
  OTHER:           'Other',
};
const TYPE_ORDER = ['PROTECTIVE_TRIP', 'RELAY_OPERATION', 'ALARM', 'ARC_FLASH_EVENT', 'OTHER'];

function fmt(d) {
  if (!d) return '';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '' : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function IncidentLogCard({ assetId, compact = false }) {
  const { role } = useAuth();
  const canWrite = ['admin', 'manager'].includes(role);

  const [incidents, setIncidents] = useState([]);
  const [openCount, setOpenCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState('PROTECTIVE_TRIP');
  const [occurredAt, setOccurredAt] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get(`/api/assets/${assetId}/incidents`);
      setIncidents(res.data?.data?.incidents || []);
      setOpenCount(res.data?.data?.openCount || 0);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load incidents');
    } finally { setLoading(false); }
  }, [assetId]);

  useEffect(() => { load(); }, [load]);

  async function addIncident() {
    setSaving(true);
    try {
      await api.post(`/api/assets/${assetId}/incidents`, { type, occurredAt, note: note.trim() || undefined });
      setShowForm(false); setNote(''); setType('PROTECTIVE_TRIP'); setOccurredAt(new Date().toISOString().slice(0, 10));
      await load();
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to log incident');
    } finally { setSaving(false); }
  }

  async function toggleResolved(inc) {
    setBusyId(inc.id);
    try {
      await api.patch(`/api/assets/${assetId}/incidents/${inc.id}`, { resolved: !inc.resolvedAt });
      await load();
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to update incident');
    } finally { setBusyId(null); }
  }

  return (
    <div className="card mb-16">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div className="card-title" style={{ flex: 1 }}>Incidents &amp; protective-device operations</div>
        {openCount > 0 && (
          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: '#fff1f1', color: '#b91c1c' }}>
            {openCount} open
          </span>
        )}
        {canWrite && (
          <button className="btn btn-secondary btn-sm" onClick={() => setShowForm((s) => !s)}>
            {showForm ? 'Cancel' : '+ Log incident'}
          </button>
        )}
      </div>
      <div className="card-body">
        {error && <div style={{ color: '#b91c1c', fontSize: 'var(--font-size-sm)', marginBottom: 8 }}>{error}</div>}

        {showForm && canWrite && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--color-border)' }}>
            <div>
              <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>What happened</label>
              <select className="input" value={type} onChange={(e) => setType(e.target.value)} style={{ minWidth: 200 }}>
                {TYPE_ORDER.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>When</label>
              <input type="date" className="input" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} style={{ width: 160 }} />
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>Note (optional)</label>
              <input type="text" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. tripped on overcurrent, reset and back in service" style={{ width: '100%' }} />
            </div>
            <button className="btn btn-primary btn-sm" disabled={saving} onClick={addIncident}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        )}

        {loading ? (
          <div style={{ color: 'var(--color-text-secondary)' }}>Loading…</div>
        ) : incidents.length === 0 ? (
          <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
            No incidents logged. Log trips, relay operations, and alarms here — they feed the condition assessment and EMP.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {(compact ? incidents.slice(0, 5) : incidents).map((inc) => (
              <div key={inc.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--color-border)' }}>
                <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 10, whiteSpace: 'nowrap',
                  background: inc.resolvedAt ? '#f1f5f9' : '#fff1f1', color: inc.resolvedAt ? '#64748b' : '#b91c1c' }}>
                  {inc.resolvedAt ? 'Resolved' : 'Open'}
                </span>
                <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>{TYPE_LABELS[inc.type] || inc.type}</span>
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{fmt(inc.occurredAt)}</span>
                {inc.note && <span style={{ flex: 1, minWidth: 160, fontSize: 'var(--font-size-sm)' }}>{inc.note}</span>}
                {canWrite && (
                  <button className="btn btn-secondary btn-sm" disabled={busyId === inc.id} onClick={() => toggleResolved(inc)}>
                    {busyId === inc.id ? '…' : (inc.resolvedAt ? 'Reopen' : 'Mark resolved')}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
