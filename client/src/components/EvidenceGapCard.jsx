// ─────────────────────────────────────────────────────────────────────────────
// EvidenceGapCard.jsx — #2 evidence-to-requirement gap roll-up.
//
// How much of the 70B program is backed by documented test evidence, which test
// types are most under-evidenced, and which assets have the biggest gaps (the
// contractor's upsell list / the customer's audit exposure).
//
// Props: { siteId?: string|null }
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardCheck } from 'lucide-react';
import api from '../api/client';

function pctColor(p) {
  if (p >= 90) return 'var(--chip-green-fg)';
  if (p >= 70) return 'var(--chip-amber-fg)';
  return 'var(--chip-red-fg)';
}

export default function EvidenceGapCard({ siteId = null }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 2026-07-13 fix: both lists below silently truncated with no "+N more"
  // indicator at all -- Dustin's live-review call ("data needs to be SIMPLE
  // to get to"). byRequirementType is unbounded from the server; topAssets
  // is capped at 25 server-side (evidenceTrace.ts) regardless of this toggle.
  const [showAllTypes, setShowAllTypes] = useState(false);
  const [showAllAssets, setShowAllAssets] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get(`/api/compliance/evidence-gaps${siteId ? `?siteId=${siteId}` : ''}`);
      setData(res.data.data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load evidence gaps');
    } finally { setLoading(false); }
  }, [siteId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--color-text-secondary)' }}>Loading evidence gaps…</div></div>;
  if (error)   return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--chip-red-fg)' }}>{error}</div></div>;
  if (!data)   return null;

  const t = data.totals;

  return (
    <div className="card mb-16">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <ClipboardCheck size={18} />
        <div className="card-title" style={{ flex: 1 }}>Evidence Coverage (70B requirements)</div>
        <span title="Share of program requirements backed by a documented, on-file test record." style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', cursor: 'help' }}>
          <span style={{ fontSize: 22, fontWeight: 800, lineHeight: 1, color: pctColor(data.documentedPct) }}>{data.documentedPct}%</span>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--color-text-secondary)' }}>documented ⓘ</span>
        </span>
      </div>
      <div className="card-body">
        {t.requirements === 0 ? (
          <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>No 70B task requirements tracked yet.</div>
        ) : (
          <>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text)', marginBottom: 12 }}>
              {t.gapTotal === 0
                ? <span style={{ color: 'var(--chip-green-fg)', fontWeight: 700 }}>Every requirement has documented evidence on file.</span>
                : <>
                    <strong>{t.gapTotal}</strong> of {t.requirements} requirements lack documented evidence:
                    {' '}<strong style={{ color: 'var(--chip-red-fg)' }}>{t.missing}</strong> missing,
                    {' '}<strong style={{ color: 'var(--chip-amber-fg)' }}>{t.undocumented}</strong> undocumented (claimed, no test on file),
                    {' '}<strong style={{ color: 'var(--chip-amber-fg)' }}>{t.stale}</strong> stale (overdue).
                  </>}
            </div>

            {data.byRequirementType.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--color-text-secondary)', marginBottom: 4 }}>Most under-evidenced tests</div>
                {(showAllTypes ? data.byRequirementType : data.byRequirementType.slice(0, 6)).map((r) => (
                  <div key={r.taskCode} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--font-size-sm)', padding: '3px 0' }}>
                    <span>{r.taskName}</span>
                    <span style={{ color: 'var(--chip-red-fg)', fontWeight: 600 }}>{r.gaps} gap{r.gaps === 1 ? '' : 's'}</span>
                  </div>
                ))}
                {data.byRequirementType.length > 6 && (
                  <button
                    type="button"
                    onClick={() => setShowAllTypes(v => !v)}
                    style={{ background: 'none', border: 'none', padding: '4px 0 0', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--color-primary)' }}
                  >
                    {showAllTypes ? 'Show fewer' : `Show all ${data.byRequirementType.length} →`}
                  </button>
                )}
              </div>
            )}

            {data.topAssets.length > 0 && (
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'var(--color-text-secondary)', marginBottom: 4 }}>Assets with the biggest gaps</div>
                {(showAllAssets ? data.topAssets : data.topAssets.slice(0, 8)).map((a) => (
                  <div key={a.assetId} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 'var(--font-size-sm)', padding: '4px 0', borderTop: '1px solid var(--color-border)' }}>
                    <Link to={`/assets/${a.assetId}`} style={{ color: 'var(--color-text)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {a.assetLabel}{a.siteName ? <span style={{ color: 'var(--color-text-secondary)' }}> · {a.siteName}</span> : ''}
                    </Link>
                    <span style={{ color: 'var(--chip-red-fg)', fontWeight: 600, whiteSpace: 'nowrap' }}>{a.gaps}/{a.requirements}</span>
                  </div>
                ))}
                {data.topAssets.length > 8 && (
                  <button
                    type="button"
                    onClick={() => setShowAllAssets(v => !v)}
                    style={{ background: 'none', border: 'none', padding: '4px 0 0', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: 'var(--color-primary)' }}
                  >
                    {showAllAssets ? 'Show fewer' : `Show top ${data.topAssets.length} →`}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
