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
import PathTo100 from '../components/PathTo100';
import { kbdActivate } from '../lib/a11y';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { CriticalityBadge } from './AssetsList';
import {
  SEVERITY_META, WO_STATUS_META, REDUNDANCY_META, IEEE_STATUS_META,
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

// ── Priority assets ──────────────────────────────────────────────────────────
// Three-tab risk triage card backed by GET /api/dashboard/priority?tab=…
// Each tab fetches lazily on first activation and caches in state for the
// life of the dashboard mount — switching back is instant.
const PRIORITY_TABS = [
  { key: 'critical', label: '🚨 Critical Infrastructure' },
  { key: 'value',    label: '💸 High Value' },
  { key: 'volume',   label: '📈 By Volume' },
];

// Pill chip from a {label,color,bg} meta record (Dashboard-local twin of
// AssetDetail's MetaChip).
function PillChip({ meta, fallback, title }) {
  if (!meta) return <span className="text-muted">{fallback || '—'}</span>;
  return (
    <span title={title} style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 999,
      fontSize: 'var(--font-size-xs)', fontWeight: 600, letterSpacing: '0.01em', whiteSpace: 'nowrap',
      background: meta.bg, color: meta.color,
      border: `1px solid color-mix(in srgb, ${meta.color} 40%, transparent)`,
    }}>
      {meta.label}
    </span>
  );
}

// Red count pill (overdue / open deficiencies); muted zero.
function DangerCount({ count }) {
  if (!count) return <span className="text-muted">0</span>;
  return (
    <span style={{
      display: 'inline-block', minWidth: 20, textAlign: 'center',
      padding: '2px 7px', borderRadius: 20, fontWeight: 700,
      fontSize: 'var(--font-size-xs)',
      background: 'var(--color-danger-bg, #fef2f2)', color: 'var(--color-danger, #dc2626)',
    }}>
      {count}
    </span>
  );
}

// Latest predictive-test signal — IEEE C57.104 status colored amber/red when
// 2/3, with the fault code and sample date alongside.
function PredictiveSignalChip({ signal }) {
  const m = IEEE_STATUS_META[signal?.ieeeStatus];
  if (!m) return <span className="text-muted">—</span>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
      <PillChip
        meta={{ ...m, label: `IEEE ${signal.ieeeStatus} — ${m.label}${signal.faultCode ? ` · ${signal.faultCode}` : ''}` }}
        title="Latest predictive test result (IEEE C57.104 DGA status)"
      />
      {signal.sampleDate && (
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
          {fmtDate(signal.sampleDate)}
        </span>
      )}
    </span>
  );
}

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

function PriorityNextDue({ nextDue }) {
  if (!nextDue?.date) return <span className="text-muted">—</span>;
  const overdue = isPast(nextDue.date);
  return (
    <div>
      <div style={{ fontWeight: overdue ? 700 : 400, color: overdue ? 'var(--color-danger)' : undefined, fontSize: 'var(--font-size-ui)' }}>
        {fmtDate(nextDue.date)}{overdue ? ' · overdue' : ''}
      </div>
      {nextDue.taskName && (
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
          {nextDue.taskName}
        </div>
      )}
    </div>
  );
}

const PRIORITY_EMPTY = {
  critical: 'No assets scored criticality 4–5 yet — set scores on the asset pages to populate this view.',
  value:    'No repair-cost estimates recorded yet — add them under Risk & Criticality on the asset pages.',
  volume:   'No assets registered yet.',
};

