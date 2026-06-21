// ─────────────────────────────────────────────────────────────────────────────
// DashboardTrends.jsx — bold-redesign KPI trend strip (Option G: full-bleed
// area chart + trend-delta badge — "enterprise-grade bold").
//
// Real trend lines only (no fabricated client data): GET /api/dashboard/trends
// aggregates COMPLETE work orders into monthly "completed" + "on-time %" series.
// Renders nothing until history exists, so it's inert on a fresh demo and only
// lights up once the seeded 5-year history (or real completions) exist.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import api from '../api/client';

// Carry forward (then back-fill leading) nulls so the line is continuous over
// every month even when a month had no completions to compute on-time from.
function fillNulls(arr) {
  const out = arr.slice();
  let last = null;
  for (let i = 0; i < out.length; i++) { if (out[i] != null) last = out[i]; else out[i] = last; }
  const firstNonNull = out.find((v) => v != null);
  for (let i = 0; i < out.length; i++) { if (out[i] == null) out[i] = firstNonNull ?? 0; }
  return out;
}

function TrendCard({ label, value, deltaText, deltaUp, values, color, gradId }) {
  const W = 320, H = 62, pad = 5;
  const mn = Math.min(...values), mx = Math.max(...values), range = (mx - mn) || 1;
  const pts = values.map((x, i) => ({
    x: pad + (i * (W - 2 * pad)) / (values.length - 1),
    y: H - pad - ((x - mn) / range) * (H - 2 * pad),
  }));
  const line = 'M' + pts.map((q) => `${q.x.toFixed(1)} ${q.y.toFixed(1)}`).join(' L ');
  const area = `${line} L ${pts[pts.length - 1].x.toFixed(1)} ${H} L ${pts[0].x.toFixed(1)} ${H} Z`;
  const last = pts[pts.length - 1];
  const dc = deltaUp ? 'var(--color-success, #16a34a)' : 'var(--color-danger, #dc2626)';

  return (
    <div className="card stat-tile" style={{ position: 'relative', overflow: 'hidden', minHeight: 124, padding: '18px 20px' }}>
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <div className="stat-tile-label">{label}</div>
          <div className="stat-tile-value">{value}</div>
        </div>
        {deltaText && (
          <span style={{ fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 3, color: dc, background: `color-mix(in srgb, ${dc} 13%, transparent)`, padding: '3px 10px', borderRadius: 999, whiteSpace: 'nowrap' }}>
            {deltaUp ? '▲' : '▼'} {deltaText}
          </span>
        )}
      </div>
      <div style={{ position: 'relative', zIndex: 1, fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>last 24 months</div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 62, pointerEvents: 'none' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="62" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.30" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradId})`} />
          <path d={line} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={last.x.toFixed(1)} cy={last.y.toFixed(1)} r="3.4" fill={color} />
        </svg>
      </div>
    </div>
  );
}

export default function DashboardTrends() {
  const [series, setSeries] = useState(null);

  useEffect(() => {
    api.get('/api/dashboard/trends?months=24')
      .then((r) => setSeries(r.data?.data?.series || []))
      .catch(() => setSeries([]));
  }, []);

  if (!series || series.length < 2) return null;

  const completed = series.map((s) => s.completed);
  const totalCompleted = completed.reduce((a, b) => a + (b || 0), 0);
  if (totalCompleted === 0) return null; // no history yet — stay inert

  const onTime = fillNulls(series.map((s) => s.onTimeRate));

  const cFirst = completed.find((x) => x > 0) ?? 0;
  const cLast = completed[completed.length - 1];
  const cUp = cLast >= cFirst;
  const cDelta = cFirst > 0 ? `${cUp ? '+' : ''}${Math.round(((cLast - cFirst) / cFirst) * 100)}%` : null;

  const oFirst = onTime[0];
  const oLast = onTime[onTime.length - 1];
  const oUp = oLast >= oFirst;
  const oDelta = `${Math.abs(oLast - oFirst)} pts`;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginBottom: 20 }}>
      <TrendCard label="Maintenance completed" value={totalCompleted.toLocaleString()} deltaText={cDelta} deltaUp={cUp} values={completed} color="var(--color-primary)" gradId="sctGradCompleted" />
      <TrendCard label="On-time rate" value={`${oLast}%`} deltaText={oDelta} deltaUp={oUp} values={onTime} color="var(--color-success, #16a34a)" gradId="sctGradOnTime" />
    </div>
  );
}
