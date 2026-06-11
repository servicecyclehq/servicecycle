// ─────────────────────────────────────────────────────────────────────────────
// TestingTrendsTab.jsx — the "Testing & Trends" tab on the asset detail page.
//
// Renders an asset's annual test-report history (PowerDB/Megger import target):
//   1. Year-over-year pivot — each reading (test type + phase) across every
//      test event, with the latest delta and a tiny sparkline, flagging the
//      readings trending the WRONG way (rising contact resistance, falling
//      insulation resistance, etc.) so deficiencies surface at a glance.
//   2. Test-event history — one card per dated test event with its readings.
//
// Data: GET /api/assets/:id/test-history → { events: [{ id, date, vendor,
//   techName, measurements: [{ measurementType, phase, value, unit, passFail,
//   expectedRange, testVoltage, notes }] }] } (events sorted oldest→newest).
// Charts/Excel export are follow-ups; this is the history + YoY core.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  RadialBarChart,
  RadialBar,
  PolarAngleAxis,
} from 'recharts';
import api from '../api/client';

// Modern series palette: phase A teal/cyan, B violet, C rose (so a problem
// C-phase pops). Tests with no phase fall back to teal. Each gets a matching
// translucent gradient area fill.
const PHASE_COLORS = {
  A: '#06b6d4', B: '#8b5cf6', C: '#f43f5e',
  "A-A'": '#06b6d4', "B-B'": '#8b5cf6', "C-C'": '#f43f5e',
  '': '#06b6d4',
};
const SERIES_FALLBACK = ['#06b6d4', '#8b5cf6', '#f43f5e', '#f59e0b'];
const colorForPhase = (phase, idx = 0) =>
  PHASE_COLORS[phase] || SERIES_FALLBACK[idx % SERIES_FALLBACK.length];

// Which direction is BAD for each measurement type (drives the flag color).
// 'up' = higher is worse (contact resistance, transformer power factor, DGA,
// battery internal resistance); 'down' = lower is worse (insulation
// resistance, polarization index, battery capacity).
const BAD_DIRECTION = {
  contact_resistance: 'up',
  pole_resistance: 'up',
  power_factor: 'up',
  tan_delta: 'up',
  dissolved_gas: 'up',
  battery_internal_resistance: 'up',
  winding_resistance: 'up',
  insulation_resistance: 'down',
  polarization_index: 'down',
  battery_capacity: 'down',
};

const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  return isNaN(dt) ? '—' : dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const titleCase = (s) =>
  String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
};

// Tiny inline-SVG sparkline (no chart dependency).
function Sparkline({ values, width = 96, height = 24 }) {
  const pts = values.map(num).filter((v) => v != null);
  if (pts.length < 2) return <span style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>—</span>;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const step = width / (pts.length - 1);
  const path = pts
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={width} height={height} style={{ display: 'block' }} aria-hidden="true">
      <polyline points={path} fill="none" stroke="var(--color-primary)" strokeWidth="1.5" />
    </svg>
  );
}

// Short x-axis label for a test event: year if we can parse it, else short date.
const yearLabel = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt)) return '—';
  return String(dt.getFullYear());
};

// Clean, app-themed tooltip (rounded, surface bg, token border).
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const rows = payload.filter((p) => p.value != null);
  if (!rows.length) return null;
  return (
    <div
      style={{
        background: 'color-mix(in srgb, var(--color-surface, #161b22) 88%, transparent)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        border: '1px solid var(--color-border)',
        borderRadius: 12,
        padding: '10px 14px',
        boxShadow: 'var(--shadow-md, 0 4px 12px rgba(0,0,0,0.18))',
        fontSize: 12,
        minWidth: 140,
      }}
    >
      <div style={{ color: 'var(--color-text-muted)', fontWeight: 600, letterSpacing: '0.04em', marginBottom: 6 }}>{label}</div>
      {rows.map((p) => (
        <div key={p.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 8, lineHeight: 1.7 }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: p.color, display: 'inline-block', flex: '0 0 auto' }} />
          <span style={{ color: 'var(--color-text-secondary)' }}>{p.name}</span>
          <span style={{ marginLeft: 'auto', color: 'var(--color-text)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {typeof p.value === 'number' ? Number(p.value.toFixed(2)) : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// Compact recharts radial gauge: latest value as % toward a sensible max.
function ReadingGauge({ label, value, unit, max, color }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const data = [{ name: label, value: pct, fill: color }];
  return (
    <div style={{ textAlign: 'center', minWidth: 116 }}>
      <div style={{ width: 116, height: 116, position: 'relative', margin: '0 auto' }}>
        <ResponsiveContainer width="100%" height="100%">
          <RadialBarChart
            innerRadius="72%"
            outerRadius="100%"
            barSize={9}
            data={data}
            startAngle={220}
            endAngle={-40}
          >
            <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
            <RadialBar background={{ fill: 'var(--color-border)' }} dataKey="value" cornerRadius={6} />
          </RadialBarChart>
        </ResponsiveContainer>
        <div
          style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', pointerEvents: 'none',
          }}
        >
          <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--color-text)', fontVariantNumeric: 'tabular-nums' }}>
            {Number(Number(value).toFixed(2))}
          </span>
          {unit && <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{unit}</span>}
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 4, lineHeight: 1.25 }}>{label}</div>
    </div>
  );
}

