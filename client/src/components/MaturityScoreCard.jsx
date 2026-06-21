// ─────────────────────────────────────────────────────────────────────────────
// MaturityScoreCard.jsx — B1 "NFPA 70B program maturity".
//
// Reframes the compliance/Path-to-100 numbers into a single 0-100 maturity score
// measured against what NFPA 70B REQUIRES (never against other facilities): a
// 1-5 level, a per-dimension breakdown (coverage / on-time / baselining / EMP),
// the single biggest lever, and how many points to the next level.
//
// Bold redesign: the score is shown as a circular progress ring (data-viz) rather
// than a plain number, paired with the level + biggest lever.
//
// Customer-facing. Props: { siteId?: string|null, compact?: bool }
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { Gauge, TrendingUp } from 'lucide-react';
import api from '../api/client';

const LEVEL_COLOR = {
  1: '#b91c1c', // Reactive
  2: '#c2410c', // Developing
  3: '#92400e', // Defined
  4: '#1d4ed8', // Managed
  5: '#15803d', // Audit-Ready
};

function scoreColor(score) {
  if (score >= 95) return '#15803d';
  if (score >= 80) return '#1d4ed8';
  if (score >= 60) return '#92400e';
  if (score >= 40) return '#c2410c';
  return '#b91c1c';
}

// Circular progress ring for the 0-100 maturity score.
function MaturityRing({ score }) {
  const r = 58;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, Number(score) || 0));
  const off = c * (1 - pct / 100);
  const col = scoreColor(score);
  return (
    <div style={{ position: 'relative', width: 132, height: 132, flexShrink: 0 }}>
      <svg className="sc-ring" width="132" height="132" viewBox="0 0 132 132" fill="none" aria-hidden="true">
        <circle cx="66" cy="66" r={r} stroke="var(--sc-surface-2)" strokeWidth="12" />
        <circle className="sc-ring-fill" cx="66" cy="66" r={r} stroke={col} strokeWidth="12"
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off} />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: 34, fontWeight: 800, lineHeight: 1, color: col }}>{score}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)' }}>/ 100</span>
      </div>
    </div>
  );
}

function DimensionBar({ dim }) {
  const has = dim.subScore !== null && dim.subScore !== undefined;
  const pct = has ? Math.max(0, Math.min(100, dim.subScore)) : 0;
  const barColor = !has ? 'var(--color-border)' : scoreColor(dim.subScore);
  return (
    <div style={{ padding: '7px 0', borderTop: '1px solid var(--color-border)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-text)' }}>{dim.label}</span>
        <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }} title={dim.standardRef}>{dim.standardRef} ⓘ</span>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-sm)', fontWeight: 700, color: barColor }}>
          {has ? `${dim.subScore}` : '—'}
          {dim.pointsLost > 0 && (
            <span style={{ fontSize: 11, fontWeight: 600, color: '#b91c1c', marginLeft: 6 }}>−{dim.pointsLost} pts</span>
          )}
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 4, background: 'var(--sc-surface-2, #f1f5f9)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: barColor, transition: 'width .3s' }} />
      </div>
    </div>
  );
}

export default function MaturityScoreCard({ siteId = null, compact = false }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get(`/api/compliance/maturity${siteId ? `?siteId=${siteId}` : ''}`);
      setData(res.data.data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load maturity score');
    } finally { setLoading(false); }
  }, [siteId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--color-text-secondary)' }}>Loading program maturity…</div></div>;
  if (error)   return <div className="card mb-16"><div className="card-body" style={{ color: '#b91c1c' }}>{error}</div></div>;
  if (!data)   return null;

  const lvlColor = LEVEL_COLOR[data.level] || 'var(--color-text)';

  return (
    <div className="card mb-16">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Gauge size={18} />
        <div className="card-title" style={{ flex: 1 }}>NFPA 70B Program Maturity</div>
        <span title={data.disclaimer} style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.03em', textTransform: 'uppercase', color: 'var(--color-text-secondary)', cursor: 'help' }}>
          vs the standard ⓘ
        </span>
      </div>
      <div className="card-body">
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap', marginBottom: 14 }}>
          <MaturityRing score={data.score} />
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 700, padding: '4px 11px', borderRadius: 20, background: lvlColor, color: '#fff' }}>
                Level {data.level} of 5 · {data.levelLabel}
              </span>
              {data.nextLevel && (
                <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <TrendingUp size={14} /> {data.nextLevel.pointsToNext} pts to <strong style={{ color: 'var(--color-text)' }}>{data.nextLevel.label}</strong>
                </span>
              )}
            </div>
            <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', margin: '0 0 8px' }}>{data.levelBlurb}</p>
            {data.biggestLever && (
              <p style={{ fontSize: 'var(--font-size-sm)', margin: 0, color: 'var(--color-text)' }}>
                Biggest lever: <strong>{data.biggestLever.label}</strong> (recovers {data.biggestLever.pointsLost} pts).
              </p>
            )}
          </div>
        </div>

        {!compact && (
          <div style={{ marginTop: 6 }}>
            {(data.dimensions || []).map((dim) => <DimensionBar key={dim.key} dim={dim} />)}
          </div>
        )}
      </div>
    </div>
  );
}
