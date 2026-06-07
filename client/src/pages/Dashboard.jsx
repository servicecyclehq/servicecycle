// ─────────────────────────────────────────────────────────────────────────────
// Dashboard.jsx — ServiceCycle compliance dashboard.
//
// Replaces the contract-era renewal dashboard with the NFPA 70B compliance
// view backed by GET /api/dashboard:
//   • KPI tile row: due in 30/60/90 days + overdue (red when > 0)
//   • Open deficiencies by NETA severity + overall compliance rate
//   • Compliance-by-site horizontal bar list
//   • Next maintenance due (nearest schedules incl. overdue)
//   • Recent work orders
// Welcome/empty card when the account has no assets yet.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import WelcomeTourPanel from '../components/WelcomeTourPanel';
import { kbdActivate } from '../lib/a11y';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  SEVERITY_META, WO_STATUS_META, assetLabel, fmtDate,
} from '../lib/equipment';

function isPast(dateStr) {
  if (!dateStr) return false;
  return new Date(dateStr).getTime() < Date.now();
}

function metaOf(metaMap, key) {
  const m = metaMap?.[key];
  if (!m) return {};
  return typeof m === 'string' ? { label: m } : m;
}

// ── KPI tile ─────────────────────────────────────────────────────────────────
function KpiTile({ label, value, sub, accent, onClick }) {
  return (
    <div
      className="card"
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : -1}
      onKeyDown={kbdActivate(onClick)}
      style={{
        padding: '18px 22px', flex: '1 1 0', minWidth: 0, overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'box-shadow 0.15s, transform 0.15s',
        borderTop: accent ? `3px solid ${accent}` : undefined,
      }}
      onMouseEnter={e => { if (onClick) { e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.10)'; e.currentTarget.style.transform = 'translateY(-1px)'; } }}
      onMouseLeave={e => { e.currentTarget.style.boxShadow = ''; e.currentTarget.style.transform = ''; }}
    >
      <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)', marginBottom: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: accent || 'var(--color-text)', lineHeight: 1.1 }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// ── Severity chip tile ───────────────────────────────────────────────────────
// Clickable — deep-links into /deficiencies pre-filtered to this severity's
// open findings (the page reads ?severity=&resolved= from the URL).
function SeverityTile({ severity, count, onClick }) {
  const m = metaOf(SEVERITY_META, severity);
  const isImmediate = severity === 'IMMEDIATE';
  const color = isImmediate && count > 0
    ? 'var(--color-danger)'
    : (m.color || 'var(--color-text)');
  return (
    <div
      className="card"
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : -1}
      onKeyDown={kbdActivate(onClick)}
      style={{
        flex: '1 1 0', minWidth: 0, padding: '14px 18px',
        display: 'flex', alignItems: 'center', gap: 12,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'box-shadow 0.15s, transform 0.15s',
      }}
      onMouseEnter={e => { if (onClick) { e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.10)'; e.currentTarget.style.transform = 'translateY(-1px)'; } }}
      onMouseLeave={e => { e.currentTarget.style.boxShadow = ''; e.currentTarget.style.transform = ''; }}
      title={`Open ${m.label || severity} deficiencies — click to triage`}
    >
      <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color, lineHeight: 1.1 }}>{count}</div>
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {m.label || severity}
        </div>
      </div>
    </div>
  );
}

// ── Compliance bar ───────────────────────────────────────────────────────────
function complianceColor(rate) {
  if (rate >= 90) return 'var(--color-success, #22c55e)';
  if (rate >= 70) return 'var(--color-warning, #f59e0b)';
  return 'var(--color-danger, #dc2626)';
}

function SiteComplianceRow({ row, navigate }) {
  const color = complianceColor(row.complianceRate);
  const go = () => navigate(`/sites/${row.siteId}`);
  return (
    <div
      style={{ marginBottom: 4, cursor: 'pointer', borderRadius: 'var(--radius)', padding: '6px', transition: 'background 0.12s' }}
      onClick={go} role="button" tabIndex={0} onKeyDown={kbdActivate(go)}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = ''; }}
      title={`${row.siteName}: ${row.overdue} overdue of ${row.total} schedules`}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, gap: 8 }}>
        <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 500, color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {row.siteName}
        </span>
        <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color, flexShrink: 0 }}>
          {row.complianceRate}%
          <span style={{ fontWeight: 400, color: 'var(--color-text-secondary)', marginLeft: 8 }}>
            {row.overdue} overdue / {row.total}
          </span>
        </span>
      </div>
      <div style={{ height: 8, background: 'var(--color-border)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${row.complianceRate}%`, background: color, borderRadius: 4, transition: 'width 0.4s ease' }} />
      </div>
    </div>
  );
}

