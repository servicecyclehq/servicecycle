// ─────────────────────────────────────────────────────────────────────────────
// ForgottenAssetsCard.jsx -- Phase 1 #2 "Forgotten / untracked assets" lens.
//
// Equipment that has fallen off the maintenance radar: assets on NO program
// (untracked) and assets on a program but not serviced in > N years / never
// serviced (forgotten). N is user-selectable (3 / 5 / 10 years).
//
// GET /api/compliance/forgotten-assets?siteId=&years= -> { summary, untrackedAssets, forgottenAssets }
// Props: { siteId?: string|null }
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { EyeOff } from 'lucide-react';
import api from '../api/client';

function AssetRow({ a, kind }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', padding: '7px 0', borderTop: '1px solid var(--color-border)' }}>
      <div style={{ flex: 1, minWidth: 200 }}>
        <Link to={`/assets/${a.assetId}`} style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text)' }}>
          {a.label}{a.siteName ? <span style={{ color: 'var(--color-text-secondary)' }}> · {a.siteName}</span> : ''}
        </Link>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{a.reason}</div>
      </div>
      {kind === 'forgotten' && (
        <span style={{ fontSize: 11, fontWeight: 700, color: a.neverServiced ? '#b91c1c' : '#b45309', flexShrink: 0 }}>
          {a.neverServiced ? 'never serviced' : `${a.daysSinceService}d ago`}
        </span>
      )}
      {kind === 'untracked' && a.criticalityScore != null && (
        <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', flexShrink: 0 }}>crit {a.criticalityScore}</span>
      )}
    </div>
  );
}

export default function ForgottenAssetsCard({ siteId = null }) {
  const [years, setYears] = useState(3);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams();
      if (siteId) params.set('siteId', siteId);
      params.set('years', String(years));
      const res = await api.get(`/api/compliance/forgotten-assets?${params.toString()}`);
      setData(res.data.data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load forgotten assets');
    } finally { setLoading(false); }
  }, [siteId, years]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--color-text-secondary)' }}>Loading forgotten-assets lens…</div></div>;
  if (error)   return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--chip-red-fg)' }}>{error}</div></div>;
  if (!data)   return null;

  const s = data.summary || {};
  const untracked = data.untrackedAssets || [];
  const forgotten = data.forgottenAssets || [];

  return (
    <div className="card mb-16">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <EyeOff size={18} />
        <div className="card-title" style={{ flex: 1 }}>Forgotten &amp; Untracked Assets</div>
        <select
          className="form-control"
          style={{ maxWidth: 150, height: 30, fontSize: 12 }}
          value={years}
          onChange={(e) => setYears(Number(e.target.value))}
          aria-label="Not-serviced threshold"
        >
          <option value={3}>Not serviced 3+ yrs</option>
          <option value={5}>Not serviced 5+ yrs</option>
          <option value={10}>Not serviced 10+ yrs</option>
        </select>
        {s.flagged > 0 && <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--chip-red-fg)' }}>{s.flagged} flagged</span>}
      </div>
      <div className="card-body">
        {s.clean ? (
          <div style={{ color: 'var(--chip-green-fg)', fontSize: 'var(--font-size-sm)' }}>
            Every in-service asset is on a maintenance program and has been serviced within {data.thresholdYears} years.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 10 }}>
              {s.untracked} on no program · {s.forgotten} not serviced in {data.thresholdYears}+ yrs{s.neverServiced > 0 ? ` (${s.neverServiced} never serviced)` : ''} · {s.totalAssets} assets in scope.
            </div>

            {untracked.length > 0 && (
              <div style={{ marginBottom: forgotten.length > 0 ? 14 : 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--chip-red-fg)', marginBottom: 2 }}>No maintenance program ({untracked.length})</div>
                {untracked.slice(0, 12).map((a) => <AssetRow key={a.assetId} a={a} kind="untracked" />)}
                {untracked.length > 12 && <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', paddingTop: 6 }}>+{untracked.length - 12} more</div>}
              </div>
            )}

            {forgotten.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--chip-amber-fg)', marginBottom: 2 }}>On a program but not serviced ({forgotten.length})</div>
                {forgotten.slice(0, 12).map((a) => <AssetRow key={a.assetId} a={a} kind="forgotten" />)}
                {forgotten.length > 12 && <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', paddingTop: 6 }}>+{forgotten.length - 12} more</div>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
