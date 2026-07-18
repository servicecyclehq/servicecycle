// ─────────────────────────────────────────────────────────────────────────────
// Dashboard.jsx — ServiceCycle compliance dashboard.
//
// Replaces the contract-era renewal dashboard with the NFPA 70B compliance
// view. Direction B "Control Room" (2026-07-13): dark instrument band on
// top (InstrumentBand.jsx), then a two-zone grid — evidence panels left
// (compliance by site / standards coverage / condensed priority assets),
// sticky action queue right (PathTo100 variant="queue") — then the
// remaining modules stacked full-width:
//   • KPI tile row: due in 30/60/90 days + overdue (red when > 0)
//   • Open deficiencies by NETA severity
//   • Maintenance horizon + recent work orders
//   • Next maintenance due (nearest schedules incl. overdue)
// Welcome/empty card when the account has no assets yet.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import WelcomeTourPanel from '../components/WelcomeTourPanel';
import InstrumentBand from '../components/InstrumentBand';
import PathTo100 from '../components/PathTo100';
import AuditReadyBanner from '../components/AuditReadyBanner';
import ComplianceDocsCard from '../components/ComplianceDocsCard';
import DashboardTrends from '../components/DashboardTrends';
import ArcFlashDashboardCard from '../components/ArcFlashDashboardCard';
import IdentifiedWorkCard from '../components/installedBase/IdentifiedWorkCard';
import { kbdActivate } from '../lib/a11y';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { CriticalityBadge } from './AssetsList';
import {
  SEVERITY_META, WO_STATUS_META, IEEE_STATUS_META,
  EQUIPMENT_TYPE_LABELS, assetLabel, fmtDate, fmtMoney,
} from '../lib/equipment';

function isPast(dateStr) {
  if (!dateStr) return false;
  return new Date(dateStr).getTime() < Date.now();
}

// C1 (2026-06-11): every dashboard drill-down records the dashboard as its
// origin, so the target page's <BackLink> returns here instead of the
// target's hardcoded parent.
const FROM_DASHBOARD = { from: '/dashboard', fromLabel: 'Dashboard' };

function metaOf(metaMap, key) {
  const m = metaMap?.[key];
  if (!m) return {};
  return typeof m === 'string' ? { label: m } : m;
}

// ── KPI tile ─────────────────────────────────────────────────────────────────
function KpiTile({ label, value, sub, accent, onClick }) {
  return (
    <div
      className="card stat-tile"
      data-accented={accent ? 'true' : undefined}
      data-clickable={onClick ? 'true' : undefined}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : -1}
      onKeyDown={kbdActivate(onClick)}
      style={{
        padding: '18px 22px', flex: '1 1 0', minWidth: 0, overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        '--tile-accent': accent || 'transparent',
      }}
    >
      <div className="stat-tile-label" style={{ marginBottom: 10 }}>
        {label}
      </div>
      <div className="stat-tile-value" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      {sub && (
        <div className="stat-tile-sub">
          {sub}
        </div>
      )}
    </div>
  );
}

