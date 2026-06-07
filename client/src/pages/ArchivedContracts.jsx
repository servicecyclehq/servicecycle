// ─────────────────────────────────────────────────────────────────────────────
// ArchivedContracts.jsx — v0.70.2 canonical-pattern propagation
//
// Inherits the /contracts canonical list-page pattern (per
// docs/design/list-page-canonical-pattern.md Section 4.4):
//   • Excel-style ColumnFilterDropdown on Vendor + Status + Owner
//   • numberrange filter on Value
//   • ColumnDateRangeButton on End Date + Archived
//   • TanStack table with getFilteredRowModel (client-side filtering)
//   • URL-synced filter state via f_<columnId>=<JSON> keys
//   • Cross-device saved views via useUserPreference
//   • Cross-device column visibility via useUserPreference
//   • Clear-all-filters in page header, amber when active
//
// Archives are inherently bounded (rarely >100 per account), so the page
// loads up to 500 rows in one shot and filters/paginates client-side.
// Matches the alerts decision in canonical-doc Section 4.1 — no bootstrap
// or distinct endpoint needed.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Archive, Search, Download, Mail, Upload } from 'lucide-react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
} from '@tanstack/react-table';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { CsvImportModal } from './ContractsList';
import { useConfirm } from '../context/ConfirmContext';
import { useUserPreference } from '../hooks/useUserPreference';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import EmptyState from '../components/EmptyState';
import ColumnPicker from '../components/ColumnPicker';
import ActionDropdown from '../components/ActionDropdown';
import Toast from '../components/Toast';
import { downloadAuthedFile } from '../api/download';
import ColumnFilterInput from '../components/ColumnFilterInput';
import ColumnFilterDropdown from '../components/ColumnFilterDropdown';
import ColumnDateRangeButton from '../components/ColumnDateRangeButton';
import SavedViewsMenu from '../components/SavedViewsMenu';
import {
  ARCHIVED_COLUMNS,
  defaultArchivedVisibility,
  BLANK_SENTINEL,
} from '../tables/archivedColumns.jsx';

const ARCHIVED_SAVED_VIEWS_KEY = 'lapseiq:archived-contracts:saved-views';
const DEFAULT_SORTING = [{ id: 'archivedAt', desc: true }];
const CLIENT_FETCH_LIMIT = 500;

function columnFiltersToRecord(arr) {
  const out = {};
  for (const f of arr || []) {
    if (f && f.id != null && f.value != null) out[f.id] = f.value;
  }
  return out;
}

function toRow(c) {
  const val = c.costPerLicense && c.quantity
    ? parseFloat(c.costPerLicense) * parseInt(c.quantity)
    : null;
  return {
    id: c.id,
    product: c.product,
    status: c.status,
    vendorId: c.vendor?.id,
    vendorName: c.vendor?.name,
    value: val,
    endDate: c.endDate,
    archivedAt: c.archivedAt,
    ownerName: c.internalOwner?.name,
  };
}

// Apply non-self column filters — used for client-side distinct computation
// with Excel-narrowing semantics.
function applyRowFilters(rows, record, excludeColumnId) {
  return rows.filter((row) => {
    for (const [colId, val] of Object.entries(record)) {
      if (colId === excludeColumnId) continue;
      if (val == null) continue;
      if (Array.isArray(val)) {
        if (val.length === 0) continue;
        const raw = row[colId];
        const isBlank = raw == null || raw === '';
        const hit = isBlank ? val.includes(BLANK_SENTINEL) : val.includes(String(raw));
        if (!hit) return false;
        continue;
      }
      if (typeof val === 'object' && (val.min != null || val.max != null)) {
        const raw = row[colId];
        if (typeof raw !== 'number') return false;
        if (val.min != null && raw < Number(val.min)) return false;
        if (val.max != null && raw > Number(val.max)) return false;
        continue;
      }
      if (typeof val === 'object' && (val.from || val.to)) {
        const raw = row[colId];
        if (!raw) return false;
        const t = new Date(raw).getTime();
        if (Number.isNaN(t)) return false;
        if (val.from && t < new Date(val.from).getTime()) return false;
        if (val.to && t > new Date(val.to).getTime() + 86399999) return false;
        continue;
      }
    }
    return true;
  });
}

