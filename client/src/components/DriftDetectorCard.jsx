// ─────────────────────────────────────────────────────────────────────────────
// DriftDetectorCard.jsx — #4 repeat-failure / compliance-drift detector.
//
// Assets drifting out of tolerance across cycles, inspected-but-not-corrected,
// or repeatedly failing — each with a recommended PROGRAM change (shorten
// interval / close corrective / review procedure), not just another ticket.
//
// Props: { siteId?: string|null }
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Activity } from 'lucide-react';
import api from '../api/client';

const TYPE_META = {
  worsening_trend:     { color: 'var(--chip-red-fg)',   label: 'Worsening trend' },
  unclosed_corrective: { color: 'var(--chip-amber-fg)', label: 'Unclosed corrective' },
  repeat_failure:      { color: 'var(--chip-slate-fg)', label: 'Repeat failure' },
};

export default function DriftDetectorCard({ siteId = null }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get(`/api/compliance/drift${siteId ? `?siteId=${siteId}` : ''}`);
      setData(res.data.data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load drift report');
    } finally { setLoading(false); }
  }, [siteId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--color-text-secondary)' }}>Loading drift detector…</div></div>;
  if (error)   return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--chip-red-fg)' }}>{error}</div></div>;
  if (!data)   return null;

  const s = data.summary;

  return (
    <div className="card mb-16">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Activity size={18} />
        <div className="card-title" style={{ flex: 1 }}>Compliance Drift &amp; Repeat Failures</div>
        {s.flagged > 0 && <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: '#b91c1c' }}>{s.flagged} flagged</span>}
      </div>
      <div className="card-body">
        {s.flagged === 0 ? (
          <div style={{ color: 'var(--chip-green-fg)', fontSize: 'var(--font-size-sm)' }}>No drift or repeat-failure patterns detected over the last {Math.round(data.windowDays / 30)} months.</div>
        ) : (
          <>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 10 }}>
              {s.worseningTrend} worsening trend · {s.unclosedCorrective} unclosed corrective · {s.repeatFailure} repeat failure — each with a recommended program change, not just a new ticket.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {data.findings.slice(0, 15).map((f) => {
                const m = TYPE_META[f.driftType] || TYPE_META.repeat_failure;
                return (
                  <div key={f.assetId} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', padding: '8px 0', borderTop: '1px solid var(--color-border)' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: m.color, minWidth: 130 }}>{m.label}</span>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <Link to={`/assets/${f.assetId}`} style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text)' }}>
                        {f.assetLabel}{f.siteName ? <span style={{ color: 'var(--color-text-secondary)' }}> · {f.siteName}</span> : ''}
                      </Link>
                      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{f.recommendationText}</div>
                      <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                        {f.openDeficiencies} open{f.trendingDeficiencies > 0 ? ` · ${f.trendingDeficiencies} trending` : ''}{f.oldestOpenAgeDays > 0 ? ` · oldest ${f.oldestOpenAgeDays}d` : ''}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
