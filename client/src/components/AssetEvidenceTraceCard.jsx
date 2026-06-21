// ─────────────────────────────────────────────────────────────────────────────
// AssetEvidenceTraceCard.jsx — #2 per-asset requirement → evidence trace.
//
// For one asset: each 70B task requirement and the documented evidence that
// satisfies it (decal, as-left, measurements, instrument provenance), with
// missing/undocumented/stale gaps flagged. Audit-time proof for the customer;
// upsell list for the contractor.
//
// Props: { assetId: string }
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { ClipboardCheck } from 'lucide-react';
import api from '../api/client';
import { fmtDate } from '../lib/equipment';

const STATUS_META = {
  documented:   { bg: '#dcfce7', color: 'var(--chip-green-fg)', label: 'Documented' },
  stale:        { bg: 'var(--chip-amber-bg)', color: 'var(--chip-amber-fg)', label: 'Stale (overdue)' },
  undocumented: { bg: 'var(--chip-amber-bg)', color: 'var(--chip-amber-fg)', label: 'No record on file' },
  missing:      { bg: 'var(--chip-red-bg)', color: 'var(--chip-red-fg)', label: 'Missing' },
};

export default function AssetEvidenceTraceCard({ assetId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!assetId) return;
    setLoading(true); setError('');
    try {
      const res = await api.get(`/api/compliance/asset-evidence/${assetId}`);
      setData(res.data.data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load evidence trace');
    } finally { setLoading(false); }
  }, [assetId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return null;
  if (error)   return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--chip-red-fg)' }}>{error}</div></div>;
  if (!data || data.summary.requirements === 0) return null;

  const s = data.summary;

  return (
    <div className="card mb-16">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <ClipboardCheck size={18} />
        <div className="card-title" style={{ flex: 1 }}>70B Evidence Trace</div>
        <span style={{ fontSize: 'var(--font-size-sm)', color: s.gapTotal === 0 ? '#15803d' : '#b91c1c', fontWeight: 700 }}>
          {s.documented}/{s.requirements} documented
        </span>
      </div>
      <div className="card-body">
        {s.gapTotal === 0 ? (
          <div style={{ color: 'var(--chip-green-fg)', fontSize: 'var(--font-size-sm)', marginBottom: 8 }}>Every requirement on this asset has documented evidence on file.</div>
        ) : (
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            {s.missing} missing · {s.undocumented} no record on file · {s.stale} stale.
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {data.requirements.map((r) => {
            const m = STATUS_META[r.evidenceStatus] || STATUS_META.missing;
            const ev = r.evidence;
            return (
              <div key={r.scheduleId} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--color-border)' }}>
                <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 10, background: m.bg, color: m.color, whiteSpace: 'nowrap' }}>{m.label}</span>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text)' }}>
                    {r.taskName}{r.standardRef ? <span style={{ color: 'var(--color-text-secondary)', fontSize: 11 }}> · {r.standardRef}</span> : ''}
                  </div>
                  {ev ? (
                    <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                      Last test {fmtDate(ev.completedDate)}
                      {ev.netaDecal ? ` · ${ev.netaDecal}` : ''}
                      {ev.measurementCount > 0 ? ` · ${ev.measurementCount} measurement${ev.measurementCount === 1 ? '' : 's'}` : ' · no measurements'}
                      {ev.hasInstrumentProvenance ? ' · instruments logged' : ''}
                      {ev.reportOnFile ? ' · report on file' : ''}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                      {r.evidenceStatus === 'undocumented'
                        ? `Marked done ${fmtDate(r.lastCompletedDate)} but no work order / test record on file.`
                        : 'No completed work order or test on record.'}
                    </div>
                  )}
                </div>
                {r.overdue && <span style={{ fontSize: 11, color: 'var(--chip-red-fg)', whiteSpace: 'nowrap' }}>{r.daysOverdue}d overdue</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
