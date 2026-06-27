// ─────────────────────────────────────────────────────────────────────────────
// AlertsPage.jsx — ServiceCycle maintenance alert feed.
//
// GET  /api/alerts                → { alerts, count } (open pending|sent alerts)
// POST /api/alerts/:id/acknowledge
//
// Alert rows are produced by the server alert engine. leadDays encodes the
// tier: positive (180/120/90/60/30/7) = lead alert, negative (-1/-7/-30/-90)
// = overdue/escalation/breach tier. Per-user email preferences live in
// Settings → Alerts (GET/PUT /api/alerts/preferences).
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { X as XIcon } from 'lucide-react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
} from '@tanstack/react-table';
import { kbdActivate } from '../lib/a11y';
import api from '../api/client';
import ColumnPicker from '../components/ColumnPicker';
import ColumnFilterInput from '../components/ColumnFilterInput';
import ColumnDateRangeButton from '../components/ColumnDateRangeButton';
import SavedViewsMenu from '../components/SavedViewsMenu';
import { useUserPreference } from '../hooks/useUserPreference';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useFromState } from '../components/BackLink';
import {
  ALERTS_COLUMNS,
  ALERTS_VISIBILITY_KEY,
  ALERT_TYPE_LABELS,
  defaultAlertsVisibility,
} from '../tables/alertsColumns.jsx';

const ALERTS_SAVED_VIEWS_KEY = 'servicecycle:alerts-list:saved-views';

// UX-9-2: page the high-volume alert feed so items beyond the cap stay reachable.
// The server (routes/alerts.ts) supports page/limit and returns a numeric `count`
// total plus a `pagination` envelope.
const ALERTS_PAGE_SIZE = 50;

const DEFAULT_SORTING = [{ id: 'tier', desc: false }];

const TYPE_FILTER_CHIPS = [
  { id: 'all',               label: 'All',               matches: () => true },
  { id: 'maintenance_due',   label: 'Maintenance Due',   matches: t => t === 'maintenance_due' },
  { id: 'overdue',           label: 'Overdue',           matches: t => t === 'overdue' },
  { id: 'escalation',        label: 'Escalation',        matches: t => t === 'escalation' },
  { id: 'regulatory_breach', label: 'Regulatory Breach', matches: t => t === 'regulatory_breach' },
];