export default function ArchivedContracts() {
  useDocumentTitle('Archived contracts');
  const navigate = useNavigate();
  const { user } = useAuth();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  const canEdit = ['admin', 'manager'].includes(user?.role);

  const [contracts, setContracts] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [restoring, setRestoring] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [toast,     setToast]     = useState(null);

  // ── Canonical-pattern state ──────────────────────────────────────────────
  const [columnVisibility, setColumnVisibility] = useUserPreference(
    'archived.columnVisibility',
    defaultArchivedVisibility(),
  );

  const [columnFilters, setColumnFilters] = useState(() => {
    const init = [];
    for (const col of ARCHIVED_COLUMNS) {
      if (!col.meta?.filterType) continue;
      const raw = searchParams.get('f_' + col.id);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed != null) init.push({ id: col.id, value: parsed });
      } catch { /* malformed, skip */ }
    }
    return init;
  });

  const [sorting, setSorting] = useState(DEFAULT_SORTING);

  // Sync columnFilters → URL
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const allFilterKeys = ARCHIVED_COLUMNS
      .filter(col => col.meta?.filterType)
      .map(col => 'f_' + col.id);
    for (const k of allFilterKeys) next.delete(k);
    const record = columnFiltersToRecord(columnFilters);
    for (const [id, val] of Object.entries(record)) {
      if (val == null || val === '') continue;
      const isEmptyArr = Array.isArray(val) && val.length === 0;
      const isEmptyRange = !Array.isArray(val) && typeof val === 'object' && val !== null
        && !val.from && !val.to && val.min == null && val.max == null;
      if (isEmptyArr || isEmptyRange) continue;
      next.set('f_' + id, JSON.stringify(val));
    }
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnFilters]);

  // ── Data fetch ───────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/api/contracts/archived', {
        params: { page: 1, limit: CLIENT_FETCH_LIMIT },
      });
      setContracts(res.data.data.contracts || []);
    } catch (err) {
      setError('Failed to load archived contracts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Restore ──────────────────────────────────────────────────────────────
  const handleRestore = async (contractId, e) => {
    e.stopPropagation();
    if (!await confirm({
      title: 'Restore contract',
      message: 'Restore this contract to the active list?',
      confirmLabel: 'Restore',
    })) return;
    setRestoring(contractId);
    try {
      await api.patch(`/api/contracts/${contractId}/archive`, { archived: false });
      setContracts(prev => prev.filter(c => c.id !== contractId));
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to restore contract.');
    } finally {
      setRestoring(null);
    }
  };

  // ── Table + filtering ────────────────────────────────────────────────────
  const rows = useMemo(() => contracts.map(toRow), [contracts]);

  const table = useReactTable({
    data:    rows,
    columns: ARCHIVED_COLUMNS,
    state:   { columnVisibility, columnFilters, sorting },
    onColumnFiltersChange:    setColumnFilters,
    onSortingChange:          setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel:     getCoreRowModel(),
    getSortedRowModel:   getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const headers       = table.getHeaderGroups()[0]?.headers ?? [];
  const filteredRows  = table.getRowModel().rows;
  const totalCount    = rows.length;
  const filteredCount = filteredRows.length;
  const hasFilters    = columnFilters.length > 0;

  // Client-side distinct fetcher with Excel narrowing.
  const fetchDistinctForColumn = useCallback(async (distinctColumn, excludeColumnId) => {
    const record = columnFiltersToRecord(columnFilters);
    const candidates = applyRowFilters(rows, record, excludeColumnId);
    const set = new Set();
    let blankCount = 0;
    for (const r of candidates) {
      const v = r[distinctColumn];
      if (v == null || v === '') blankCount++;
      else set.add(String(v));
    }
    const values = [...set].sort().slice(0, 500);
    if (blankCount > 0) values.unshift(BLANK_SENTINEL);
    return values;
  }, [rows, columnFilters]);

  // ── Saved-view state ────────────────────────────────────────────────────
  const currentViewState = useMemo(() => ({
    columnFilters, columnVisibility, sorting,
  }), [columnFilters, columnVisibility, sorting]);

  const applyView = (state) => {
    if (!state || typeof state !== 'object') return;
    if (Array.isArray(state.columnFilters))   setColumnFilters(state.columnFilters);
    if (state.columnVisibility && typeof state.columnVisibility === 'object') {
      setColumnVisibility(state.columnVisibility);
    }
    if (Array.isArray(state.sorting) && state.sorting.length > 0) setSorting(state.sorting);
    else setSorting(DEFAULT_SORTING);
  };

  const clearAllFilters = useCallback(() => {
    setColumnFilters([]);
  }, []);

  // ── Export handlers (v0.71.0) ────────────────────────────────────────────
  // Archives reuse /api/export/contracts with ?archived=1. Visible columns
  // round-trip via the existing CONTRACTS_COLUMN_REGISTRY ids on the server,
  // which overlap with ARCHIVED_COLUMNS where applicable (vendor, product,
  // status, endDate, value, owner). Per-column canonical filters do NOT yet
  // round-trip -- the server-side contracts route uses the legacy filter
  // shape; the v0.71 ship is "archived-view export works at all", with
  // full canonical filter pass-through deferred to a later perf-batch.
  function buildArchivedExportParams() {
    const params = new URLSearchParams();
    params.set('archived', '1');
    // Project visible columns where the id maps to an export-registry id.
    // The server contract registry uses 'vendor', 'product', 'status',
    // 'owner', 'value', 'endDate' -- same ids as ARCHIVED_COLUMNS.
    const visibleIds = ARCHIVED_COLUMNS
      .filter(c => columnVisibility[c.id] !== false)
      .map(c => c.id);
    if (visibleIds.length > 0) params.set('columns', visibleIds.join(','));
    return params;
  }

  async function handleExportView() {
    if (exporting) return;
    setExporting(true);
    try {
      const params = buildArchivedExportParams();
      const url = `${import.meta.env.VITE_API_URL ?? ''}/api/export/contracts?${params}`;
      await downloadAuthedFile(url, `Archived-Contracts-${new Date().toISOString().split('T')[0]}.xlsx`);
    } catch (e) {
      setError(e.message || 'Export failed.');
    } finally {
      setExporting(false);
    }
  }

  async function handleEmailView() {
    if (exporting) return;
    setExporting(true);
    try {
      const params = buildArchivedExportParams();
      const url = `${import.meta.env.VITE_API_URL ?? ''}/api/export/contracts?${params}`;
      setToast({ title: 'Preparing export…', message: 'Building your file — this may take a moment.', variant: 'info', duration: 5000 });
      const { filename } = await downloadAuthedFile(url, `Archived-Contracts-${new Date().toISOString().split('T')[0]}.xlsx`);
      const subject = `Archived contracts — ${new Date().toISOString().split('T')[0]}`;
      const body =
        `Please find attached the archived contracts list (${filename}).\n\n` +
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

  // ── Render helpers ──────────────────────────────────────────────────────
  function renderSortableHeader(header) {
    const meta = header.column.columnDef.meta || {};
    const isSorted = header.column.getIsSorted();
    const ariaSort = isSorted === 'asc' ? 'ascending' : isSorted === 'desc' ? 'descending' : 'none';
    const canSort = header.column.getCanSort();
    const label = typeof header.column.columnDef.header === 'string'
      ? header.column.columnDef.header
      : flexRender(header.column.columnDef.header, header.getContext());
    const thStyle = { ...(meta.alignRight ? { textAlign: 'right' } : {}), width: meta.widthPct };
    return (
      <th
        key={header.id}
        className={canSort ? `sortable${isSorted ? ' sorted' : ''}` : undefined}
        aria-sort={ariaSort}
        style={thStyle}
      >
        {canSort ? (
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
        ) : label}
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
    if (meta.filterType === 'multiselect') {
      inner = (
        <ColumnFilterDropdown
          columnId={header.column.id}
          label={meta.label}
          value={Array.isArray(value) ? value : []}
          onChange={onChange}
          fetchDistinct={() => fetchDistinctForColumn(meta.distinctColumn || header.column.id, header.column.id)}
          formatValue={meta.formatValue}
        />
      );
    } else if (meta.filterType === 'daterange') {
      inner = <ColumnDateRangeButton label={meta.label} value={value} onChange={onChange} />;
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

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Archived Contracts</h1>
          <div className="page-subtitle">
            {loading
              ? 'Loading…'
              : filteredCount === totalCount
                ? `${totalCount} archived — data is preserved and searchable`
                : `${filteredCount} of ${totalCount} archived`}
            {hasFilters && !loading && totalCount > 0 && (
              <>
                {' · '}
                <span style={{ color: 'var(--color-warning)', fontWeight: 600 }}>
                  {columnFilters.length} column filter{columnFilters.length !== 1 ? 's' : ''}
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
            className="btn btn-secondary btn-sm"
            onClick={clearAllFilters}
            disabled={!hasFilters}
            title={hasFilters ? 'Clear every per-column filter' : 'No filters to clear'}
            style={hasFilters ? {
              background: 'var(--color-warning-bg)',
              borderColor: 'var(--color-warning)',
              color: 'var(--color-warning)',
            } : undefined}
          >
            × Clear all filters
          </button>
          <SavedViewsMenu
            storageKey={ARCHIVED_SAVED_VIEWS_KEY}
            currentState={currentViewState}
            onApply={applyView}
          />
          <ColumnPicker
            columns={ARCHIVED_COLUMNS}
            visibility={columnVisibility}
            onChange={setColumnVisibility}
            defaults={defaultArchivedVisibility()}
          />
          {canEdit && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setShowImport(true)}
              title="Import historical / archived contracts from CSV or Excel"
            >
              <Upload size={14} strokeWidth={2} /> Import
            </button>
          )}
          {!loading && totalCount > 0 && (
            <ActionDropdown
              label="Export"
              icon={Download}
              title="Export archived contracts"
              items={[
                {
                  label: 'Download view as XLSX',
                  icon: Download,
                  onClick: handleExportView,
                  disabled: exporting,
                  title: 'Download an XLSX of archived contracts (visible columns)',
                },
                {
                  label: 'Email view',
                  icon: Mail,
                  onClick: handleEmailView,
                  disabled: exporting,
                  title: 'Download an XLSX and open your default mail client with a draft. Drag the file from the download bar onto the draft to attach.',
                },
              ]}
            />
          )}
          <button className="btn btn-secondary" onClick={() => navigate('/contracts')}>
            ← Active Contracts
          </button>
        </div>
      </div>

      {showImport && (
        <CsvImportModal
          archived
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); load(); }}
        />
      )}

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

        <div className="card">
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
              Loading…
            </div>
          ) : totalCount === 0 ? (
            <EmptyState
              icon={Archive}
              title="No archived contracts yet"
              sub="Contracts archived from the active list will appear here. Data stays preserved and searchable."
              ctaLabel="Back to active contracts"
              ctaTo="/contracts"
            />
          ) : filteredCount === 0 ? (
            <EmptyState
              icon={Search}
              title="No archived contracts match your filters"
              sub="Try clearing one or more filters to see more results."
              ctaLabel="Clear all filters"
              ctaOnClick={clearAllFilters}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {headers.map(h => renderSortableHeader(h))}
                    {canEdit && <th style={{ width: '8%' }} aria-label="Row actions" />}
                  </tr>
                  <tr className="filter-row">
                    {headers.map(h => renderFilterCell(h))}
                    {canEdit && <th />}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map(row => (
                    <tr
                      key={row.original.id}
                      onClick={() => navigate(`/contracts/${row.original.id}`)}
                      style={{ cursor: 'pointer', opacity: 0.85 }}
                      className="table-row-clickable"
                    >
                      {row.getVisibleCells().map(cell => {
                        const meta = cell.column.columnDef.meta || {};
                        return (
                          <td
                            key={cell.id}
                            style={meta.alignRight ? { textAlign: 'right' } : undefined}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        );
                      })}
                      {canEdit && (
                        <td onClick={e => e.stopPropagation()}>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={(e) => handleRestore(row.original.id, e)}
                            disabled={restoring === row.original.id}
                            style={{ fontSize: 'var(--font-size-xs)' }}
                            title="Restore this contract to the active list"
                          >
                            {restoring === row.original.id ? '…' : 'Restore'}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