// ── 36-month maintenance horizon ─────────────────────────────────────────────
// Compact density strip: one cell per month for the next 36 months, colored by
// how many schedules come due in that month. Backed by
// GET /api/dashboard/calendar?from=YYYY-MM&months=36&density=1 — the density
// param is new server-side, so we render defensively: if the response carries
// a data.density array we use it; otherwise we aggregate data.schedules
// client-side (the server may also cap `months` below 36, in which case the
// later cells simply show zero until the server catches up).
//
// Color steps are literal blues (not theme vars) — like the NETA decal palette
// in lib/equipment.js this is a data-intensity convention that must read the
// same in light + dark mode.
const HORIZON_MONTHS = 36;
const HORIZON_STEPS = [
  { min: 6, color: '#1d4ed8', label: '6+' },
  { min: 3, color: '#60a5fa', label: '3–5' },
  { min: 1, color: '#bfdbfe', label: '1–2' },
];

function horizonColor(due) {
  for (const s of HORIZON_STEPS) if (due >= s.min) return s.color;
  return 'var(--color-border)'; // 0 due — faint slate
}

function ymKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function MaintenanceHorizon({ navigate }) {
  const [byMonth, setByMonth] = useState(null); // Map ym → {due, outage, overdue}; null = loading
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const from = ymKey(new Date());
    api.get('/api/dashboard/calendar', { params: { from, months: HORIZON_MONTHS, density: 1 } })
      .then(res => {
        if (cancelled) return;
        const d = res.data?.data || {};
        const map = new Map();
        if (Array.isArray(d.density)) {
          // New server shape: [{ month: 'YYYY-MM', due, requiresOutage, overdue }]
          for (const m of d.density) {
            if (!m || typeof m.month !== 'string') continue;
            map.set(m.month, {
              due:     Number(m.due) || 0,
              outage:  Number(m.requiresOutage) || 0,
              overdue: Number(m.overdue) || 0,
            });
          }
        } else if (Array.isArray(d.schedules)) {
          // Fallback: aggregate the raw schedule list client-side. Overdue is
          // only meaningful for the current month (past-due dates collapse
          // into "now").
          const nowT = Date.now();
          for (const s of d.schedules) {
            if (!s?.nextDueDate) continue;
            const dt = new Date(s.nextDueDate);
            if (Number.isNaN(dt.getTime())) continue;
            const key = ymKey(dt);
            const cur = map.get(key) || { due: 0, outage: 0, overdue: 0 };
            cur.due += 1;
            if (s.taskDefinition?.requiresOutage) cur.outage += 1;
            if (dt.getTime() < nowT) cur.overdue += 1;
            map.set(key, cur);
          }
        }
        setByMonth(map);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, []);

  if (failed) return null; // optional widget — fail silent rather than alarm

  // Build the 36 cells regardless of how much data came back.
  const start = new Date();
  const cells = [];
  for (let i = 0; i < HORIZON_MONTHS; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const ym = ymKey(d);
    const stats = byMonth?.get(ym) || { due: 0, outage: 0, overdue: 0 };
    cells.push({
      ym,
      monthIdx: d.getMonth(),
      year: d.getFullYear(),
      label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      showLabel: i === 0 || d.getMonth() === 0, // first cell + every January
      isJan: d.getMonth() === 0 && i !== 0,     // year separator gap
      ...stats,
    });
  }

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-header">
        <div>
          <div className="card-title">Maintenance horizon — next 36 months</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
            Schedules coming due per month — click a month to open it in the calendar
          </div>
        </div>
      </div>
      <div style={{ padding: '12px 16px 16px' }}>
        {byMonth === null ? (
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', padding: '8px 0' }}>
            Loading horizon…
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 3, rowGap: 14 }}>
              {cells.map(c => {
                const tip = `${c.label} — ${c.due} due${c.outage > 0 ? ` · ${c.outage} need outage` : ''}${c.overdue > 0 ? ` · ${c.overdue} overdue` : ''}`;
                return (
                  <div
                    key={c.ym}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                      // Year separator: extra leading gap before each January.
                      marginLeft: c.isJan ? 10 : 0,
                    }}
                  >
                    <div style={{
                      fontSize: 'var(--font-size-2xs, 10px)', lineHeight: 1,
                      color: 'var(--color-text-secondary)', height: 10,
                      whiteSpace: 'nowrap', fontWeight: 600,
                      visibility: c.showLabel ? 'visible' : 'hidden',
                    }}>
                      {c.showLabel ? (c.monthIdx === 0 ? String(c.year) : c.label) : '·'}
                    </div>
                    <button
                      type="button"
                      title={tip}
                      aria-label={tip}
                      onClick={() => navigate(`/calendar?from=${c.ym}`)}
                      style={{
                        width: 20, height: 20, padding: 0,
                        borderRadius: 4, cursor: 'pointer', position: 'relative',
                        background: horizonColor(c.due),
                        border: '1px solid var(--color-border)',
                        // Red ring on overdue months (only possible for the current month).
                        boxShadow: c.overdue > 0 ? '0 0 0 2px var(--color-danger, #dc2626)' : 'none',
                        transition: 'transform 0.1s',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.2)'; }}
                      onMouseLeave={e => { e.currentTarget.style.transform = ''; }}
                    >
                      {c.outage > 0 && (
                        <span aria-hidden="true" style={{
                          position: 'absolute', bottom: 2, left: '50%', transform: 'translateX(-50%)',
                          width: 5, height: 5, borderRadius: '50%',
                          background: c.due >= 3 ? '#fff' : 'var(--color-warning, #b45309)',
                          boxShadow: '0 0 0 1px rgba(0,0,0,0.25)',
                        }} />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
            {/* Legend */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginTop: 12, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: 'var(--color-border)', border: '1px solid var(--color-border)' }} /> 0 due
              </span>
              {[...HORIZON_STEPS].reverse().map(s => (
                <span key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 12, height: 12, borderRadius: 3, background: s.color }} /> {s.label}
                </span>
              ))}
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: 'var(--color-border)', position: 'relative' }}>
                  <span style={{ position: 'absolute', bottom: 2, left: '50%', transform: 'translateX(-50%)', width: 5, height: 5, borderRadius: '50%', background: 'var(--color-warning, #b45309)' }} />
                </span> needs outage
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: 'var(--color-border)', boxShadow: '0 0 0 2px var(--color-danger, #dc2626)' }} /> overdue
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  useDocumentTitle('Dashboard');
  useEffect(() => { window.scrollTo(0, 0); }, []);
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 480px)').matches);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 480px)');
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    setData(null);
    setLoading(true);
    setError('');
    api.get('/api/dashboard')
      .then((res) => setData(res.data.data))
      .catch(() => setError('Failed to load dashboard.'))
      .finally(() => setLoading(false));
  }, [user?.id]);

  if (loading) {
    return (
      <>
        <div className="page-header">
          <h1 className="page-title">Dashboard</h1>
        </div>
        <div className="page-body">
          <div className="loading">Loading dashboard…</div>
        </div>
      </>
    );
  }

  const greeting = () => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  };
  const firstName = user?.name?.split(' ')[0] || 'there';
  const canWrite = ['admin', 'manager'].includes(user?.role);

  const due = data?.dueCounts || { due30: 0, due60: 0, due90: 0, overdue: 0 };
  const defs = data?.deficiencies || { IMMEDIATE: 0, RECOMMENDED: 0, ADVISORY: 0 };
  const bySite = data?.complianceBySite || [];
  const upcoming = data?.upcoming || [];
  const recentWOs = data?.recentWorkOrders || [];

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{greeting()}, {firstName}</h1>
          <div className="page-subtitle">
            Maintenance compliance at a glance
          </div>
        </div>
        {canWrite && data && data.assetCount > 0 && (
          <button className="btn btn-primary" onClick={() => navigate('/assets/new')}>
            + New asset
          </button>
        )}
      </div>

      <div className="page-body">
        {/* One-shot welcome panel (post-onboarding) — kept from the previous
            Dashboard so the wizard handoff still lands here. */}
        <WelcomeTourPanel />

        {error && <div role="alert" className="alert alert-error">{error}</div>}

        {data && data.assetCount === 0 && (
          <div className="card" style={{ padding: '40px 32px', textAlign: 'center', maxWidth: 640, margin: '0 auto 20px' }}>
            <div style={{ fontSize: 36, marginBottom: 12 }} aria-hidden="true">⚡</div>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
              Welcome to ServiceCycle
            </div>
            <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', lineHeight: 1.6, marginBottom: 20 }}>
              Add your first site and asset to start tracking NFPA 70B maintenance
              schedules, work orders, and compliance. Sites hold your facility
              hierarchy; assets are the electrical equipment inside them.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Link to="/sites" className="btn btn-primary">Add your first site</Link>
              <Link to="/assets/new" className="btn btn-secondary">Add an asset</Link>
            </div>
          </div>
        )}

        {data && data.assetCount > 0 && (
          <>
            {/* ── KPI tiles ─────────────────────────────────────────────── */}
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(auto-fit, minmax(170px, 1fr))', gap: isMobile ? 10 : 14, marginBottom: 16 }}>
              <KpiTile
                label="Due in 30 days" value={due.due30}
                sub="Active schedules"
                accent={due.due30 > 0 ? 'var(--color-warning, #f59e0b)' : undefined}
                onClick={() => navigate('/calendar')}
              />
              <KpiTile
                label="Due in 60 days" value={due.due60}
                sub="Cumulative window"
                onClick={() => navigate('/calendar')}
              />
              <KpiTile
                label="Due in 90 days" value={due.due90}
                sub="Cumulative window"
                onClick={() => navigate('/calendar')}
              />
              <KpiTile
                label="Overdue" value={due.overdue}
                sub={due.overdue > 0 ? 'Needs scheduling now' : 'All caught up'}
                accent={due.overdue > 0 ? 'var(--color-danger, #dc2626)' : 'var(--color-success, #22c55e)'}
                onClick={() => navigate('/calendar')}
              />
            </div>

            {/* ── Deficiencies by severity + overall compliance ─────────── */}
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '2fr 1fr', gap: 14, marginBottom: 20 }}>
              <div className="card" style={{ padding: '14px 18px' }}>
                <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)', marginBottom: 10 }}>
                  Open deficiencies by severity
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {['IMMEDIATE', 'RECOMMENDED', 'ADVISORY'].map(sev => (
                    <SeverityTile
                      key={sev}
                      severity={sev}
                      count={defs[sev] || 0}
                      onClick={() => navigate(`/deficiencies?severity=${sev}&resolved=false`)}
                    />
                  ))}
                </div>
              </div>
              <div className="card" style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                  Overall compliance rate
                </div>
                <div style={{ fontSize: 36, fontWeight: 700, lineHeight: 1.1, color: complianceColor(data.overallComplianceRate ?? 100) }}>
                  {data.overallComplianceRate ?? 100}%
                </div>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
                  active schedules not overdue · {data.scheduleCount ?? 0} schedule{(data.scheduleCount ?? 0) !== 1 ? 's' : ''}
                </div>
              </div>
            </div>

            {/* ── Compliance by site ─────────────────────────────────────── */}
            {bySite.length > 0 && (
              <div className="card" style={{ marginBottom: 20 }}>
                <div className="card-header">
                  <div>
                    <div className="card-title">Compliance by site</div>
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                      % of active maintenance schedules not overdue — click a site to drill in
                    </div>
                  </div>
                </div>
                <div style={{ padding: '8px 16px 16px' }}>
                  {bySite.map(row => (
                    <SiteComplianceRow key={row.siteId} row={row} navigate={navigate} />
                  ))}
                </div>
              </div>
            )}

            {/* ── Next maintenance due ───────────────────────────────────── */}
            <div className="card" style={{ marginBottom: 20 }}>
              <div className="card-header">
                <div>
                  <div className="card-title">Next maintenance due</div>
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                    Nearest due schedules, including overdue
                  </div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => navigate('/calendar')}>
                  Open calendar
                </button>
              </div>
              {upcoming.length === 0 ? (
                <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
                  <span aria-hidden="true">✓</span> Nothing due in the next 90 days
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th>Task</th>
                        <th>Standard</th>
                        <th style={{ textAlign: 'right' }}>Due date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {upcoming.map(s => {
                        const overdue = isPast(s.nextDueDate);
                        return (
                          <tr key={s.id}>
                            <td>
                              <Link to={`/assets/${s.asset?.id}`} style={{ fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'none' }}>
                                {assetLabel(s.asset)}
                              </Link>
                              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                                {s.asset?.site?.name || '—'}
                              </div>
                            </td>
                            <td>
                              {s.taskDefinition?.taskName || '—'}
                              {s.taskDefinition?.requiresOutage && (
                                <span
                                  title="This task requires a planned outage"
                                  style={{
                                    marginLeft: 6, fontSize: 'var(--font-size-2xs)', fontWeight: 700,
                                    padding: '1px 6px', borderRadius: 999,
                                    background: 'var(--color-warning-bg, rgba(245,158,11,0.12))',
                                    color: 'var(--color-warning, #b45309)',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  OUTAGE
                                </span>
                              )}
                            </td>
                            <td className="td-muted">{s.taskDefinition?.standardRef || '—'}</td>
                            <td style={{ textAlign: 'right', fontWeight: overdue ? 700 : 400, color: overdue ? 'var(--color-danger)' : undefined }}>
                              {fmtDate(s.nextDueDate)}
                              {overdue && (
                                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-danger)' }}>Overdue</div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ── Recent work orders ─────────────────────────────────────── */}
            <div className="card" style={{ marginBottom: 20 }}>
              <div className="card-header">
                <div>
                  <div className="card-title">Recent work orders</div>
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                    Most recently updated jobs
                  </div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => navigate('/work-orders')}>
                  View all
                </button>
              </div>
              {recentWOs.length === 0 ? (
                <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
                  No work orders yet
                </div>
              ) : (
                <div style={{ padding: '4px 16px 12px' }}>
                  {recentWOs.map(wo => {
                    const m = metaOf(WO_STATUS_META, wo.status);
                    const go = () => navigate(`/work-orders/${wo.id}`);
                    return (
                      <div
                        key={wo.id}
                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '8px 6px', borderBottom: '1px solid var(--color-border)', cursor: 'pointer' }}
                        onClick={go} role="button" tabIndex={0} onKeyDown={kbdActivate(go)}
                        onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = ''; }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, color: 'var(--color-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {assetLabel(wo.asset)}
                          </div>
                          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {wo.schedule?.taskDefinition?.taskName ? `${wo.schedule.taskDefinition.taskName} · ` : ''}
                            {wo.contractor?.name || 'Unassigned'}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                          <span style={{
                            display: 'inline-block', padding: '2px 8px', borderRadius: 999,
                            fontSize: 'var(--font-size-xs)', fontWeight: 600, whiteSpace: 'nowrap',
                            background: m.bg || 'var(--color-surface)',
                            color: m.color || 'var(--color-text-secondary)',
                            border: `1px solid ${m.color || 'var(--color-border)'}`,
                          }}>
                            {m.label || wo.status}
                          </span>
                          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 3 }}>
                            {fmtDate(wo.updatedAt)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── 36-month maintenance horizon ───────────────────────────── */}
            <MaintenanceHorizon navigate={navigate} />
          </>
        )}
      </div>
    </>
  );
}
