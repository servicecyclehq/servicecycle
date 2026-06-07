// ─────────────────────────────────────────────────────────────────────────────
// AlertsPage.jsx — v0.40 flat-table rewrite + Phase 2/3/4/5
//                  v0.56.0 canonical-pattern propagation from /contracts.
//
// v0.56.0 changes (propagating the /contracts canonical pattern):
//   • Excel-style ColumnFilterDropdown on Vendor + Product (multi-select
//     with typeahead + Excel narrowing). Type column intentionally keeps
//     the chip-row pattern — both surfaces would be redundant.
//   • ColumnDateRangeButton on Date (single-button popover replaces the
//     stacked from/to inputs).
//   • Server-side distinct values via GET /api/alerts/distinct/:column
//     with the same Excel-narrowing semantics as /contracts/distinct.
//   • URL-synced column-filter state via f_<columnId>=<JSON> keys (so
//     back-button + share-links round-trip). Chip selection also URL-
//     synced via ?chip=<id>.
//   • Clear-all-filters button promoted to the page header, amber
//     (warning) styling when any filter is active.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { Download, Mail, X as XIcon } from 'lucide-react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
} from '@tanstack/react-table';
import { kbdActivate } from '../lib/a11y';
import api from '../api/client';
import { downloadAuthedFile } from '../api/download';
import ColumnPicker from '../components/ColumnPicker';
import ColumnFilterInput from '../components/ColumnFilterInput';
import ColumnFilterDropdown from '../components/ColumnFilterDropdown';
import ColumnDateRangeButton from '../components/ColumnDateRangeButton';
import SavedViewsMenu from '../components/SavedViewsMenu';
import Toast from '../components/Toast';
import { useUserPreference } from '../hooks/useUserPreference';
import { useConfirm } from '../context/ConfirmContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  ALERTS_COLUMNS,
  ALERTS_VISIBILITY_KEY,
  defaultAlertsVisibility,
  daysUntil,
} from '../tables/alertsColumns.jsx';

const ALERTS_SAVED_VIEWS_KEY = 'lapseiq:alerts-list:saved-views';

const DEFAULT_SORTING = [{ id: 'daysUntil', desc: false }];

const TYPE_FILTER_CHIPS = [
  { id: 'all',         label: 'All',           matches: () => true },
  { id: 'cancel_by',   label: 'Cancel Window', matches: t => t === 'cancel_by' },
  { id: 'review_by',   label: 'Review Due',    matches: t => t === 'review_by' },
  { id: 'renewal',     label: 'Expiring',      matches: t => t === 'renewal' },
  { id: 'billing',     label: 'Billing',       matches: t => typeof t === 'string' && t.startsWith('billing_') },
  { id: 'payment_due', label: 'Payment Due',   matches: t => t === 'payment_due' },
];

function getRelevantDate(a) {
  if (a.alertType === 'cancel_by') return a.contract?.cancelByDate;
  if (a.alertType === 'review_by') return a.contract?.evaluationStartByDate;
  return a.contract?.endDate;
}

function columnFiltersToRecord(arr) {
  const out = {};
  for (const f of arr || []) {
    if (f && f.id != null && f.value != null) out[f.id] = f.value;
  }
  return out;
}

function appendColumnFilterParam(params, col, value) {
  const ft = col.meta?.filterType;
  const fp = col.meta?.filterParam;
  if (!ft || value == null) return;
  if (ft === 'multiselect' && Array.isArray(value) && value.length > 0) {
    if (typeof fp === 'string') params.set(fp, value.join(','));
  } else if (ft === 'daterange' && typeof value === 'object' && fp && typeof fp === 'object') {
    if (value.from) params.set(fp.from, value.from);
    if (value.to)   params.set(fp.to,   value.to);
  } else if (ft === 'numberrange' && typeof value === 'object' && fp && typeof fp === 'object') {
    if (value.min != null) params.set(fp.min, String(value.min));
    if (value.max != null) params.set(fp.max, String(value.max));
  } else if (ft === 'text' && typeof value === 'string' && value) {
    if (typeof fp === 'string') params.set(fp, value);
  }
}

