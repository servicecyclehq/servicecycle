// ─────────────────────────────────────────────────────────────────────────────
// ComplianceCalendar.jsx — month-by-month maintenance agenda.
//
// GET /api/dashboard/calendar?from=YYYY-MM&months=3&siteId= →
// data { schedules, blackouts, range }. Three months render as day-grouped
// agenda lists; blackout windows render as banner rows in every month they
// overlap ('Planned outage window' = green-ish, 'Work freeze' = red-ish).
// Prev/next shift the window by 3 months; the site filter persists per user
// in localStorage (servicecycle_ prefix).
//
// B5 (2026-06-11): ?due=30|60|90|overdue switches to "due window" mode — the
// dashboard KPI tiles deep-link here and the page shows exactly the set the
// tile counted (same predicate as server routes/dashboard.ts dueCounts:
// now ≤ nextDueDate ≤ now+N days, or nextDueDate < now for overdue; active
// schedules on unarchived assets only — the endpoint already enforces that).
// A banner names the active filter and offers "Show full calendar" to clear.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarDays, ShieldCheck } from 'lucide-react';
import api from '../api/client';
import EmptyState from '../components/EmptyState';
import { useFromState } from '../components/BackLink';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { assetLabel, fmtDate } from '../lib/equipment';

const MONTHS_SHOWN = 3;
const SITE_FILTER_KEY = 'servicecycle_calendar_site';
const DAY_MS = 86_400_000;
// ?due= values the dashboard tiles use → forward-window length in days.
const DUE_WINDOW_DAYS = { 30: 30, 60: 60, 90: 90 };

function ymOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function ymToDate(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1);
}
function shiftYm(ym, deltaMonths) {
  const d = ymToDate(ym);
  d.setMonth(d.getMonth() + deltaMonths);
  return ymOf(d);
}
function monthLabel(d) {
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
function dayLabel(d) {
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtDateTimeShort(d) {
  return new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Group schedules by calendar day → sorted [{ date, items }].
function groupByDay(items) {
  const byDay = new Map();
  for (const s of items) {
    if (!s.nextDueDate) continue;
    const d = new Date(s.nextDueDate);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!byDay.has(key)) byDay.set(key, { date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), items: [] });
    byDay.get(key).items.push(s);
  }
  return [...byDay.values()].sort((a, b) => a.date - b.date);
}

function OutageBadge() {
  return (
    <span
      title="This task requires a planned outage"
      style={{
        marginLeft: 6, fontSize: 'var(--font-size-2xs)', fontWeight: 700,
        padding: '1px 6px', borderRadius: 999, whiteSpace: 'nowrap',
        background: 'var(--color-warning-bg, rgba(245,158,11,0.12))',
        color: 'var(--color-warning, #b45309)',
      }}
    >
      OUTAGE
    </span>
  );
}

function BlackoutBanner({ w }) {
  const isOutage = !!w.isOutageWindow;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      padding: '8px 12px', borderRadius: 'var(--radius)', marginBottom: 8,
      background: isOutage ? 'var(--color-success-bg, rgba(34,197,94,0.10))' : 'var(--color-danger-bg, rgba(220,38,38,0.08))',
      border: `1px solid ${isOutage ? 'var(--color-success, #15803d)' : 'var(--color-danger, #dc2626)'}`,
    }}>
      <span style={{
        fontSize: 'var(--font-size-xs)', fontWeight: 700, whiteSpace: 'nowrap',
        color: isOutage ? 'var(--color-success, #15803d)' : 'var(--color-danger, #dc2626)',
      }}>
        {isOutage ? 'Planned outage window' : 'Work freeze'}
      </span>
      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
        {w.site?.name ? `${w.site.name} · ` : ''}
        {fmtDateTimeShort(w.startsAt)} {String.fromCharCode(8594)} {fmtDateTimeShort(w.endsAt)}
        {w.reason ? ` · ${w.reason}` : ''}
      </span>
    </div>
  );
}