export default function TestingTrendsTab({ asset }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [events, setEvents] = useState([]);
  // Which measurementType drives the hero trend chart. null => auto-pick the
  // most-flagged type once data loads.
  const [selectedType, setSelectedType] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    api
      .get(`/api/assets/${asset.id}/test-history`)
      .then((res) => {
        if (!alive) return;
        setEvents(res.data?.data?.events || []);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e?.response?.data?.error || 'Failed to load test history');
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [asset.id]);

  if (loading) {
    return <div className="loading">Loading test history…</div>;
  }
  if (error) {
    return <div className="alert alert-error">{error}</div>;
  }
  if (events.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">No test data yet</div>
        <div className="empty-state-sub">
          Annual test results (PowerDB / Megger reports) will appear here once imported. Each
          year is stored per test, so you can track this asset's performance and catch
          deficiencies trending year over year.
        </div>
      </div>
    );
  }

  // Build the YoY pivot: one row per (measurementType + phase), columns = events.
  const rowKey = (m) => `${m.measurementType}||${m.phase || ''}`;
  const rowMap = new Map();
  for (const ev of events) {
    for (const m of ev.measurements || []) {
      const k = rowKey(m);
      if (!rowMap.has(k))
        rowMap.set(k, { measurementType: m.measurementType, phase: m.phase || '', unit: m.unit || '', byEvent: {} });
      rowMap.get(k).byEvent[ev.id] = m;
    }
  }
  const rows = [...rowMap.values()].sort(
    (a, b) =>
      a.measurementType.localeCompare(b.measurementType) || String(a.phase).localeCompare(String(b.phase)),
  );

  const flagFor = (row) => {
    const series = events.map((ev) => num(row.byEvent[ev.id]?.value));
    const present = series.filter((v) => v != null);
    if (present.length < 2) return null;
    const latest = present[present.length - 1];
    const prev = present[present.length - 2];
    if (prev === 0) return null;
    const pct = ((latest - prev) / Math.abs(prev)) * 100;
    const bad = BAD_DIRECTION[row.measurementType];
    const movingBad = (bad === 'up' && pct > 0) || (bad === 'down' && pct < 0);
    const significant = Math.abs(pct) >= 15;
    return { pct, color: movingBad && significant ? 'var(--color-danger)' : 'var(--color-text-secondary)', significant: movingBad && significant };
  };

  // ── Hero chart data ─────────────────────────────────────────────────────────
  // Bad-direction magnitude of each row's latest move (used to auto-pick the
  // most interesting measurementType and to rank gauges).
  const rowFlagMag = (row) => {
    const f = flagFor(row);
    if (!f) return 0;
    const bad = BAD_DIRECTION[row.measurementType];
    const movingBad = (bad === 'up' && f.pct > 0) || (bad === 'down' && f.pct < 0);
    return movingBad ? Math.abs(f.pct) : 0;
  };

  // Distinct measurementTypes present, and the one with the largest bad move.
  const types = [...new Set(rows.map((r) => r.measurementType))];
  let autoType = types[0] || null;
  let autoMag = -1;
  for (const t of types) {
    const mag = Math.max(0, ...rows.filter((r) => r.measurementType === t).map(rowFlagMag));
    if (mag > autoMag) { autoMag = mag; autoType = t; }
  }
  const activeType = (selectedType && types.includes(selectedType)) ? selectedType : autoType;

  // Series (one per phase) for the active measurementType, keyed by event year.
  const activeRows = rows.filter((r) => r.measurementType === activeType);
  const chartUnit = activeRows.find((r) => r.unit)?.unit || '';
  const chartData = events.map((ev) => {
    const point = { label: yearLabel(ev.date), date: ev.date };
    for (const r of activeRows) {
      const v = num(r.byEvent[ev.id]?.value);
      point[r.phase || 'value'] = v;
    }
    return point;
  });
  const chartSeries = activeRows.map((r, i) => ({
    key: r.phase || 'value',
    name: r.phase ? `Phase ${r.phase}` : titleCase(activeType),
    color: colorForPhase(r.phase || '', i),
  }));

  // Top flagged readings (bad-direction movers) for the gauge row.
  const gaugeRows = rows
    .map((r) => ({ row: r, mag: rowFlagMag(r) }))
    .filter((x) => x.mag > 0)
    .sort((a, b) => b.mag - a.mag)
    .slice(0, 4)
    .map(({ row }, i) => {
      const series = events.map((ev) => num(row.byEvent[ev.id]?.value)).filter((v) => v != null);
      const latest = series[series.length - 1] ?? 0;
      const peak = Math.max(...series, latest);
      // Sensible gauge max: a bit above the historical peak so the needle has room.
      const max = peak > 0 ? peak * 1.25 : (latest || 1) * 1.25;
      return {
        label: `${titleCase(row.measurementType)}${row.phase ? ' · ' + row.phase : ''}`,
        value: latest,
        unit: row.unit || '',
        max,
        color: colorForPhase(row.phase || '', i),
      };
    });

  // Whether a YoY flag threshold band makes sense to draw (insulation/contact).
  const hasFlag = activeRows.some((r) => flagFor(r)?.significant);

  return (
    <>
      {/* ── Hero: modern multi-year trend chart + gauge row ────────────────── */}
      <div className="card mb-16">
        <div className="card-header" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="card-title">Trend Analysis</div>
            <span className="card-subtitle" style={{ display: 'block' }}>
              {titleCase(activeType || '')}{chartUnit ? ` (${chartUnit})` : ''} across {events.length} test event{events.length !== 1 ? 's' : ''}
              {hasFlag ? ' · trending the wrong way' : ''}
            </span>
          </div>
          {types.length > 1 && (
            <select
              className="filter-select"
              value={activeType || ''}
              onChange={(e) => setSelectedType(e.target.value)}
            >
              {types.map((t) => (
                <option key={t} value={t}>{titleCase(t)}</option>
              ))}
            </select>
          )}
        </div>

        <div style={{ width: '100%', height: 280, marginTop: 8 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
              <defs>
                {chartSeries.map((s) => (
                  <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 6" stroke="var(--color-border)" strokeOpacity={0.45} vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fill: 'var(--color-text-muted)', fontSize: 12 }}
                axisLine={{ stroke: 'var(--color-border)' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: 'var(--color-text-muted)', fontSize: 12 }}
                axisLine={false}
                tickLine={false}
                width={48}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--color-border)', strokeWidth: 1 }} />
              <Legend wrapperStyle={{ fontSize: 12, color: 'var(--color-text-secondary)' }} iconType="plainline" />
              {chartSeries.map((s) => (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={2.25}
                  fill={`url(#grad-${s.key})`}
                  connectNulls
                  dot={false}
                  activeDot={{ r: 4.5, stroke: 'var(--color-surface)', strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {gaugeRows.length > 0 && (
          <div
            style={{
              display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center',
              marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--color-border)',
            }}
          >
            {gaugeRows.map((g, i) => (
              <ReadingGauge key={i} {...g} />
            ))}
          </div>
        )}
      </div>

      {/* Year-over-year pivot */}
      <div className="card mb-16">
        <div className="card-header">
          <div className="card-title">Year-over-Year Test Trends</div>
          <span className="card-subtitle" style={{ display: 'block' }}>
            {events.length} test event{events.length !== 1 ? 's' : ''} · readings flagged in red are trending the wrong way
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {/* D4 (2026-06-11): verdict columns (Latest Δ + Trend) moved
                    to positions 2–3 — with 5+ years of events they scrolled
                    off-screen when trailing the history columns. */}
                <th>Test / Phase</th>
                <th style={{ textAlign: 'right' }}>Latest Δ</th>
                <th>Trend</th>
                {events.map((ev) => (
                  <th key={ev.id} style={{ textAlign: 'right' }}>
                    {fmtDate(ev.date)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const flag = flagFor(row);
                return (
                  <tr key={`${row.measurementType}-${row.phase}`}>
                    <td>
                      {titleCase(row.measurementType)}
                      {row.phase && <span className="text-muted"> · {row.phase}</span>}
                      {row.unit && <span className="text-muted" style={{ fontSize: 11 }}> ({row.unit})</span>}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: flag?.significant ? 700 : 500, color: flag?.color }}>
                      {flag ? `${flag.pct > 0 ? '▲' : '▼'} ${Math.abs(flag.pct).toFixed(0)}%` : '—'}
                    </td>
                    <td>
                      <Sparkline values={events.map((ev) => row.byEvent[ev.id]?.value)} />
                    </td>
                    {events.map((ev) => {
                      const m = row.byEvent[ev.id];
                      return (
                        <td key={ev.id} style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {m?.value != null && m.value !== '' ? m.value : <span className="text-muted">—</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Test-event history (newest first) */}
      {[...events].reverse().map((ev) => (
        <div className="card mb-16" key={ev.id}>
          <div className="card-header">
            <div className="card-title">Test Event · {fmtDate(ev.date)}</div>
            <span className="card-subtitle" style={{ display: 'block' }}>
              {[ev.vendor, ev.techName].filter(Boolean).join(' · ') || 'Test report'}
            </span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Test</th>
                  <th>Phase</th>
                  <th style={{ textAlign: 'right' }}>Value</th>
                  <th>Unit</th>
                  <th>Expected</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {(ev.measurements || []).map((m) => (
                  <tr key={m.id}>
                    <td>{titleCase(m.measurementType)}</td>
                    <td>{m.phase || '—'}</td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {m.value != null && m.value !== '' ? m.value : '—'}
                    </td>
                    <td className="text-muted">{m.unit || '—'}</td>
                    <td className="text-muted">{m.expectedRange || '—'}</td>
                    <td>{m.passFail || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </>
  );
}