// Build the URL query for /api/export/alerts mirroring the active client
// state. v0.56.0: now uses the generic column.filterParam meta so
// multi-select Vendor/Product round-trip as ?vendorIn=Adobe,Microsoft.
function buildAlertsExportParams({ activeChip, columnFilters, columnVisibility }) {
  const params = new URLSearchParams();
  if (activeChip && activeChip !== 'all') params.set('chip', activeChip);
  const record = columnFiltersToRecord(columnFilters);
  for (const col of ALERTS_COLUMNS) {
    const val = record[col.id];
    appendColumnFilterParam(params, col, val);
  }
  const visibleIds = ALERTS_COLUMNS.filter(c => columnVisibility[c.id] !== false).map(c => c.id);
  if (visibleIds.length > 0) params.set('columns', visibleIds.join(','));
  return params;
}

// Build the params used by /api/alerts/distinct/:column. Excel narrowing
// is achieved by EXCLUDING the requested column from the param set.
function buildAlertsDistinctParams({ activeChip, columnFilters, excludeColumnId }) {
  const params = new URLSearchParams();
  if (activeChip && activeChip !== 'all') params.set('chip', activeChip);
  const record = columnFiltersToRecord(columnFilters);
  for (const col of ALERTS_COLUMNS) {
    if (col.id === excludeColumnId) continue;
    const val = record[col.id];
    appendColumnFilterParam(params, col, val);
  }
  return params;
}