// One day group: weekday header + schedule rows. Shared between the normal
// month cards and the B5 due-window list. fromState (C1) makes the asset
// links record this page — incl. its active ?due filter — as their origin.
function DayGroup({ day, now, fromState }) {
  const isOverdueDay = day.date < new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{
        fontSize: 'var(--font-size-xs)', fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.04em', padding: '4px 0',
        color: isOverdueDay ? 'var(--color-danger)' : 'var(--color-text-secondary)',
        borderBottom: '1px solid var(--color-border)',
      }}>
        {dayLabel(day.date)}
        {isOverdueDay && ' · OVERDUE'}
      </div>
      {day.items.map(s => {
        const overdue = s.nextDueDate && new Date(s.nextDueDate) < now;
        return (
          <div
            key={s.id}
            style={{
              display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
              padding: '7px 4px', borderBottom: '1px solid var(--color-border)',
            }}
          >
            <Link
              to={`/assets/${s.asset?.id}`}
              state={fromState}
              style={{
                fontWeight: 600, textDecoration: 'none',
                color: overdue ? 'var(--color-danger)' : 'var(--color-primary)',
              }}
            >
              {assetLabel(s.asset)}
            </Link>
            <span style={{ fontSize: 'var(--font-size-sm)' }}>
              {s.taskDefinition?.taskName || 'Maintenance task'}
              {s.taskDefinition?.requiresOutage && <OutageBadge />}
            </span>
            {s.taskDefinition?.standardRef && (
              <span className="text-muted" style={{ fontSize: 'var(--font-size-xs)' }}>
                {s.taskDefinition.standardRef}
              </span>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
              {s.asset?.site?.name || '—'}
              {overdue && (
                <span style={{ color: 'var(--color-danger)', fontWeight: 700, marginLeft: 8 }}>
                  due {fmtDate(s.nextDueDate)}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function ComplianceCalendar() {
  useDocumentTitle('Compliance calendar');
  const fromState = useFromState();

  // B5: ?due=30|60|90|overdue → due-window mode (dashboard tile drill-down).
  const [searchParams, setSearchParams] = useSearchParams();
  const dueParam = searchParams.get('due');
  const dueDays = DUE_WINDOW_DAYS[dueParam] || null;
  const dueMode = dueDays ? 'window' : dueParam === 'overdue' ? 'overdue' : null;

  // Initial month: honor a ?from=YYYY-MM deep-link (e.g. the dashboard's
  // 36-month maintenance-horizon strip links here per-month); fall back to
  // the current month. Read once on mount — in-page navigation still goes
  // through setFrom (Prev/Next buttons).
  const [from, setFrom] = useState(() => {
    try {
      const q = new URLSearchParams(window.location.search).get('from');
      if (q && /^\d{4}-\d{2}$/.test(q)) return q;
    } catch { /* ignore — fall back to current month */ }
    return ymOf(new Date());
  });
  // Site filter persists per user — EXCEPT when arriving on a ?due deep-link:
  // the dashboard numbers are account-wide, so the filtered list must start
  // account-wide too or the counts wouldn't match the tile.
  const [siteId, setSiteId] = useState(() => {
    try {
      if (new URLSearchParams(window.location.search).get('due')) return '';
      return localStorage.getItem(SITE_FILTER_KEY) || '';
    } catch { return ''; }
  });
  const [sites, setSites] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [blackouts, setBlackouts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/sites')
      .then(r => setSites(r.data?.data?.sites || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (dueMode) return; // don't let a tile drill-down overwrite the sticky site
    try {
      if (siteId) localStorage.setItem(SITE_FILTER_KEY, siteId);
      else localStorage.removeItem(SITE_FILTER_KEY);
    } catch { /* storage unavailable — filter just won't persist */ }
  }, [siteId, dueMode]);

  useEffect(() => {
    setLoading(true);
    setError('');
    // Due-window mode fetches its own range; the endpoint buckets by whole
    // months, so over-fetch and apply the exact day predicate client-side.
    let fetchFrom = from;
    let months = MONTHS_SHOWN;
    if (dueMode === 'window') {
      const now = new Date();
      const end = new Date(now.getTime() + dueDays * DAY_MS);
      fetchFrom = ymOf(now);
      months = (end.getFullYear() - now.getFullYear()) * 12 + (end.getMonth() - now.getMonth()) + 1;
    } else if (dueMode === 'overdue') {
      // Server caps months at 36 — look back 35 months plus the current one.
      // (An item overdue for 3+ years would fall outside this window.)
      fetchFrom = shiftYm(ymOf(new Date()), -35);
      months = 36;
    }
    const params = { from: fetchFrom, months };
    if (siteId) params.siteId = siteId;
    api.get('/api/dashboard/calendar', { params })
      .then(r => {
        const d = r.data?.data || {};
        setSchedules(d.schedules || []);
        setBlackouts(d.blackouts || []);
      })
      .catch(() => setError('Failed to load calendar.'))
      .finally(() => setLoading(false));
  }, [from, siteId, dueMode, dueDays]);

  const now = new Date();
  const nowT = now.getTime();
  const startDate = ymToDate(from);

  // ── B5 due-window mode: exact dashboard-tile predicate ────────────────────
  const dueFiltered = dueMode
    ? schedules.filter(s => {
        const t = s.nextDueDate ? new Date(s.nextDueDate).getTime() : NaN;
        if (Number.isNaN(t)) return false;
        return dueMode === 'overdue' ? t < nowT : t >= nowT && t <= nowT + dueDays * DAY_MS;
      })
    : null;
  const dueTitle = dueMode === 'overdue' ? 'Overdue maintenance' : `Due within ${dueDays} days`;

  // ── Normal mode: build the three month buckets client-side ────────────────
  const months = [];
  if (!dueMode) {
    for (let i = 0; i < MONTHS_SHOWN; i++) {
      const mStart = new Date(startDate.getFullYear(), startDate.getMonth() + i, 1);
      const mEnd = new Date(startDate.getFullYear(), startDate.getMonth() + i + 1, 1);

      const monthSchedules = schedules.filter(s => {
        const d = s.nextDueDate ? new Date(s.nextDueDate) : null;
        return d && d >= mStart && d < mEnd;
      });
      const days = groupByDay(monthSchedules);

      const monthBlackouts = blackouts.filter(w =>
        new Date(w.startsAt) < mEnd && new Date(w.endsAt) > mStart
      );

      months.push({ start: mStart, days, blackouts: monthBlackouts, count: monthSchedules.length });
    }
  }

  const totalCount = dueMode ? dueFiltered.length : months.reduce((acc, m) => acc + m.count, 0);
  const rangeLabel = dueMode
    ? (dueMode === 'overdue' ? 'past due' : `next ${dueDays} days`)
    : `${monthLabel(months[0]?.start || startDate)} – ${monthLabel(months[MONTHS_SHOWN - 1]?.start || startDate)}`;

  const clearDueFilter = () => {
    setSearchParams(prev => {
      const p = new URLSearchParams(prev);
      p.delete('due');
      return p;
    }, { replace: true });
    setFrom(ymOf(new Date()));
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Compliance calendar</h1>
          <div className="page-subtitle">
            {loading ? 'Loading…' : `${totalCount} maintenance task${totalCount !== 1 ? 's' : ''} due · ${rangeLabel}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <select
            className="form-control"
            value={siteId}
            onChange={e => setSiteId(e.target.value)}
            aria-label="Filter by site"
          >
            <option value="">All sites</option>
            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {!dueMode && (
            <>
              <button className="btn btn-secondary" onClick={() => setFrom(f => shiftYm(f, -MONTHS_SHOWN))}>
                {String.fromCharCode(8592)} Prev
              </button>
              <button className="btn btn-secondary" onClick={() => setFrom(ymOf(new Date()))}>
                Today
              </button>
              <button className="btn btn-secondary" onClick={() => setFrom(f => shiftYm(f, MONTHS_SHOWN))}>
                Next {String.fromCharCode(8594)}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        {/* ── B5: active drill-down filter banner + clear affordance ───────── */}
        {dueMode && (
          <div
            className="alert alert-info"
            style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
          >
            <span>
              <strong>Filtered: {dueTitle.toLowerCase()}</strong>
              {!loading && <> — {totalCount} task{totalCount !== 1 ? 's' : ''}{siteId ? ' at this site' : ''}.</>}
              {!siteId && ' Matches the dashboard tile count.'}
            </span>
            <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={clearDueFilter}>
              Show full calendar
            </button>
          </div>
        )}

        {loading && <div className="loading">Loading calendar…</div>}

        {/* ── B5 due-window list ────────────────────────────────────────────── */}
        {!loading && dueMode && (
          dueFiltered.length === 0 ? (
            <div className="card">
              <EmptyState
                icon={dueMode === 'overdue' ? ShieldCheck : CalendarDays}
                title={dueMode === 'overdue' ? 'Nothing overdue' : `Nothing due in the ${rangeLabel}`}
                sub={dueMode === 'overdue'
                  ? 'Every active maintenance schedule is current. Clear the filter to see the full calendar.'
                  : 'No active maintenance schedules fall due in this window. Clear the filter to browse the full calendar.'}
              />
            </div>
          ) : (
            <div className="card" style={{ marginBottom: 20 }}>
              <div className="card-header">
                <div className="card-title">{dueTitle}</div>
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                  {dueFiltered.length} task{dueFiltered.length !== 1 ? 's' : ''}
                </span>
              </div>
              <div style={{ padding: '12px 20px 16px' }}>
                {groupByDay(dueFiltered).map(day => (
                  <DayGroup key={day.date.toISOString()} day={day} now={now} fromState={fromState} />
                ))}
              </div>
            </div>
          )
        )}

        {/* ── Normal month-by-month agenda ──────────────────────────────────── */}
        {!loading && !dueMode && totalCount === 0 && blackouts.length === 0 && !error && (
          <div className="card">
            <EmptyState
              icon={CalendarDays}
              title="Nothing scheduled in this window"
              sub={siteId
                ? 'No maintenance is due at this site in the selected months. Try another site or shift the window.'
                : 'No maintenance schedules fall due in the selected months. Use Prev/Next to look further out, or apply NFPA 70B task sets to your assets.'}
            />
          </div>
        )}

        {!loading && !dueMode && (totalCount > 0 || blackouts.length > 0) && months.map((m, idx) => (
          <div className="card" key={idx} style={{ marginBottom: 20 }}>
            <div className="card-header">
              <div className="card-title">{monthLabel(m.start)}</div>
              <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                {m.count} task{m.count !== 1 ? 's' : ''} due
              </span>
            </div>
            <div style={{ padding: '12px 20px 16px' }}>
              {m.blackouts.map(w => <BlackoutBanner key={w.id} w={w} />)}

              {m.days.length === 0 ? (
                <div style={{ padding: '8px 0', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
                  No maintenance due this month
                </div>
              ) : (
                m.days.map(day => (
                  <DayGroup key={day.date.toISOString()} day={day} now={now} fromState={fromState} />
                ))
              )}
            </div>
          </div>
        ))}

        {!loading && !dueMode && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginBottom: 24 }}>
            <button className="btn btn-secondary" onClick={() => setFrom(f => shiftYm(f, -MONTHS_SHOWN))}>
              {String.fromCharCode(8592)} Previous {MONTHS_SHOWN} months
            </button>
            <button className="btn btn-secondary" onClick={() => setFrom(f => shiftYm(f, MONTHS_SHOWN))}>
              Next {MONTHS_SHOWN} months {String.fromCharCode(8594)}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