export default function AlertsPage() {
  useDocumentTitle('Alerts');
  const [alerts, setAlerts]   = useState([]);
  // serverTotal: the TRUE open-alert count (matches the sidebar bell). May
  // exceed alerts.length when more than one page exists — CUST-8-1.
  const [serverTotal, setServerTotal] = useState(0);
  // UX-9-2: server-side pagination state.
  const [page, setPage]           = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const navigate = useNavigate();
  const fromState = useFromState();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();

  const [columnVisibility, setColumnVisibility] = useUserPreference(
    'alerts.columnVisibility',
    defaultAlertsVisibility()
  );
  const setColumnVisibilityState = setColumnVisibility;

  const [columnFilters, setColumnFilters] = useState(() => {
    const init = [];
    for (const col of ALERTS_COLUMNS) {
      if (!col.meta?.filterType) continue;
      const raw = searchParams.get('f_' + col.id);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed != null) init.push({ id: col.id, value: parsed });
      } catch { /* malformed param, skip */ }
    }
    return init;
  });

  const [activeChip, setActiveChip] = useState(() => {
    const c = searchParams.get('chip');
    if (c && TYPE_FILTER_CHIPS.some(x => x.id === c)) return c;
    return 'all';
  });
  const [sorting, setSorting] = useState(DEFAULT_SORTING);

  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== ALERTS_VISIBILITY_KEY || !e.newValue) return;
      try {
        const parsed = JSON.parse(e.newValue);
        if (parsed && typeof parsed === 'object') setColumnVisibilityState(parsed);
      } catch { /* ignore */ }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync columnFilters -> URL (f_<columnId>=<JSON>)
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const allFilterKeys = ALERTS_COLUMNS
      .filter(col => col.meta?.filterType)
      .map(col => 'f_' + col.id);
    for (const k of allFilterKeys) next.delete(k);
    for (const f of columnFilters) {
      const val = f?.value;
      if (val == null || val === '') continue;
      const isEmptyRange = typeof val === 'object' && val !== null && !val.from && !val.to;
      if (isEmptyRange) continue;
      next.set('f_' + f.id, JSON.stringify(val));
    }
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true, state: location.state });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnFilters]);

  // Sync chip -> URL (?chip=<id>)
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (activeChip && activeChip !== 'all') {
      next.set('chip', activeChip);
    } else {
      next.delete('chip');
    }
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true, state: location.state });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChip]);

  // Sync URL chip param -> activeChip (handles navigate-in while mounted)
  useEffect(() => {
    const c = searchParams.get('chip');
    const resolved = (c && TYPE_FILTER_CHIPS.some(x => x.id === c)) ? c : 'all';
    setActiveChip(prev => prev === resolved ? prev : resolved);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const fetchAlerts = (pageNum = page) => {
    setLoading(true);
    // UX-9-2: pull one page at a time (server caps at 500/page; we request
    // ALERTS_PAGE_SIZE). `count` is the true open-alert total — used to
    // reconcile the header and the sidebar bell; `pagination.pages` drives the
    // prev/next controls.
    api.get('/api/alerts', { params: { page: pageNum, limit: ALERTS_PAGE_SIZE } })
      .then(r => {
        const d = r.data.data || {};
        const list = Array.isArray(d.alerts) ? d.alerts : [];
        setAlerts(list);
        setServerTotal(typeof d.count === 'number' ? d.count : list.length);
        setTotalPages(d.pagination?.pages ?? 1);
      })
      .catch(() => setError('Failed to load alerts.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchAlerts(page); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [page]);

  async function acknowledge(id) {
    try {
      await api.post(`/api/alerts/${id}/acknowledge`);
      setAlerts(prev => prev.filter(a => a.id !== id));
      // Keep the true total (and the implied bell) in step with the removal.
      setServerTotal(t => Math.max(0, t - 1));
    } catch {
      setError('Failed to acknowledge alert.');
    }
  }

  const counts = useMemo(() => {
    const c = { all: alerts.length };
    for (const chip of TYPE_FILTER_CHIPS) {
      if (chip.id === 'all') continue;
      c[chip.id] = alerts.filter(a => chip.matches(a.alertType)).length;
    }
    return c;
  }, [alerts]);

  const chipFilteredRows = useMemo(() => {
    const chip = TYPE_FILTER_CHIPS.find(c => c.id === activeChip) || TYPE_FILTER_CHIPS[0];
    return alerts.filter(a => chip.matches(a.alertType));
  }, [alerts, activeChip]);

  const table = useReactTable({
    data:    chipFilteredRows,
    columns: ALERTS_COLUMNS,
    state:   { columnVisibility, columnFilters, sorting },
    onColumnFiltersChange: setColumnFilters,
    onSortingChange: setSorting,
    getCoreRowModel:     getCoreRowModel(),
    getSortedRowModel:   getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const rows    = table.getRowModel().rows;

  // totalCount drives the "X items need attention" header and the empty-state
  // copy; use the server's true total so it reconciles with the sidebar bell
  // even when only the current page is loaded (CUST-8-1).
  const loadedCount   = alerts.length;
  const totalCount    = Math.max(serverTotal, loadedCount);
  // UX-9-2: 1-based range of the alerts shown on the current page.
  const rangeStart    = loadedCount === 0 ? 0 : (page - 1) * ALERTS_PAGE_SIZE + 1;
  const rangeEnd      = (page - 1) * ALERTS_PAGE_SIZE + loadedCount;
  const filteredCount = rows.length;
  const hasColumnFilters = columnFilters.length > 0;
  const hasAnyFilters    = hasColumnFilters || activeChip !== 'all';

  const currentViewState = useMemo(() => ({
    activeChip, columnFilters, columnVisibility, sorting,
  }), [activeChip, columnFilters, columnVisibility, sorting]);

  const applyView = (state) => {
    if (!state || typeof state !== 'object') return;
    if (typeof state.activeChip === 'string') setActiveChip(state.activeChip);
    if (Array.isArray(state.columnFilters))   setColumnFilters(state.columnFilters);
    if (state.columnVisibility && typeof state.columnVisibility === 'object') {
      setColumnVisibility(state.columnVisibility);
    }
    if (Array.isArray(state.sorting) && state.sorting.length > 0) setSorting(state.sorting);
    else setSorting(DEFAULT_SORTING);
  };

  const clearAllFilters = useCallback(() => {
    setColumnFilters([]);
    setActiveChip('all');
  }, []);

  function renderSortableHeader(header) {
    const meta = header.column.columnDef.meta || {};
    const thStyle = meta.alignRight ? { textAlign: 'right' } : undefined;
    const isSorted = header.column.getIsSorted();
    const ariaSort = isSorted === 'asc' ? 'ascending' : isSorted === 'desc' ? 'descending' : 'none';
    const label = typeof header.column.columnDef.header === 'string'
      ? header.column.columnDef.header
      : flexRender(header.column.columnDef.header, header.getContext());
    return (
      <th
        key={header.id}
        className={`sortable${isSorted ? ' sorted' : ''}`}
        aria-sort={ariaSort}
        style={thStyle}
      >
        <button
          type="button"
          onClick={header.column.getToggleSortingHandler()}
          className="th-sort-button"
          style={{
            all: 'unset', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 4,
            width: '100%', justifyContent: meta.alignRight ? 'flex-end' : 'flex-start',
          }}
        >
          {label}
          {isSorted && <span className="sort-icon" aria-hidden="true">{isSorted === 'asc' ? '↑' : '↓'}</span>}
          <span className="sr-only">
            {isSorted ? `(sorted ${isSorted === 'asc' ? 'ascending' : 'descending'})` : ', sortable'}
          </span>
        </button>
      </th>
    );
  }

  function renderFilterCell(header) {
    const meta = header.column.columnDef.meta || {};
    if (!meta.filterType) {
      return <th key={`f-${header.id}`} style={{ padding: '4px 6px' }} />;
    }
    const value = header.column.getFilterValue();
    const onChange = (v) => header.column.setFilterValue(v);
    let inner = null;
    if (meta.filterType === 'daterange') {
      inner = (
        <ColumnDateRangeButton
          label={meta.label}
          value={value}
          onChange={onChange}
        />
      );
    } else {
      inner = (
        <ColumnFilterInput
          type={meta.filterType}
          value={value}
          onChange={onChange}
          label={meta.label}
          alignRight={meta.alignRight}
        />
      );
    }
    return (
      <th key={`f-${header.id}`} style={{ padding: '4px 6px', fontWeight: 400, overflow: 'visible' }}>
        {inner}
      </th>
    );
  }

  return (
    <>
      <div className="page-header">
        <div>
          {location.state?.from === 'dashboard' && (
            <button type="button" onClick={() => navigate('/dashboard')} style={{ background: 'none', border: 'none', padding: 0, marginBottom: 4, color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }} aria-label="Back to dashboard">
              {String.fromCharCode(8592)} Dashboard
            </button>
          )}
          <h1 className="page-title">Alerts</h1>
          <div className="page-subtitle">
            {loading
              ? 'Loading…'
              : totalCount === 0
                ? 'All clear — no maintenance items need attention right now'
                : `${totalCount} item${totalCount !== 1 ? 's' : ''} need attention`}
            {hasAnyFilters && !loading && totalCount > 0 && (
              <>
                {' · '}
                <span style={{ color: 'var(--color-warning)', fontWeight: 600 }}>
                  {columnFilters.length} column filter{columnFilters.length !== 1 ? 's' : ''}
                  {activeChip !== 'all' ? ` + ${TYPE_FILTER_CHIPS.find(c => c.id === activeChip)?.label || ''} chip` : ''}
                </span>
                {' '}active ·{' '}
                <button
                  type="button"
                  onClick={clearAllFilters}
                  style={{
                    all: 'unset', cursor: 'pointer',
                    color: 'var(--color-primary)', textDecoration: 'underline',
                    fontSize: 'inherit',
                  }}
                >
                  Clear
                </button>
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={clearAllFilters}
            disabled={!hasAnyFilters}
            title={hasAnyFilters
              ? 'Clear the chip selection + every per-column filter'
              : 'No filters to clear'}
            style={hasAnyFilters ? {
              background: 'var(--color-warning-bg)',
              color: 'var(--color-warning)',
              borderColor: 'var(--color-warning)',
              fontWeight: 600,
              whiteSpace: 'nowrap',
            } : { whiteSpace: 'nowrap' }}
          >
            <XIcon size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            Clear all filters
          </button>
          <SavedViewsMenu
            storageKey={ALERTS_SAVED_VIEWS_KEY}
            currentState={currentViewState}
            onApply={applyView}
          />
          <ColumnPicker
            columns={ALERTS_COLUMNS}
            visibility={columnVisibility}
            onChange={setColumnVisibility}
            defaults={defaultAlertsVisibility()}
          />
        </div>
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}
        {loading && <div className="loading">Loading alerts…</div>}

        {!loading && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
              {TYPE_FILTER_CHIPS.map(chip => {
                const active = activeChip === chip.id;
                const count  = counts[chip.id] ?? 0;
                if (chip.id !== 'all' && count === 0) return null;
                return (
                  <button
                    key={chip.id}
                    type="button"
                    onClick={() => setActiveChip(chip.id)}
                    className="btn btn-secondary btn-sm"
                    style={{
                      background:  active ? 'var(--color-primary)' : undefined,
                      color:       active ? 'var(--color-on-primary, white)' : undefined,
                      borderColor: active ? 'var(--color-primary)' : undefined,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {chip.label}
                    {count > 0 && <span style={{ marginLeft: 6, opacity: active ? 1 : 0.65 }}>{count}</span>}
                  </button>
                );
              })}
            </div>

            <div className="card">
              {chipFilteredRows.length === 0 ? (
                <div style={{ padding: '40px 32px', textAlign: 'center', maxWidth: 560, margin: '0 auto' }}>
                  <div style={{ fontSize: 36, marginBottom: 12 }}>✓</div>
                  <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
                    {totalCount === 0
                      ? 'All clear — nothing needs attention'
                      : `No ${TYPE_FILTER_CHIPS.find(c => c.id === activeChip)?.label || ''} alerts`}
                  </div>
                  <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                    {totalCount === 0
                      ? 'No maintenance tasks are coming due and nothing is overdue. The alert engine queues new alerts automatically as schedules cross their lead-day thresholds (180/120/90/60/30/7 days before due, then overdue tiers).'
                      : 'Try a different filter chip above or click "All" to see everything.'}
                  </div>
                </div>
              ) : (
                <div className="table-wrap">
                  <table style={{ tableLayout: 'fixed' }}>
                    <colgroup>
                      {headers.map(h => (
                        <col key={h.id} style={{ width: h.column.columnDef.meta?.widthPct }} />
                      ))}
                      <col style={{ width: '13%' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        {headers.map(h => renderSortableHeader(h))}
                        <th style={{ textAlign: 'right' }}>Actions</th>
                      </tr>
                      <tr>
                        {headers.map(h => renderFilterCell(h))}
                        <th style={{ padding: '4px 6px' }} />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr>
                          <td colSpan={headers.length + 1} style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
                            No alerts match the active column filters.{' '}
                            <button
                              type="button"
                              onClick={() => setColumnFilters([])}
                              style={{ all: 'unset', cursor: 'pointer', color: 'var(--color-primary)', textDecoration: 'underline', fontWeight: 600 }}
                            >
                              Clear column filters
                            </button>
                          </td>
                        </tr>
                      ) : rows.map(row => {
                        const r = row.original;
                        const assetId = r.asset?.id;
                        return (
                          <tr
                            key={r.id}
                            style={{ cursor: assetId ? 'pointer' : 'default' }}
                            onClick={() => { if (assetId) navigate(`/assets/${assetId}`, { state: fromState }); }}
                            tabIndex={assetId ? 0 : -1}
                            onKeyDown={kbdActivate(assetId ? () => navigate(`/assets/${assetId}`, { state: fromState }) : null)}
                          >
                            {row.getVisibleCells().map(cell => {
                              const meta = cell.column.columnDef.meta || {};
                              const tdStyle = meta.alignRight ? { textAlign: 'right' } : undefined;
                              return (
                                <td key={cell.id} style={tdStyle}>
                                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                </td>
                              );
                            })}
                            <td
                              onClick={(e) => e.stopPropagation()}
                              style={{ textAlign: 'right' }}
                            >
                              <button
                                type="button"
                                onClick={() => acknowledge(r.id)}
                                className="btn btn-secondary btn-sm"
                                title={`Acknowledge this ${ALERT_TYPE_LABELS[r.alertType] || ''} alert`}
                              >
                                Acknowledge
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {hasColumnFilters && rows.length > 0 && filteredCount < chipFilteredRows.length && (
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 6, textAlign: 'right' }}>
                Showing {filteredCount} of {chipFilteredRows.length} (filtered by column)
              </div>
            )}

            {/* UX-9-2: server-side pager — items beyond one page stay reachable.
                The "of N" total is the server's true open-alert count (reconciles
                with the sidebar bell). */}
            {(totalPages > 1 || rangeEnd < totalCount) && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                  Showing {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of {totalCount.toLocaleString()} open alert{totalCount !== 1 ? 's' : ''}
                  {totalPages > 1 ? ` · page ${page} of ${totalPages}` : ''}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button" className="btn btn-secondary btn-sm"
                    disabled={page <= 1 || loading}
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                  >
                    {String.fromCharCode(8592)} Prev
                  </button>
                  <button
                    type="button" className="btn btn-secondary btn-sm"
                    disabled={page >= totalPages || loading}
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  >
                    Next {String.fromCharCode(8594)}
                  </button>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, paddingTop: 8 }}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
                style={{ width: 13, height: 13, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                <circle cx="8" cy="8" r="2.5"/>
                <path d="M8 1v2m0 10v2M1 8h2m10 0h2M3.05 3.05l1.41 1.41m7.08 7.08 1.41 1.41M3.05 12.95l1.41-1.41m7.08-7.08 1.41-1.41"/>
              </svg>
              <Link to="/settings?tab=alerts" style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', textDecoration: 'none' }}>
                Configure notification preferences in Settings
              </Link>
            </div>
          </>
        )}
      </div>
    </>
  );
}
