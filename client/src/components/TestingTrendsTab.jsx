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

import { useEffect, useState } from 'react';
import api from '../api/client';

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

export default function TestingTrendsTab({ asset }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [events, setEvents] = useState([]);

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

  return (
    <>
      {/* Year-over-year pivot */}
      <div className="card mb-16">
        <div className="card-header">
          <div className="card-title">Year-over-Year Test Trends</div>
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
            {events.length} test event{events.length !== 1 ? 's' : ''} · readings flagged in red are trending the wrong way
          </span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Test / Phase</th>
                {events.map((ev) => (
                  <th key={ev.id} style={{ textAlign: 'right' }}>
                    {fmtDate(ev.date)}
                  </th>
                ))}
                <th style={{ textAlign: 'right' }}>Latest Δ</th>
                <th>Trend</th>
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
                    {events.map((ev) => {
                      const m = row.byEvent[ev.id];
                      return (
                        <td key={ev.id} style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                          {m?.value != null && m.value !== '' ? m.value : <span className="text-muted">—</span>}
                        </td>
                      );
                    })}
                    <td style={{ textAlign: 'right', fontWeight: flag?.significant ? 700 : 500, color: flag?.color }}>
                      {flag ? `${flag.pct > 0 ? '▲' : '▼'} ${Math.abs(flag.pct).toFixed(0)}%` : '—'}
                    </td>
                    <td>
                      <Sparkline values={events.map((ev) => row.byEvent[ev.id]?.value)} />
                    </td>
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
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
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
