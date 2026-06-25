// ─────────────────────────────────────────────────────────────────────────────
// ChangeBriefCard.jsx — "What changed since last cycle".
//
// Per-site structured diff + short narrative of everything that moved since the
// previous compliance snapshot. Pairs with snapshots + the customer digest.
//
// Props: { siteId?: string|null }
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { History } from 'lucide-react';
import api from '../api/client';

function Stat({ label, value, accent }) {
  if (!value) return null;
  return (
    <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
      <strong style={{ color: accent || 'var(--color-text)' }}>{value}</strong> {label}
    </span>
  );
}

export default function ChangeBriefCard({ siteId = null }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get(`/api/compliance/change-brief${siteId ? `?siteId=${siteId}` : ''}`);
      setData(res.data.data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load change brief');
    } finally { setLoading(false); }
  }, [siteId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--color-text-secondary)' }}>Loading change brief…</div></div>;
  if (error)   return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--chip-red-fg)' }}>{error}</div></div>;
  if (!data)   return null;

  const t = data.totals;

  return (
    <div className="card mb-16">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <History size={18} />
        <div className="card-title" style={{ flex: 1 }}>What Changed Since Last Cycle</div>
      </div>
      <div className="card-body">
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text)', margin: '0 0 10px' }}>{data.narrative}</p>

        {!data.hasPrior ? null : (
          <>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12 }}>
              <Stat label="serviced" value={t.maintenanceCompleted} accent="#15803d" />
              <Stat label="deficiencies cleared" value={t.deficienciesResolved} accent="#15803d" />
              <Stat label="assets added" value={t.assetsAdded} accent="#1d4ed8" />
              <Stat label="assets removed" value={t.assetsRemoved} accent="#64748b" />
              <Stat label="went overdue" value={t.newlyOverdue} accent="#b91c1c" />
              <Stat label="new deficiencies" value={t.deficienciesOpened} accent="#b45309" />
              <Stat label="condition changes" value={t.conditionChanges} accent="#92400e" />
              <Stat label="program/interval changes" value={t.policyChanges} accent="#6d28d9" />
            </div>

            {data.bySite.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {data.bySite.map((s) => (
                  <div key={s.siteId || s.siteName} style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', paddingTop: 6, borderTop: '1px solid var(--color-border)' }}>
                    {s.narrative}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