export default function AlertsPage() {
  useDocumentTitle('Alerts');
  const [derived, setDerived] = useState({ cancelUrgent: [], overdueReviews: [], expiringThisMonth: [] });
  const [alerts, setAlerts]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [exporting, setExporting] = useState(false);
  const [toast, setToast]     = useState(null);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();

  const [columnVisibility, setColumnVisibility] = useUserPreference(
    'alerts.columnVisibility',
    defaultAlertsVisibility()
  );
  const setColumnVisibilityState = setColumnVisibility;

  // v0.56.0: initial columnFilters seeded from URL `f_<columnId>=<JSON>` keys.
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
    const record = columnFiltersToRecord(columnFilters);
    for (const [id, val] of Object.entries(record)) {
      if (val == null || val === '') continue;
      const isEmptyArrayVal = Array.isArray(val) && val.length === 0;
      const isEmptyRangeVal = !Array.isArray(val) && typeof val === 'object' && val !== null
        && !val.from && !val.to && val.min == null && val.max == null;
      if (isEmptyArrayVal || isEmptyRangeVal) continue;
      next.set('f_' + id, JSON.stringify(val));
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

  // Sync URL chip param -> activeChip (handles navigate-in while component already mounted)
  useEffect(() => {
    const c = searchParams.get('chip');
    const resolved = (c && TYPE_FILTER_CHIPS.some(x => x.id === c)) ? c : 'all';
    setActiveChip(prev => prev === resolved ? prev : resolved);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Apply column filters passed via navigation state (e.g. dashboard drilldown)
  useEffect(() => {
    if (Array.isArray(location.state?.columnFilters) && location.state.columnFilters.length > 0) {
      setColumnFilters(location.state.columnFilters);
    }
  }, []); // mount only - intentionally ignores location.state changes

  const fetchAlerts = () => {
    setLoading(true);
    api.get('/api/alerts/all')
      .then(r => {
        const d = r.data.data || {};
        setDerived(d.derivedStates || { cancelUrgent: [], overdueReviews: [], expiringThisMonth: [] });
        setAlerts(d.persistedAlerts || []);
      })
      .catch(() => setError('Failed to load alerts.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchAlerts(); }, []);

  async function acknowledge(id) {
    await api.put(`/api/alerts/${id}/acknowledge`).catch(() => {});
    setAlerts(prev => prev.filter(a => a.id !== id));
  }

  async function acknowledgeAll() {
    await api.put('/api/alerts/acknowledge-all').catch(() => {});
    setAlerts([]);
  }

  const allRows = useMemo(() => {
    const out = [];
    for (const c of derived.cancelUrgent || []) {
      out.push({
        rowKey: `derived-cancel-${c.id}`, alertId: null, alertType: 'cancel_by',
        contract: c, relevantDate: c.cancelByDate, daysUntil: daysUntil(c.cancelByDate), isDerived: true,
      });
    }
    for (const c of derived.overdueReviews || []) {
      out.push({
        rowKey: `derived-review-${c.id}`, alertId: null, alertType: 'review_by',
        contract: c, relevantDate: c.evaluationStartByDate, daysUntil: daysUntil(c.evaluationStartByDate), isDerived: true,
      });
    }
    for (const c of derived.expiringThisMonth || []) {
      out.push({
        rowKey: `derived-expiring-${c.id}`, alertId: null, alertType: 'renewal',
        contract: c, relevantDate: c.endDate, daysUntil: daysUntil(c.endDate), isDerived: true,
      });
    }
    for (const a of alerts || []) {
      const rd = getRelevantDate(a);
      out.push({
        rowKey: `alert-${a.id}`, alertId: a.id, alertType: a.alertType,
        contract: a.contract, relevantDate: rd, daysUntil: daysUntil(rd), isDerived: false,
      });
    }
    return out;
  }, [derived, alerts]);

  const counts = useMemo(() => {
    const c = { all: allRows.length };
    for (const chip of TYPE_FILTER_CHIPS) {
      if (chip.id === 'all') continue;
      c[chip.id] = allRows.filter(r => chip.matches(r.alertType)).length;
    }
    return c;
  }, [allRows]);

  const chipFilteredRows = useMemo(() => {
    const chip = TYPE_FILTER_CHIPS.find(c => c.id === activeChip) || TYPE_FILTER_CHIPS[0];
    return allRows.filter(r => chip.matches(r.alertType));
  }, [allRows, activeChip]);

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

  const derivedTotal = (derived.cancelUrgent?.length ?? 0)
                     + (derived.overdueReviews?.length ?? 0)
                     + (derived.expiringThisMonth?.length ?? 0);
  const totalCount    = allRows.length;
  const filteredCount = rows.length;
  const queuedCount   = alerts.length;
  const hasColumnFilters = columnFilters.length > 0;
  const hasAnyFilters    = hasColumnFilters || activeChip !== 'all';

  // H2-6 (v0.76.3): bulk dismiss
  const confirm = useConfirm();
  const [selectedIds, setSelectedIds] = useState(new Set());
  // IDs of queued (non-derived) rows currently visible after all filters
  const queuedRowIds = useMemo(
    () => rows.filter(r => !r.original.isDerived && r.original.alertId).map(r => r.original.alertId),
    [rows],
  );
  async function handleDismissSelected() {
    await Promise.all([...selectedIds].map(id => acknowledge(id)));
    setSelectedIds(new Set());
  }

  // v0.56.0: server-side distinct fetcher with Excel narrowing.
  const fetchDistinctForAlertsColumn = useCallback(async (distinctColumn) => {
    const params = buildAlertsDistinctParams({
      activeChip,
      columnFilters,
      excludeColumnId: ALERTS_COLUMNS.find(c => c.meta?.distinctColumn === distinctColumn)?.id,
    });
    const url = '/api/alerts/distinct/' + distinctColumn + (params.toString() ? '?' + params.toString() : '');
    const res = await api.get(url);
    return res.data?.values || [];
  }, [activeChip, columnFilters]);

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

  async function handleExportView() {
    if (exporting) return;
    setExporting(true);
    setToast({ title: 'Preparing export…', message: 'Building your file — this may take a moment.', variant: 'info', duration: 5000 });
    try {
      const params = buildAlertsExportParams({ activeChip, columnFilters, columnVisibility });
      const url = `${import.meta.env.VITE_API_URL ?? ''}/api/export/alerts?${params}`;
      await downloadAuthedFile(url, `Alerts-${new Date().toISOString().split('T')[0]}.xlsx`);
      setToast({ title: 'Export ready', message: 'Your file is downloading.', variant: 'success', duration: 4000 });
    } catch (e) {
      setError(e.message || 'Export failed.');
      setToast(null);
    } finally {
      setExporting(false);
    }
  }

  async function handleEmailView() {
    if (exporting) return;
    setExporting(true);
    try {
      const params = buildAlertsExportParams({ activeChip, columnFilters, columnVisibility });
      const url = `${import.meta.env.VITE_API_URL ?? ''}/api/export/alerts?${params}`;
      setToast({ title: 'Preparing export…', message: 'Building your file — this may take a moment.', variant: 'info', duration: 5000 });
      const { filename } = await downloadAuthedFile(url, `Alerts-${new Date().toISOString().split('T')[0]}.xlsx`);
      const subject = `Alerts list — ${new Date().toISOString().split('T')[0]}`;
      const body =
        `Please find attached the alerts list (${filename}).\n\n` +
        `Drag the file from your Downloads folder onto this email to attach it ` +
        `(or find it in your Downloads folder).`;
      window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      setTimeout(() => {
        setToast({
          title: 'Email draft opened',
          message: `Your file (${filename}) is downloading. Find it in your Downloads folder, then drag it into your email draft to attach.`,
          variant: 'info',
          duration: 12000,
        });
      }, 200);
    } catch (e) {
      setError(e.message || 'Email export failed.');
    } finally {
      setExporting(false);
    }
  }

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

  // v0.56.0: per-column filter cell renderer.
  function renderFilterCell(header) {
    const meta = header.column.columnDef.meta || {};
    if (!meta.filterType) {
      return <th key={`f-${header.id}`} style={{ padding: '4px 6px' }} />;
    }
    const value = header.column.getFilterValue();
    const onChange = (v) => header.column.setFilterValue(v);
    let inner = null;
    if (meta.filterType === 'multiselect') {
      inner = (
        <ColumnFilterDropdown
          columnId={header.column.id}
          label={meta.label}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
          fetchDistinct={() => fetchDistinctForAlertsColumn(meta.distinctColumn || header.column.id)}
          formatValue={meta.formatValue}
        />
      );
    } else if (meta.filterType === 'daterange') {
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

  const BTN_ICON = { size: 14, strokeWidth: 1.75, style: { verticalAlign: '-2px', marginRight: 6 } };

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
                ? 'All clear — no contracts need attention right now'
                : `${totalCount} item${totalCount !== 1 ? 's' : ''} need attention` +
                  (derivedTotal > 0 && queuedCount > 0
                    ? ` (${derivedTotal} live · ${queuedCount} queued)`
                    : '')}
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
          {!loading && queuedCount > 0 && (
            <abbr
              title="Queued alerts activate automatically when the alert engine's next run crosses a threshold — no action needed now."
              style={{ cursor: 'help', fontSize: '0.8em', marginLeft: 4 }}
            >
              (queued?)
            </abbr>
          )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {/* v0.56.0: Clear-all-filters promoted to the page header, amber when active. */}
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
          {!loading && totalCount > 0 && (
            <>
              <button
                className="btn btn-secondary"
                onClick={handleExportView}
                disabled={exporting}
                title="Download an XLSX of the alerts currently visible (matches chip + column filters)"
              >
                <Download {...BTN_ICON} />{exporting ? 'Preparing export…' : 'Download view'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={handleEmailView}
                disabled={exporting}
                title="Download an XLSX and open your default mail client with a draft — drag the file from the download bar onto the draft to attach."
              >
                <Mail {...BTN_ICON} />Email view
              </button>
            </>
          )}
          {selectedIds.size > 0 && (
            <button className="btn btn-secondary" onClick={handleDismissSelected}>
              Dismiss selected ({selectedIds.size})
            </button>
          )}
          {queuedCount > 0 && (
            <button className="btn btn-secondary" onClick={async () => {
              const ok = await confirm({
                title: 'Dismiss all queued alerts?',
                body: `This will dismiss ${queuedCount} queued alert${queuedCount !== 1 ? 's' : ''}. This cannot be undone.`,
                confirmLabel: `Dismiss all (${queuedCount})`,
              });
              if (ok) { await acknowledgeAll(); setSelectedIds(new Set()); }
            }}>
              Dismiss all queued
            </button>
          )}
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
                      ? 'No cancel windows are opening, no review-by dates are overdue, and no contracts expire this month. Alerts queued by the nightly engine will appear here when thresholds are crossed.'
                      : 'Try a different filter chip above or click "All" to see everything.'}
                  </div>
                </div>
              ) : (
                <div className="table-wrap">
                  <table style={{ tableLayout: 'fixed' }}>
                    <colgroup>
                      <col style={{ width: 36, minWidth: 36 }} />
                      {headers.map(h => (
                        <col key={h.id} style={{ width: h.column.columnDef.meta?.widthPct }} />
                      ))}
                      <col style={{ width: '14%' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th style={{ width: 36, paddingLeft: 8, paddingRight: 4 }}>
                          <input
                            type="checkbox"
                            checked={queuedRowIds.length > 0 && queuedRowIds.every(id => selectedIds.has(id))}
                            onChange={e => setSelectedIds(e.target.checked ? new Set(queuedRowIds) : new Set())}
                            disabled={queuedRowIds.length === 0}
                            aria-label="Select all queued alerts"
                          />
                        </th>
                        {headers.map(h => renderSortableHeader(h))}
                        <th style={{ textAlign: 'right' }}>Actions</th>
                      </tr>
                      <tr>
                        <th style={{ padding: '4px 6px' }} />
                        {headers.map(h => renderFilterCell(h))}
                        <th style={{ padding: '4px 6px' }} />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr>
                          <td colSpan={headers.length + 2} style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
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
                        const contractId = r.contract?.id;
                        return (
                          <tr
                            key={r.rowKey}
                            style={{ cursor: contractId ? 'pointer' : 'default' }}
                            onClick={() => { if (contractId) navigate(`/contracts/${contractId}`); }}
                            tabIndex={contractId ? 0 : -1}
                            onKeyDown={kbdActivate(contractId ? () => navigate(`/contracts/${contractId}`) : null)}
                          >
                            <td
                              onClick={e => e.stopPropagation()}
                              style={{ paddingLeft: 8, paddingRight: 4, verticalAlign: 'middle' }}
                            >
                              {!r.isDerived && r.alertId && (
                                <input
                                  type="checkbox"
                                  checked={selectedIds.has(r.alertId)}
                                  onChange={e => {
                                    const next = new Set(selectedIds);
                                    if (e.target.checked) next.add(r.alertId); else next.delete(r.alertId);
                                    setSelectedIds(next);
                                  }}
                                  onClick={e => e.stopPropagation()}
                                  aria-label="Select for bulk dismiss"
                                />
                              )}
                            </td>
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
                              {r.isDerived ? (
                                <span className="text-muted" style={{ fontSize: 'var(--font-size-sm)' }}>
                                  Queued — no action yet
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => acknowledge(r.alertId)}
                                  className="btn btn-secondary btn-sm"
                                >
                                  Dismiss
                                </button>
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

            {hasColumnFilters && rows.length > 0 && filteredCount < chipFilteredRows.length && (
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 6, textAlign: 'right' }}>
                Showing {filteredCount} of {chipFilteredRows.length} (filtered by column)
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, paddingTop: 8 }}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
                style={{ width: 13, height: 13, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                <circle cx="8" cy="8" r="2.5"/>
                <path d="M8 1v2m0 10v2M1 8h2m10 0h2M3.05 3.05l1.41 1.41m7.08 7.08 1.41 1.41M3.05 12.95l1.41-1.41m7.08-7.08 1.41-1.41"/>
              </svg>
              <Link to="/settings" style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', textDecoration: 'none' }}>
                Configure notification preferences in Settings
              </Link>
            </div>
          </>
        )}
      </div>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
