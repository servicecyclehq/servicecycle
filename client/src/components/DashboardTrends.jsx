// ─────────────────────────────────────────────────────────────────────────────
// DashboardTrends.jsx — bold-redesign KPI sparkline strip.
//
// Real trend lines (no fabricated client data): pulls GET /api/dashboard/trends,
// which aggregates COMPLETE work orders into monthly "completed" + "on-time %"
// series. Renders nothing until there's history, so it's inert on a fresh demo
// and only lights up once the 5-year seed history (or real completions) exist.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import api from '../api/client';

function Spark({ values, color }) {
  const present = values.filter((v) => v != null);
  if (present.length < 2) return null;
  const max = Math.max(...present, 1);
  const min = Math.min(...present, 0);
  const range = max - min || 1;
  const W = 100, H = 32;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * W;
      const y = v == null ? H : H - ((v - min) / range) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true"
      style={{ width: '100%', height: 36, display: 'block', color, marginTop: 8 }}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function DashboardTrends() {
  const [series, setSeries] = useState(null);

  useEffect(() => {
    api.get('/api/dashboard/trends?months=24')
      .then((r) => setSeries(r.data?.data?.series || []))
      .catch(() => setSeries([]));
  }, []);

  if (!series || series.length === 0) return null;

  const completed = series.map((s) => s.completed);
  const onTime = series.map((s) => s.onTimeRate);
  const totalCompleted = completed.reduce((a, b) => a + (b || 0), 0);
  if (totalCompleted === 0) return null; // no history yet — stay inert

  const lastOnTime = [...onTime].reverse().find((v) => v != null);

  const cards = [
    { label: 'Maintenance completed', value: totalCompleted.toLocaleString(), sub: 'monthly · last 24 mo', vals: completed, color: 'var(--color-primary)' },
    { label: 'On-time rate', value: lastOnTime != null ? `${lastOnTime}%` : '—', sub: 'trend · last 24 mo', vals: onTime, color: 'var(--color-success)' },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginBottom: 20 }}>
      {cards.map((c, i) => (
        <div key={i} className="card stat-tile" style={{ padding: '18px 22px' }}>
          <div className="stat-tile-label">{c.label}</div>
          <div className="stat-tile-value">{c.value}</div>
          <Spark values={c.vals} color={c.color} />
          <div className="stat-tile-sub">{c.sub}</div>
        </div>
      ))}
    </div>
  );
}