function PriorityAssetsCard({ navigate }) {
  const [tab, setTab]       = useState('critical');
  const [cache, setCache]   = useState({});  // tab key → rows[]
  const [failed, setFailed] = useState({});  // tab key → true after a fetch error

  useEffect(() => {
    if (cache[tab] || failed[tab]) return;
    let cancelled = false;
    api.get('/api/dashboard/priority', { params: { tab } })
      .then(res => {
        if (cancelled) return;
        // The server flattens asset fields onto each row (id, equipmentType,
        // site, criticalityScore… at top level alongside nextDue/counts);
        // normalize to the nested { asset, ...extras } shape the cells read,
        // accepting both forms so neither side breaks the other.
        const raw = res.data.data?.rows || [];
        const rows = tab === 'volume' ? raw : raw.map(r => (r.asset ? r : { ...r, asset: r }));
        setCache(p => ({ ...p, [tab]: rows }));
      })
      .catch(() => { if (!cancelled) setFailed(p => ({ ...p, [tab]: true })); });
    return () => { cancelled = true; };
  }, [tab, cache, failed]);

  const rows = cache[tab];

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-header">
        <div>
          <div className="card-title">Priority assets</div>
          <div className="card-subtitle">
            Where to spend the next maintenance dollar — by risk, replacement cost, or fleet volume
          </div>
        </div>
      </div>
      {/* Tab row */}
      <div role="tablist" aria-label="Priority asset views" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '10px 16px 0' }}>
        {PRIORITY_TABS.map(t => {
          const active = t.key === tab;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              className="tab-pill"
              aria-selected={active}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {failed[tab] ? (
        <div style={{ padding: '20px 16px', fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 10 }}>
          Couldn’t load this view.
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setFailed(p => ({ ...p, [tab]: false }))}>
            Retry
          </button>
        </div>
      ) : rows == null ? (
        <div style={{ padding: '20px 16px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
          {PRIORITY_EMPTY[tab]}
        </div>
      ) : tab === 'critical' ? (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Criticality</th>
                <th>Redundancy</th>
                <th>Next due</th>
                <th style={{ textAlign: 'right' }}>Overdue</th>
                <th style={{ textAlign: 'right' }}>Open def.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.asset?.id}>
                  <td><AssetLinkCell asset={r.asset} /></td>
                  <td><CriticalityBadge score={r.asset?.criticalityScore} /></td>
                  <td><PillChip meta={REDUNDANCY_META[r.asset?.redundancyStatus]} fallback="—" title="Power-path redundancy" /></td>
                  <td><PriorityNextDue nextDue={r.nextDue} /></td>
                  <td style={{ textAlign: 'right' }}><DangerCount count={r.overdueCount} /></td>
                  <td style={{ textAlign: 'right' }}><DangerCount count={r.openDeficiencyCount} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : tab === 'value' ? (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th style={{ textAlign: 'right' }}>Repair cost</th>
                <th style={{ textAlign: 'right' }}>Spare lead time</th>
                <th>Predictive signal</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.asset?.id}>
                  <td><AssetLinkCell asset={r.asset} /></td>
                  <td style={{ textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>{fmtMoney(r.repairCostEstimate)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {r.spareLeadTimeWeeks != null
                      ? `${r.spareLeadTimeWeeks} wk`
                      : <span className="text-muted">—</span>}
                  </td>
                  <td><PredictiveSignalChip signal={r.latestPredictiveSignal} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th>Equipment type</th>
                <th style={{ textAlign: 'right' }}>Assets</th>
                <th style={{ textAlign: 'right' }}>Open schedules</th>
                <th style={{ textAlign: 'right' }}>Overdue</th>
                <th style={{ textAlign: 'right' }}>Due ≤ 30d</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const go = () => navigate(`/assets?equipmentType=${encodeURIComponent(r.equipmentType)}`);
                return (
                  <tr
                    key={r.equipmentType}
                    style={{ cursor: 'pointer' }}
                    onClick={go} tabIndex={0} onKeyDown={kbdActivate(go)}
                    title={`Open the asset register filtered to ${EQUIPMENT_TYPE_LABELS[r.equipmentType] || r.equipmentType}`}
                  >
                    <td style={{ fontWeight: 600, color: 'var(--color-primary)' }}>
                      {EQUIPMENT_TYPE_LABELS[r.equipmentType] || r.equipmentType}
                    </td>
                    <td style={{ textAlign: 'right' }}>{r.assetCount ?? 0}</td>
                    <td style={{ textAlign: 'right' }} className="td-muted">{r.openScheduleCount ?? 0}</td>
                    <td style={{ textAlign: 'right' }}><DangerCount count={r.overdueCount} /></td>
                    <td style={{ textAlign: 'right', fontWeight: r.due30Count > 0 ? 700 : 400, color: r.due30Count > 0 ? 'var(--color-warning, #b45309)' : 'var(--color-text-muted)' }}>
                      {r.due30Count ?? 0}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
            </div>
          </div>
        )}

        {data && data.assetCount > 0 && (
          <>
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
                onClick={() => navigate('/calendar?due=60')}
              />
              <KpiTile
                label="Due in 90 days" value={due.due90}
                sub="Cumulative window"
                onClick={() => navigate('/calendar?due=90')}
              />
            </div>

            {/* ── Deficiencies by severity + overall compliance ─────────── */}
            {/* A3/A4 (2026-06-11): condensed — inline count·label tiles, and
                the compliance % sized like the KPI tiles instead of 36px. */}
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '2fr 1fr', gap: 16, marginBottom: 20 }}>
              <div className="card" style={{ padding: '10px 16px' }}>
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
              <div className="card" style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <div className="stat-tile-label" style={{ marginBottom: 4 }}>
                  Overall compliance rate
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span className="stat-tile-value" style={{ color: complianceColor(data.overallComplianceRate ?? 100) }}>
                    {data.overallComplianceRate ?? 100}%
                  </span>
                  <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                    active schedules not overdue · {data.scheduleCount ?? 0} schedule{(data.scheduleCount ?? 0) !== 1 ? 's' : ''}
                  </span>
                </div>
                {data.coverageRate != null && (
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
                    Coverage <strong style={{ color: complianceColor(data.coverageRate) }}>{data.coverageRate}%</strong>
                    {' '}({data.coveredAssets}/{(data.coveredAssets ?? 0) + (data.uncoveredAssets ?? 0)} assets) ·
                    {' '}true rate <strong>{data.overallComplianceRateHonest ?? data.overallComplianceRate}%</strong>
                  </div>
                )}
              </div>
            </div>

            {/* ── Path to 100% — the compliance gap as a to-do list (N2) ─── */}
            <PathTo100 compact />

            {/* ── Priority assets (critical / high value / by volume) ───── */}
            <PriorityAssetsCard navigate={navigate} />

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

            {/* ── Compliance by site ─────────────────────────────────────── */}
            {bySite.length > 0 && (
              <div className="card" style={{ marginBottom: 20 }}>
                <div className="card-header">
                  <div>
                    <div className="card-title">Compliance by site</div>
                    <div className="card-subtitle">
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