// ── Severity chip tile ───────────────────────────────────────────────────────
// Clickable — deep-links into /deficiencies pre-filtered to this severity's
// open findings (the page reads ?severity=&resolved= from the URL).
// A3 (2026-06-11): condensed — count + label on one baseline, no dot bullet.
function SeverityTile({ severity, count, onClick }) {
  const m = metaOf(SEVERITY_META, severity);
  const isImmediate = severity === 'IMMEDIATE';
  const color = count > 0
    ? (isImmediate ? 'var(--color-danger)' : (m.color || 'var(--color-text)'))
    : 'var(--color-text-secondary)';
  return (
    <div
      className="card stat-tile"
      data-clickable={onClick ? 'true' : undefined}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : -1}
      onKeyDown={kbdActivate(onClick)}
      style={{
        flex: '1 1 0', minWidth: 0, padding: '8px 14px',
        display: 'flex', alignItems: 'baseline', gap: 8,
        cursor: onClick ? 'pointer' : 'default',
      }}
      title={`Open ${m.label || severity} deficiencies — click to triage`}
    >
      <span className="stat-tile-value" style={{ fontSize: 20, color }}>{count}</span>
      <span className="stat-tile-sub" style={{ marginTop: 0, minWidth: 0 }}>
        {m.label || severity}
      </span>
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
      className="hover-row"
      style={{ marginBottom: 4, cursor: 'pointer', padding: '7px 8px' }}
      onClick={go} role="button" tabIndex={0} onKeyDown={kbdActivate(go)}
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
      <div style={{ height: 8, background: 'color-mix(in srgb, var(--color-border) 55%, transparent)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: `${row.complianceRate}%`, borderRadius: 999, transition: 'width 0.4s ease',
          background: `linear-gradient(90deg, color-mix(in srgb, ${color} 72%, transparent), ${color})`,
        }} />
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
    const now = new Date();
    // Start at January of the current year so already-elapsed months (which
    // hold past-due / overdue schedules) are surfaced instead of left blank.
    const from = ymKey(new Date(now.getFullYear(), 0, 1));
    const monthsSpan = now.getMonth() + HORIZON_MONTHS; // backfilled months + 36 forward
    api.get('/api/dashboard/calendar', { params: { from, months: monthsSpan, density: 1 } })
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

  // Build cells from January of the current year (so already-elapsed,
  // past-due months are shown) through 36 months out, regardless of how much
  // data came back.
  const now0 = new Date();
  const currentYm = ymKey(now0);
  const start = new Date(now0.getFullYear(), 0, 1);
  const monthsSpan = now0.getMonth() + HORIZON_MONTHS;
  const cells = [];
  for (let i = 0; i < monthsSpan; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const ym = ymKey(d);
    const stats = byMonth?.get(ym) || { due: 0, outage: 0, overdue: 0 };
    cells.push({
      ym,
      monthIdx: d.getMonth(),
      year: d.getFullYear(),
      label: d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      ...stats,
    });
  }

  // A5 (2026-06-11): group months into calendar-year rows on a fixed
  // 12-column grid so the squares align Jan–Dec across every year. The old
  // single flex strip wrapped wherever the viewport said, which left some
  // years' first squares visually misaligned with uneven gaps.
  const years = [];
  for (const c of cells) {
    let y = years[years.length - 1];
    if (!y || y.year !== c.year) {
      y = { year: c.year, months: Array(12).fill(null) };
      years.push(y);
    }
    y.months[c.monthIdx] = c;
  }
  const MONTH_INITIALS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

  return (
    <div className="card" style={{ marginBottom: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="card-header">
        <div>
          <div className="card-title">Maintenance horizon</div>
          <div className="card-subtitle">
            Schedules due per month, this year through 3 years out — past-due months ringed in red; click any month to open it
          </div>
        </div>
      </div>
      <div style={{ padding: '12px 16px 16px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
        {byMonth === null ? (
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', padding: '8px 0' }}>
            Loading horizon…
          </div>
        ) : (
          <>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'auto repeat(12, 30px)',
              gap: '9px 6px',
              alignItems: 'center',
              justifyContent: 'start',
              overflowX: 'auto',
            }}>
              {/* Month initials header row */}
              <div aria-hidden="true" />
              {MONTH_INITIALS.map((mi, i) => (
                <div key={i} aria-hidden="true" style={{
                  fontSize: 'var(--font-size-2xs, 10px)', lineHeight: 1, textAlign: 'center',
                  color: 'var(--color-text-secondary)', fontWeight: 600,
                }}>
                  {mi}
                </div>
              ))}
              {/* One row per calendar year, squares pinned to month columns */}
              {years.map(y => [
                <div key={`y-${y.year}`} style={{
                  fontSize: 'var(--font-size-2xs, 10px)', fontWeight: 600, lineHeight: 1,
                  color: 'var(--color-text-secondary)', paddingRight: 6, whiteSpace: 'nowrap',
                }}>
                  {y.year}
                </div>,
                ...y.months.map((c, i) => {
                  if (!c) return <div key={`${y.year}-${i}`} aria-hidden="true" />;
                  const tip = `${c.label} — ${c.due} due${c.outage > 0 ? ` · ${c.outage} need outage` : ''}${c.overdue > 0 ? ` · ${c.overdue} overdue` : ''}`;
                  return (
                    <button
                      key={c.ym}
                      type="button"
                      title={tip}
                      aria-label={tip}
                      onClick={() => navigate(`/calendar?from=${c.ym}`)}
                      style={{
                        width: 30, height: 30, padding: 0,
                        borderRadius: 5, cursor: 'pointer', position: 'relative',
                        background: horizonColor(c.due),
                        border: '1px solid var(--color-border)',
                        // Green ring marks the current month; red ring marks
                        // past-due/overdue months (current month wins if both).
                        boxShadow: c.ym === currentYm
                          ? '0 0 0 2px var(--color-emerald, #10b981)'
                          : (c.overdue > 0 ? '0 0 0 2px var(--color-danger, #dc2626)' : 'none'),
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
                  );
                }),
              ])}
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
                <span style={{ width: 12, height: 12, borderRadius: 3, background: 'var(--color-border)', boxShadow: '0 0 0 2px var(--color-emerald, #10b981)' }} /> current month
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

// ── Asset link cell ───────────────────────────────────────────────────────────
// Asset-name link + equipment-type · site subline. Shared by the condensed
// priority panel (B2); formerly by the full three-tab priority card.
function AssetLinkCell({ asset }) {
  return (
    <>
      <Link to={`/assets/${asset?.id}`} state={FROM_DASHBOARD} style={{ fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'none' }}>
        {assetLabel(asset)}
      </Link>
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
        {[EQUIPMENT_TYPE_LABELS[asset?.equipmentType] || asset?.equipmentType, asset?.site?.name].filter(Boolean).join(' · ') || '—'}
      </div>
    </>
  );
}

// ── B2 zone panels ─────────────────────────────────────────────────────────────
// Direction B zones grid (docs/design/direction-board-2026-07-12.html #dir-b):
// left-column evidence panels under mono uppercase eyebrows. Each panel
// self-fetches (same convention as InstrumentBand) and self-hides when it has
// nothing to show, so the zone never renders an empty shell.

function ZoneSection({ eyebrow, aux, ariaLabel, children }) {
  return (
    <section role="group" aria-label={ariaLabel || eyebrow} style={{ marginBottom: 20 }}>
      <div className="dash-zone-eyebrow">
        {eyebrow}
        {aux && <span className="aux">{aux}</span>}
      </div>
      {children}
    </section>
  );
}

// Standards coverage — one row per governing standard with live schedules,
// from GET /api/compliance/summary (the reports hub's source). The maturity
// endpoint's `dimensions` were considered and rejected: those are program
// dimensions (coverage / on-time / baselining / EMP), not standards. Rows
// deep-link to the per-standard report (manager/admin route — same
// unconditional-link precedent as PathTo100's "see the full list").
function StandardsCoveragePanel({ navigate }) {
  const [standards, setStandards] = useState(null);

  useEffect(() => {
    let on = true;
    api.get('/api/compliance/summary')
      .then(r => { if (on) setStandards(r.data.data?.standards || []); })
      .catch(() => { if (on) setStandards([]); });
    return () => { on = false; };
  }, []);

  if (!standards || standards.length === 0) return null;

  return (
    <ZoneSection eyebrow="Standards coverage" aux="on-time % vs edition on file">
      <div className="card">
        {standards.map((s, i) => {
          const code = s.standard?.code || 'Account-defined';
          const go = () => navigate(`/reports/compliance/${encodeURIComponent(code)}`);
          return (
            <div
              key={code}
              className="hover-row"
              role="button" tabIndex={0} onClick={go} onKeyDown={kbdActivate(go)}
              title={`${code}: ${s.overdueCount} overdue of ${s.scheduleCount} schedules — open the standard report`}
              style={{
                display: 'flex', alignItems: 'baseline', gap: 10, padding: '10px 16px',
                cursor: 'pointer', fontSize: 13, borderRadius: 0,
                borderTop: i > 0 ? '1px solid var(--color-border)' : 'none',
              }}
            >
              <b style={{ fontWeight: 600, whiteSpace: 'nowrap', color: 'var(--color-text)' }}>{code}</b>
              {s.standard?.edition && (
                <span style={{ font: '500 11px var(--font-mono)', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                  {s.standard.edition} ed.
                </span>
              )}
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
                {s.standard?.title || ''}
              </span>
              <span style={{ font: '600 13px var(--font-mono)', color: s.complianceRate != null ? complianceColor(s.complianceRate) : 'var(--color-text-secondary)', flexShrink: 0 }}>
                {s.complianceRate != null ? `${s.complianceRate}%` : '—'}
              </span>
            </div>
          );
        })}
      </div>
    </ZoneSection>
  );
}

// Priority assets, condensed and tabbed — top-5 rows per cut from
// GET /api/dashboard/priority?tab=critical|value|volume. B5 removed the
// full-width three-tab card and the condensed replacement kept only the
// critical cut; review brought the other two back — replacement-cost
// exposure (value) and fleet-wide type gaps (volume) aren't readable from
// the critical view. Same per-tab lazy fetch-and-cache as the old card:
// switching back to a visited tab never refetches.
const PRIORITY_TABS = [
  { key: 'critical', label: 'Critical', aux: 'critical infrastructure' },
  { key: 'value', label: 'High value', aux: 'replacement-cost exposure' },
  { key: 'volume', label: 'By volume', aux: 'fleet by equipment type' },
];

const PRIORITY_EMPTY = {
  critical: 'No assets scored criticality 4–5 yet — set scores on the asset pages.',
  value: 'No repair-cost estimates recorded yet — add them under Risk & Criticality.',
  volume: 'No assets registered yet.',
};

function PriorityAssetsPanel({ navigate }) {
  const [tab, setTab] = useState('critical');
  const [cache, setCache] = useState({});   // tab key → top-5 rows[]
  const [failed, setFailed] = useState({}); // tab key → true after a fetch error

  useEffect(() => {
    if (cache[tab] || failed[tab]) return;
    let on = true;
    api.get('/api/dashboard/priority', { params: { tab } })
      .then(res => {
        if (!on) return;
        // Server may flatten asset fields onto the row — same normalization
        // the full card used. Volume rows are per equipment type, not per
        // asset, so they pass through as-is.
        const raw = res.data.data?.rows || [];
        const rows = (tab === 'volume' ? raw : raw.map(r => (r.asset ? r : { ...r, asset: r }))).slice(0, 5);
        setCache(p => ({ ...p, [tab]: rows }));
      })
      .catch(() => { if (on) setFailed(p => ({ ...p, [tab]: true })); });
    return () => { on = false; };
  }, [tab, cache, failed]);

  // Self-hide only until the first fetch settles (no empty-shell flash —
  // the zone convention). After that the panel stays up even when one cut
  // is empty: the other tabs may still have data, and the per-tab empty
  // line says what would fill the view.
  if (Object.keys(cache).length === 0 && Object.keys(failed).length === 0) return null;

  const rows = cache[tab];

  return (
    <ZoneSection eyebrow="Priority assets" aux={PRIORITY_TABS.find(t => t.key === tab).aux}>
      <div className="card">
        <div role="tablist" aria-label="Priority asset views" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '10px 12px', borderBottom: '1px solid var(--color-border)' }}>
          {PRIORITY_TABS.map(t => (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`priority-tab-${t.key}`}
              aria-selected={t.key === tab}
              aria-controls="priority-tabpanel"
              className="tab-pill"
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div id="priority-tabpanel" role="tabpanel" aria-labelledby={`priority-tab-${tab}`}>
          {failed[tab] ? (
            <div style={{ padding: '14px 16px', fontSize: 12, color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 10 }}>
              Couldn’t load this view.
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setFailed(p => ({ ...p, [tab]: false }))}>
                Retry
              </button>
            </div>
          ) : rows == null ? (
            <div style={{ padding: '14px 16px', fontSize: 12, color: 'var(--color-text-secondary)' }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div style={{ padding: '14px 16px', fontSize: 12, color: 'var(--color-text-secondary)' }}>{PRIORITY_EMPTY[tab]}</div>
          ) : tab === 'critical' ? (
            <>
              {rows.map((r, i) => {
                const overdueDays = r.nextDue?.date && isPast(r.nextDue.date)
                  ? Math.floor((Date.now() - new Date(r.nextDue.date).getTime()) / 86400000)
                  : null;
                return (
                  <div key={r.asset?.id || i} style={{ padding: '11px 16px', borderTop: i > 0 ? '1px solid var(--color-border)' : 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <div style={{ flex: 1, minWidth: 160 }}><AssetLinkCell asset={r.asset} /></div>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                        <CriticalityBadge score={r.asset?.criticalityScore} />
                        {r.asset?.redundancyStatus === 'N' && (
                          <span style={{ font: '600 11px var(--font-mono)', color: 'var(--color-danger)', whiteSpace: 'nowrap' }}>
                            no redundancy
                          </span>
                        )}
                      </span>
                    </div>
                    {(r.nextDue?.date || r.openDeficiencyCount > 0) && (
                      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                        {r.nextDue?.taskName || (r.nextDue?.date ? 'Next maintenance' : '')}
                        {overdueDays != null ? (
                          <> — <span style={{ font: '600 12px var(--font-mono)', color: 'var(--color-danger)' }}>{overdueDays}d overdue</span></>
                        ) : (r.nextDue?.date && <> — due {fmtDate(r.nextDue.date)}</>)}
                        {r.openDeficiencyCount > 0 && (
                          <> · {r.openDeficiencyCount} open deficienc{r.openDeficiencyCount === 1 ? 'y' : 'ies'}</>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {/* 2026-07-13 fix: this tab showed only the top 5 with no way
                  to see the rest -- Dustin's live-review call ("data needs
                  to be SIMPLE to get to"). Mirrors the volume tab's existing
                  click-through. */}
              <div
                role="button" tabIndex={0}
                className="hover-row"
                onClick={() => navigate('/assets?sort=criticality')}
                onKeyDown={kbdActivate(() => navigate('/assets?sort=criticality'))}
                style={{ padding: '10px 16px', borderTop: '1px solid var(--color-border)', fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', cursor: 'pointer' }}
              >
                View all assets sorted by criticality →
              </div>
            </>
          ) : tab === 'value' ? (
            <>
              {rows.map((r, i) => {
                const sig = IEEE_STATUS_META[r.latestPredictiveSignal?.ieeeStatus];
                return (
                  <div key={r.asset?.id || i} style={{ padding: '11px 16px', borderTop: i > 0 ? '1px solid var(--color-border)' : 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <div style={{ flex: 1, minWidth: 160 }}><AssetLinkCell asset={r.asset} /></div>
                      <span title="Repair cost estimate" style={{ font: '600 13px var(--font-mono)', color: 'var(--color-text)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                        {fmtMoney(r.repairCostEstimate)}
                      </span>
                    </div>
                    {(r.spareLeadTimeWeeks != null || sig) && (
                      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                        {r.spareLeadTimeWeeks != null && <>spare lead {r.spareLeadTimeWeeks} wk</>}
                        {r.spareLeadTimeWeeks != null && sig && <> · </>}
                        {sig && (
                          <span
                            title="Latest predictive test result (IEEE C57.104 DGA status)"
                            style={{ font: '600 12px var(--font-mono)', color: sig.color, whiteSpace: 'nowrap' }}
                          >
                            IEEE {r.latestPredictiveSignal.ieeeStatus} {sig.label}
                            {r.latestPredictiveSignal.faultCode ? ` · ${r.latestPredictiveSignal.faultCode}` : ''}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {/* 2026-07-13 fix: same gap as the critical tab above. */}
              <div
                role="button" tabIndex={0}
                className="hover-row"
                onClick={() => navigate('/assets?sort=repairCost')}
                onKeyDown={kbdActivate(() => navigate('/assets?sort=repairCost'))}
                style={{ padding: '10px 16px', borderTop: '1px solid var(--color-border)', fontSize: 12, fontWeight: 600, color: 'var(--color-primary)', cursor: 'pointer' }}
              >
                View all assets sorted by repair cost →
              </div>
            </>
          ) : (
            rows.map((r, i) => {
              const go = () => navigate(`/assets?equipmentType=${encodeURIComponent(r.equipmentType)}`);
              return (
                <div
                  key={r.equipmentType}
                  className="hover-row"
                  role="button" tabIndex={0} onClick={go} onKeyDown={kbdActivate(go)}
                  title={`Open the asset register filtered to ${EQUIPMENT_TYPE_LABELS[r.equipmentType] || r.equipmentType}`}
                  style={{ padding: '11px 16px', cursor: 'pointer', borderRadius: 0, borderTop: i > 0 ? '1px solid var(--color-border)' : 'none' }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ flex: 1, minWidth: 0, fontWeight: 600, color: 'var(--color-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {EQUIPMENT_TYPE_LABELS[r.equipmentType] || r.equipmentType}
                    </span>
                    <span style={{ font: '600 13px var(--font-mono)', color: 'var(--color-text)', flexShrink: 0 }}>
                      {r.assetCount ?? 0} asset{(r.assetCount ?? 0) === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                    {r.openScheduleCount ?? 0} open schedule{(r.openScheduleCount ?? 0) === 1 ? '' : 's'}
                    {r.overdueCount > 0 && (
                      <> · <span style={{ font: '600 12px var(--font-mono)', color: 'var(--color-danger)' }}>{r.overdueCount} overdue</span></>
                    )}
                    {r.due30Count > 0 && (
                      <> · <span style={{ font: '600 12px var(--font-mono)', color: 'var(--color-warning)' }}>{r.due30Count} due ≤30d</span></>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </ZoneSection>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── CapEx Forecast Panel (customer-facing) ────────────────────────────────────
function CapExForecastPanel() {
  const [forecast, setForecast] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/api/fleet/account-forecast')
      .then((r) => setForecast(r.data.forecast))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return null;
  if (!forecast || forecast.length === 0 || forecast.every((f) => f.assetCount === 0)) return null;

  const fmt = (c) => `$${Math.round(c / 100).toLocaleString()}`;

  return (
    <div className="card" style={{ marginBottom: 20, padding: '20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--color-text-primary)' }}>
          Equipment reliability &amp; end-of-life outlook
        </h3>
        <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
          Reliability planning — not a quote or sales offer
        </span>
      </div>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--color-text-secondary)' }}>
        Assets approaching end-of-life based on IEEE/NFPA/NETA equipment-life models and the
        condition ratings recorded in the system. Plan ahead so aging equipment is replaced on
        your schedule — before it fails. The budget ranges below are rough planning estimates only;
        they <strong>do not constitute a quote, engineering assessment, or guarantee of equipment
        condition.</strong> Consult a licensed electrical engineer before any capital decision.
      </p>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {forecast.filter((f) => f.assetCount > 0).map((f) => (
          <div key={f.year} style={{
            flex: '1 1 160px',
            padding: '14px 16px',
            background: 'linear-gradient(160deg, var(--color-primary-light) -40%, var(--color-bg) 45%)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg, 12px)',
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
              {f.year}
            </div>
            <div style={{ fontSize: 21, fontWeight: 700, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-primary)' }}>
              {f.assetCount} asset{f.assetCount !== 1 ? 's' : ''}
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '2px 0 6px' }}>
              approaching end-of-life
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary, var(--color-text-secondary))' }}>
              Budget planning est. {fmt(f.minCents)}–{fmt(f.maxCents)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Recent Condition Changes Card ────────────────────────────────────────────
// Shows C2/C3 degradation events from the last 30 days. C3 first, then C2.
// Wired to GET /api/assets/condition-changes?days=30.
function ConditionChangesCard() {
  const [changes, setChanges] = useState(null);
  const [error, setError]     = useState(null);
  const navigate = useNavigate();
  // 2026-07-13 fix: "+N more — view in Assets list" was plain text with no
  // actual link -- Dustin's live-review call ("we want to be the data
  // layer... data needs to be SIMPLE to get to"). The full `changes` array
  // is already loaded client-side (one 30-day fetch above), so an in-place
  // expand toggle is the simplest fix -- no extra round trip or new filter.
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    api.get('/api/assets/condition-changes?days=30')
      .then(r => {
        // Only show degradations (C2 or C3 as destination)
        const all = r.data.data?.conditionChanges ?? [];
        setChanges(all.filter(c => {
          const to = c.details?.to;
          return to === 'C2' || to === 'C3';
        }));
      })
      .catch(() => setError('Could not load condition changes'));
  }, []);

  const conditionBadgeStyle = (condition) => ({
    display: 'inline-block', padding: '1px 8px', borderRadius: 4, fontSize: '0.75rem',
    fontWeight: 700, color: '#fff',
    background: condition === 'C3' ? '#dc2626' : condition === 'C2' ? '#d97706' : '#16a34a',
  });

  const condLabel = (c) =>
    c === 'C1' ? 'C1' : c === 'C2' ? 'C2' : c === 'C3' ? 'C3' : c;

  if (error) return null; // don't show card if endpoint fails
  if (!changes || changes.length === 0) return null;

  return (
    <div style={{
      background: 'var(--color-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: 8, padding: '1rem 1.25rem', marginBottom: '1.25rem',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600, color: 'var(--color-text)' }}>
          Recent Condition Changes <span style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', fontWeight: 400 }}>(last 30 days)</span>
        </h3>
        <span style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
          {changes.length} event{changes.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {(showAll ? changes : changes.slice(0, 8)).map(ch => {
          const from = ch.details?.from;
          const to   = ch.details?.to;
          const name = ch.asset?.name || ch.assetId;
          const site = ch.asset?.site?.name;
          const when = ch.createdAt ? new Date(ch.createdAt).toLocaleDateString() : '';
          return (
            <div
              key={ch.id}
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/assets/${ch.assetId}`, { state: FROM_DASHBOARD })}
              onKeyDown={kbdActivate(() => navigate(`/assets/${ch.assetId}`, { state: FROM_DASHBOARD }))}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px',
                borderRadius: 6, cursor: 'pointer', fontSize: '0.85rem',
                background: to === 'C3' ? 'rgba(220,38,38,0.07)' : 'rgba(217,119,6,0.06)',
                border: `1px solid ${to === 'C3' ? 'rgba(220,38,38,0.2)' : 'rgba(217,119,6,0.15)'}`,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 500, color: 'var(--color-text)' }}>{name}</span>
                {site && <span style={{ color: 'var(--color-text-secondary)', fontSize: '0.78rem', marginLeft: 6 }}>{site}</span>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                <span style={conditionBadgeStyle(from)}>{condLabel(from)}</span>
                <span style={{ color: 'var(--color-text-secondary)', fontSize: '0.8rem' }}>→</span>
                <span style={conditionBadgeStyle(to)}>{condLabel(to)}</span>
              </div>
              <span style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', flexShrink: 0 }}>{when}</span>
            </div>
          );
        })}
      </div>
      {changes.length > 8 && (
        <button
          type="button"
          onClick={() => setShowAll(v => !v)}
          style={{
            display: 'block', width: '100%', background: 'none', border: 'none',
            cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-primary)',
            margin: '8px 0 0', textAlign: 'center', padding: '4px 0 0',
          }}
        >
          {showAll ? 'Show fewer' : `Show all ${changes.length} →`}
        </button>
      )}
    </div>
  );
}

export default function Dashboard() {
  useDocumentTitle('Dashboard');
  useEffect(() => { window.scrollTo(0, 0); }, []);
  const { user } = useAuth();
  const rrNavigate = useNavigate();
  // C1: shadow navigate so every drill-down (incl. the ones in child cards
  // that receive it as a prop) carries the dashboard-origin state.
  const navigate = (to, opts) => rrNavigate(to, { state: FROM_DASHBOARD, ...opts });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 480px)').matches); const [siteTotal, setSiteTotal] = useState(null);

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
      .then((res) => { setData(res.data.data); api.get('/api/sites').then((r) => setSiteTotal((r.data?.data?.sites || []).length)).catch(() => {}); })
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

  const canWrite = ['admin', 'manager'].includes(user?.role);

  const due = data?.dueCounts || { due30: 0, due60: 0, due90: 0, overdue: 0 };
  const defs = data?.deficiencies || { IMMEDIATE: 0, RECOMMENDED: 0, ADVISORY: 0 };
  const partsAlerts = data?.partsAlerts ?? 0;
  const partsProcurementRisk = data?.partsProcurementRisk ?? 0;
  const bySite = data?.complianceBySite || [];
  const upcoming = data?.upcoming || [];
  const recentWOs = data?.recentWorkOrders || [];

  return (
    <>
      <InstrumentBand
        companyName={user?.account?.companyName}
        siteCount={siteTotal ?? bySite.length}
        canWrite={canWrite}
        onNewAsset={() => navigate('/assets/new')}
      />

      <div className="page-body">
        {/* One-shot welcome panel (post-onboarding) — kept from the previous
            Dashboard so the wizard handoff still lands here. */}
        <WelcomeTourPanel />

        {error && <div role="alert" className="alert alert-error">{error}</div>}

        {data && data.assetCount === 0 && (
          <div className="card" style={{ padding: '44px 32px', textAlign: 'center', maxWidth: 640, margin: '0 auto 20px' }}>
            <div aria-hidden="true" style={{
              width: 64, height: 64, margin: '0 auto 16px', fontSize: 30,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 18, background: 'linear-gradient(135deg, var(--color-primary-light), transparent)',
              border: '1px solid var(--color-border)',
            }}>⚡</div>
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
              <button
                onClick={() => navigate('/assets/import')}
                className="btn btn-secondary"
                style={{ marginTop: 0, flexDirection: 'column', height: 'auto', padding: '8px 16px' }}
              >
                Import from spreadsheet
                <span style={{ display: 'block', fontSize: 12, fontWeight: 400 }}>
                  Have assets in Excel or CSV? Import up to 500 at once.
                </span>
              </button>
            </div>
          </div>
        )}

        {data && data.assetCount > 0 && (
          <>
            {/* V5 "Inspector's here" readiness + one-click EMP — stays on
                top as the single red MODULE the alarm budget allows. */}
            <AuditReadyBanner />

            {/* ── B2 zones (direction-board #dir-b): evidence (left) proves
                the band's numbers; the sticky queue (right) keeps "what do I
                do next" on screen. Collapses to one column, queue first,
                under 1100px (.dash-zones, index.css). Replaced here: the
                compact PathTo100 + MaturityScoreCard cards (band + queue
                carry those numbers) and the standalone compliance-by-site +
                three-tab priority cards (moved/condensed into the left
                zone). */}
            <div className="dash-zones">
              <div className="dash-zones-left">
                {bySite.length > 0 && (
                  <ZoneSection eyebrow="Compliance by site" aux="% schedules not overdue">
                    <div className="card" style={{ padding: 8 }}>
                      {bySite.map(row => (
                        <SiteComplianceRow key={row.siteId} row={row} navigate={navigate} />
                      ))}
                    </div>
                  </ZoneSection>
                )}
                <StandardsCoveragePanel navigate={navigate} />
                <PriorityAssetsPanel navigate={navigate} />
              </div>
              <div className="dash-zones-right">
                <PathTo100 variant="queue" />
              </div>
            </div>

            <ArcFlashDashboardCard />
            <ConditionChangesCard />
            <IdentifiedWorkCard />
            <ComplianceDocsCard />
            <DashboardTrends />

            {/* ── KPI tiles ─────────────────────────────────────────────── */}
            {/* B1 (2026-06-11): severity reads left→right — Overdue leads,
                then the open-IMMEDIATE count, then the due windows. */}
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(auto-fit, minmax(160px, 1fr))', gap: isMobile ? 10 : 16, marginBottom: 20 }}>
              {/* B5: each due tile deep-links into the calendar pre-filtered
                  to the exact set the number counts (?due= window). */}
              <KpiTile
                label="Overdue" value={due.overdue}
                sub={due.overdue > 0 ? 'Needs scheduling now' : 'All caught up'}
                accent={due.overdue > 0 ? 'var(--color-danger, #dc2626)' : 'var(--color-success, #22c55e)'}
                onClick={() => navigate('/calendar?due=overdue')}
              />
              <KpiTile
                label="Immediate" value={defs.IMMEDIATE || 0}
                sub="Open IMMEDIATE deficiencies"
                accent={(defs.IMMEDIATE || 0) > 0 ? 'var(--color-danger, #dc2626)' : undefined}
                onClick={() => navigate('/deficiencies?severity=IMMEDIATE&resolved=false')}
              />
              <KpiTile
                label="Due in 30 days" value={due.due30}
                sub="Active schedules"
                accent={due.due30 > 0 ? 'var(--color-warning, #f59e0b)' : undefined}
                onClick={() => navigate('/calendar?due=30')}
              />
              <KpiTile
                label="Due in 60 days" value={due.due60}
                sub="Cumulative window"
                accent={'var(--color-success, #22c55e)'}
                onClick={() => navigate('/calendar?due=60')}
              />
              <KpiTile
                label="Due in 90 days" value={due.due90}
                sub="Cumulative window"
                accent={'var(--color-success, #22c55e)'}
                onClick={() => navigate('/calendar?due=90')}
              />
              {partsAlerts > 0 && (
                <KpiTile
                  label="Parts alerts" value={partsAlerts}
                  sub={`${partsAlerts === 1 ? 'Part' : 'Parts'} below min stock${partsProcurementRisk > 0 ? ' · ' + partsProcurementRisk + ' procurement risk' : ''}`}
                  accent="var(--color-warning, #f59e0b)"
                  onClick={() => navigate('/parts?filter=low')}
                />
              )}
            </div>

            {/* ── Open deficiencies by severity ──────────────────────────── */}
            {/* The compliance %s (overall / schedule / coverage) live in the
                Path to 100% Compliance card above — no need to repeat the same
                numbers here, so this row is just the deficiency breakdown. */}
            <div className="card" style={{ padding: '10px 16px', marginBottom: 20 }}>
              <div className="stat-tile-label" style={{ marginBottom: 7 }}>
                Open deficiencies by severity
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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

            {/* ── CapEx forecast — B3 (2026-06-11): promoted to slot ~4; the
                3-year exposure range is the budget conversation and should
                never sit below a recency feed. */}
            <CapExForecastPanel />

            {/* ── 36-month maintenance horizon + recent work orders ───────
                B2 (2026-06-11): horizon promoted from dead last; planning
                texture belongs above the rollups.
                Layout pass (2026-06-11): the horizon shrinks to ~half page
                width and Recent Work Orders sits beside it in a two-column
                row — filling the empty bottom-right gap B4 left behind. */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
              gap: 16, marginBottom: 20, alignItems: 'stretch',
            }}>
              <MaintenanceHorizon navigate={navigate} />
              <div className="card" style={{ marginBottom: 0 }}>
                <div className="card-header">
                  <div>
                    <div className="card-title">Recent work orders</div>
                    <div className="card-subtitle">
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
                    {recentWOs.slice(0, 5).map(wo => {
                      const m = metaOf(WO_STATUS_META, wo.status);
                      const go = () => navigate(`/work-orders/${wo.id}`);
                      return (
                        <div
                          key={wo.id}
                          className="hover-row"
                          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '9px 8px', borderBottom: '1px solid var(--color-border)', borderRadius: 0, cursor: 'pointer' }}
                          onClick={go} role="button" tabIndex={0} onKeyDown={kbdActivate(go)}
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
                              display: 'inline-block', padding: '3px 10px', borderRadius: 999,
                              fontSize: 'var(--font-size-xs)', fontWeight: 600, letterSpacing: '0.01em', whiteSpace: 'nowrap',
                              background: m.bg || 'var(--color-surface)',
                              color: m.color || 'var(--color-text-secondary)',
                              border: `1px solid color-mix(in srgb, ${m.color || 'var(--color-border)'} 40%, transparent)`,
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
            </div>

            {/* ── Next maintenance due ───────────────────────────────────── */}
            <div className="card" style={{ marginBottom: 20 }}>
              <div className="card-header">
                <div>
                  <div className="card-title">Next maintenance due</div>
                  <div className="card-subtitle">
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
                              <Link to={`/assets/${s.asset?.id}`} state={FROM_DASHBOARD} style={{ fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'none' }}>
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

          </>
        )}
      </div>
    </>
  );
}
// 2026-06-11: dashboard IA pass (B1–B4, A3–A5) + horizon/recent-WO two-column row — see docs/MASTER_PUNCH_LIST_2026-06-11.md
