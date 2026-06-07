// ─────────────────────────────────────────────────────────────────────────────
// VendorsList.jsx — v0.70.0 canonical-pattern propagation
//
// Inherits the /contracts canonical list-page pattern (per
// docs/design/list-page-canonical-pattern.md Section 4.2):
//   • Excel-style ColumnFilterDropdown on Vendor, Type, Co-term
//   • ColumnFilterInput (numberrange) on Contracts + Active Spend
//   • ColumnDateRangeButton on Last Contacted
//   • TanStack table with getFilteredRowModel for client-side filtering
//   • URL-synced column-filter state via f_<columnId>=<JSON> keys
//   • Cross-device saved views via useUserPreference
//   • Cross-device column visibility via useUserPreference
//   • Clear-all-filters in page header, amber when active
//
// The dataset is bounded (typically <100 vendors per account), so filtering
// stays client-side — no /api/vendors/bootstrap or /api/vendors/distinct
// endpoints needed. Distinct values are computed locally with Excel-narrowing
// against sibling-column filters.
//
// New-vendor form (with duplicate detection) is preserved verbatim from
// pre-v0.70 — it's working UX that the propagation didn't need to disturb.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Briefcase, Search, Download, Mail } from 'lucide-react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
} from '@tanstack/react-table';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
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
import { kbdActivate } from '../lib/a11y';
import {
  VENDORS_COLUMNS,
  defaultVendorsVisibility,
  VENDOR_TYPES,
  BLANK_SENTINEL,
} from '../tables/vendorsColumns.jsx';

const VENDORS_SAVED_VIEWS_KEY = 'lapseiq:vendors-list:saved-views';
const DEFAULT_SORTING = [{ id: 'name', desc: false }];

// ── Helpers ──────────────────────────────────────────────────────────────────

function columnFiltersToRecord(arr) {
  const out = {};
  for (const f of arr || []) {
    if (f && f.id != null && f.value != null) out[f.id] = f.value;
  }
  return out;
}

// v0.71.0: build the URL query for /api/export/vendors mirroring the active
// canonical-pattern column-filter state. Each vendor column's `meta.filterParam`
// names the server param (single string for multiselect, {min,max} object for
// numberrange, {from,to} object for daterange).
function appendVendorColumnFilterParam(params, col, value) {
  const ft = col.meta?.filterType;
  const fp = col.meta?.filterParam;
  if (!ft || value == null) return;
  if (ft === 'multiselect' && Array.isArray(value) && value.length > 0) {
    if (typeof fp === 'string') params.set(fp, value.join(','));
  } else if (ft === 'numberrange' && typeof value === 'object' && fp && typeof fp === 'object') {
    if (value.min != null) params.set(fp.min, String(value.min));
    if (value.max != null) params.set(fp.max, String(value.max));
  } else if (ft === 'daterange' && typeof value === 'object' && fp && typeof fp === 'object') {
    if (value.from) params.set(fp.from, value.from);
    if (value.to)   params.set(fp.to,   value.to);
  }
}

function buildVendorsExportParams({ columnFilters, columnVisibility }) {
  const params = new URLSearchParams();
  const record = columnFiltersToRecord(columnFilters);
  for (const col of VENDORS_COLUMNS) {
    appendVendorColumnFilterParam(params, col, record[col.id]);
  }
  const visibleIds = VENDORS_COLUMNS
    .filter(c => columnVisibility[c.id] !== false)
    .map(c => c.id);
  if (visibleIds.length > 0) params.set('columns', visibleIds.join(','));
  return params;
}

// Compute active-spend for a vendor — mirrors the legacy helper.
function vendorSpend(v) {
  return (v.contracts ?? []).reduce(
    (s, c) =>
      s + (c.costPerLicense && c.quantity
        ? parseFloat(c.costPerLicense) * parseInt(c.quantity)
        : 0),
    0,
  );
}

function vendorLastContact(v) {
  return v.lastContactedAt ?? v.communications?.[0]?.createdAt ?? null;
}

// Normalize a raw /api/vendors response into the row shape vendorsColumns expects.
function toRow(v) {
  return {
    id: v.id,
    name: v.name,
    vendorType: v.vendorType,
    cotermComplexity: v.cotermComplexity,
    cotermNotes: v.cotermNotes,
    contractCount: v._count?.contracts ?? 0,
    activeSpend: vendorSpend(v),
    lastContactedAt: vendorLastContact(v),
  };
}

// Apply non-self column filters to a row set — used for client-side distinct
// computation with Excel-narrowing semantics (mirrors applyAlertsRowFilters
// on the server for /alerts).
function applyVendorRowFilters(rows, record, excludeColumnId) {
  return rows.filter((row) => {
    for (const [colId, val] of Object.entries(record)) {
      if (colId === excludeColumnId) continue;
      if (val == null) continue;
      // multiselect (string[])
      if (Array.isArray(val)) {
        if (val.length === 0) continue;
        const raw = row[colId];
        const isBlank = raw == null || raw === '';
        const hit = isBlank ? val.includes(BLANK_SENTINEL) : val.includes(String(raw));
        if (!hit) return false;
        continue;
      }
      // numberrange
      if (typeof val === 'object' && (val.min != null || val.max != null)) {
        const raw = row[colId];
        if (typeof raw !== 'number') return false;
        if (val.min != null && raw < Number(val.min)) return false;
        if (val.max != null && raw > Number(val.max)) return false;
        continue;
      }
      // daterange
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

export default function VendorsList() {
  useDocumentTitle('Vendors');
  const { features } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const canEdit = features.vendors_write;

  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState(null);

  // ── New-vendor form state (preserved from pre-v0.70) ──────────────────────
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', vendorType: '', cotermComplexity: 'none', cotermNotes: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [dupCheck, setDupCheck] = useState(null);
  const [dupChecking, setDupChecking] = useState(false);
  const [forceCreate, setForceCreate] = useState(false);
  const dupTimerRef = useRef(null);

  // ── Canonical-pattern state ───────────────────────────────────────────────
  const [columnVisibility, setColumnVisibility] = useUserPreference(
    'vendors.columnVisibility',
    defaultVendorsVisibility(),
  );

  // Initial columnFilters seeded from URL `f_<columnId>=<JSON>` keys.
  const [columnFilters, setColumnFilters] = useState(() => {
    const init = [];
    for (const col of VENDORS_COLUMNS) {
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

  const [sorting, setSorting] = useState(DEFAULT_SORTING);

  // Sync columnFilters → URL
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const allFilterKeys = VENDORS_COLUMNS
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
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnFilters]);

  // ── Data fetch ────────────────────────────────────────────────────────────
  const fetchVendors = useCallback(() => {
    setLoading(true);
    api.get('/api/vendors')
      .then(res => setVendors(res.data.data.vendors || []))
      .catch(() => setError('Failed to load vendors.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchVendors(); }, [fetchVendors]);

  // OnboardingWizard's "Add a vendor" CTA navigates here with ?new=1. Strip
  // the param after reading so a refresh doesn't re-open the form.
  useEffect(() => {
    if (searchParams.get('new') === '1' && canEdit) {
      setShowForm(true);
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit]);

  // ── Export handlers (v0.71.0) ─────────────────────────────────────────────
  async function handleExportView() {
    if (exporting) return;
    setExporting(true);
    try {
      const params = buildVendorsExportParams({ columnFilters, columnVisibility });
      const url = `${import.meta.env.VITE_API_URL ?? ''}/api/export/vendors?${params}`;
      await downloadAuthedFile(url, `Vendors-${new Date().toISOString().split('T')[0]}.xlsx`);
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
      const params = buildVendorsExportParams({ columnFilters, columnVisibility });
      const url = `${import.meta.env.VITE_API_URL ?? ''}/api/export/vendors?${params}`;
      setToast({ title: 'Preparing export…', message: 'Building your file — this may take a moment.', variant: 'info', duration: 5000 });
      const { filename } = await downloadAuthedFile(url, `Vendors-${new Date().toISOString().split('T')[0]}.xlsx`);
      const subject = `Vendors list — ${new Date().toISOString().split('T')[0]}`;
      const body =
        `Please find attached the vendors list (${filename}).\n\n` +
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

  // ── New-vendor form helpers ───────────────────────────────────────────────
  const setF = (key, val) => setForm((p) => ({ ...p, [key]: val }));

  const checkDuplicate = useCallback((name) => {
    if (dupTimerRef.current) clearTimeout(dupTimerRef.current);
    setForceCreate(false);
    if (!name || name.trim().length < 2) {
      setDupCheck(null);
      setDupChecking(false);
      return;
    }
    setDupChecking(true);
    dupTimerRef.current = setTimeout(async () => {
      try {
        const res = await api.get('/api/vendors/check', { params: { name: name.trim() } });
        const { canonical, matches } = res.data.data;
        const strong = matches.filter(m => m.score >= 70);
        setDupCheck(strong.length > 0 ? { canonical, matches: strong } : null);
      } catch {
        setDupCheck(null);
      } finally {
        setDupChecking(false);
      }
    }, 350);
  }, []);

  useEffect(() => {
    checkDuplicate(form.name);
    return () => { if (dupTimerRef.current) clearTimeout(dupTimerRef.current); };
  }, [form.name, checkDuplicate]);

  const handleNameChange = (val) => { setF('name', val); setFormError(''); };

  const resetForm = () => {
    setForm({ name: '', vendorType: '', cotermComplexity: 'none', cotermNotes: '', notes: '' });
    setDupCheck(null);
    setDupChecking(false);
    setForceCreate(false);
    setFormError('');
    setShowForm(false);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { setFormError('Vendor name is required.'); return; }
    if (dupCheck && dupCheck.matches.length > 0 && !forceCreate) {
      setFormError('Please review the potential duplicate(s) above before continuing.');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      await api.post('/api/vendors', { ...form, force: forceCreate || undefined });
      resetForm();
      fetchVendors();
    } catch (err) {
      if (err.response?.status === 409 && err.response.data?.data?.matches) {
        const { canonical, matches } = err.response.data.data;
        setDupCheck({ canonical, matches });
        setFormError('Similar vendor found — please review before creating.');
      } else {
        setFormError(err.response?.data?.error || 'Failed to create vendor.');
      }
    } finally {
      setSaving(false);
    }
  };

  const matchTypeLabel = (type) => ({
    exact:        'Exact match',
    alias:        'Known alias',
    stored_alias: 'Custom alias',
    partial:      'Partial match',
  }[type] || type);

  // ── Table + filtering ─────────────────────────────────────────────────────
  const rows = useMemo(() => vendors.map(toRow), [vendors]);

  const table = useReactTable({
    data:    rows,
    columns: VENDORS_COLUMNS,
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
  const hasColumnFilters = columnFilters.length > 0;

  // Client-side distinct fetcher with Excel narrowing.
  const fetchDistinctForColumn = useCallback(async (distinctColumn, excludeColumnId) => {
    const record = columnFiltersToRecord(columnFilters);
    const candidates = applyVendorRowFilters(rows, record, excludeColumnId);
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

  // ── Saved-view state ──────────────────────────────────────────────────────
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

  // ── Render helpers ────────────────────────────────────────────────────────
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

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Vendors</h1>
          <div className="page-subtitle">
            {loading
              ? 'Loading…'
              : filteredCount === totalCount
                ? `${totalCount} vendor${totalCount !== 1 ? 's' : ''}`
                : `${filteredCount} of ${totalCount} vendor${totalCount !== 1 ? 's' : ''}`}
            {hasColumnFilters && !loading && totalCount > 0 && (
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
            className="btn btn-secondary"
            onClick={clearAllFilters}
            disabled={!hasColumnFilters}
            title={hasColumnFilters
              ? 'Clear every per-column filter'
              : 'No filters to clear'}
            style={hasColumnFilters ? {
              background: 'var(--color-warning-bg)',
              borderColor: 'var(--color-warning)',
              color: 'var(--color-warning)',
            } : undefined}
          >
            × Clear all filters
          </button>
          <SavedViewsMenu
            storageKey={VENDORS_SAVED_VIEWS_KEY}
            currentState={currentViewState}
            onApply={applyView}
          />
          <ColumnPicker
            columns={VENDORS_COLUMNS}
            visibility={columnVisibility}
            onChange={setColumnVisibility}
            defaults={defaultVendorsVisibility()}
          />
          {!loading && totalCount > 0 && (
            <ActionDropdown
              label="Export"
              icon={Download}
              title="Export vendors list"
              items={[
                {
                  label: 'Download view as XLSX',
                  icon: Download,
                  onClick: handleExportView,
                  disabled: exporting,
                  title: 'Download an XLSX of vendors currently visible (visible columns + active filters)',
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
          {canEdit && (
            <button className="btn btn-primary" onClick={() => setShowForm(true)}>
              + New Vendor
            </button>
          )}
        </div>
      </div>

      <div className="page-body">
        {showForm && (
          <div className="card mb-16">
            <div className="card-header">
              <div className="card-title">New Vendor</div>
            </div>
            <div className="card-body">
              {formError && <div role="alert" className="alert alert-error">{formError}</div>}
              <form onSubmit={handleCreate}>
                <div className="form-row form-row-2">
                  <div className="form-group">
                    <label htmlFor="vendor-name" className="form-label">Vendor Name <span className="required">*</span></label>
                    <div style={{ position: 'relative' }}>
                      <input
                        id="vendor-name"
                        className="form-control"
                        placeholder="e.g. Microsoft"
                        value={form.name}
                        onChange={(e) => handleNameChange(e.target.value)}
                        autoFocus
                        style={{ paddingRight: dupChecking ? 32 : undefined }}
                      />
                      {dupChecking && (
                        <span style={{
                          position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                          fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)',
                        }}>…</span>
                      )}
                    </div>

                    {dupCheck && dupCheck.matches.length > 0 && (
                      <div style={{
                        marginTop: 8,
                        padding: '10px 12px',
                        background: 'rgba(234, 179, 8, 0.08)',
                        border: '1px solid rgba(234, 179, 8, 0.3)',
                        borderRadius: 'var(--radius)',
                        fontSize: 'var(--font-size-sm)',
                      }}>
                        <div style={{ fontWeight: 600, color: '#ca8a04', marginBottom: 6 }}>
                          Similar vendor{dupCheck.matches.length > 1 ? 's' : ''} already exist
                        </div>

                        {dupCheck.canonical && dupCheck.canonical !== form.name.trim() && (
                          <div style={{ color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                            Suggested name: <strong style={{ color: 'var(--color-text)' }}>{dupCheck.canonical}</strong>
                            <button
                              type="button"
                              onClick={() => { setF('name', dupCheck.canonical); setDupCheck(null); }}
                              style={{ marginLeft: 8, fontSize: 'var(--font-size-xs)', color: 'var(--color-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                            >
                              Use this name
                            </button>
                          </div>
                        )}

                        {dupCheck.matches.map((m) => (
                          <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                            <span style={{ color: 'var(--color-text)' }}>
                              <strong>{m.name}</strong>
                              <span style={{ marginLeft: 6, color: 'var(--color-text-secondary)' }}>
                                ({matchTypeLabel(m.matchType)})
                              </span>
                            </span>
                            <button
                              type="button"
                              onClick={() => navigate(`/vendors/${m.id}`)}
                              style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, whiteSpace: 'nowrap', textDecoration: 'underline' }}
                            >
                              View vendor
                            </button>
                          </div>
                        ))}

                        {!forceCreate ? (
                          <button
                            type="button"
                            onClick={() => setForceCreate(true)}
                            style={{ marginTop: 6, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                          >
                            Create anyway — this is a different vendor
                          </button>
                        ) : (
                          <div style={{ marginTop: 6, fontSize: 'var(--font-size-xs)', color: 'var(--color-success)' }}>
                            ✓ Confirmed — will create as a new vendor
                            <button
                              type="button"
                              onClick={() => setForceCreate(false)}
                              style={{ marginLeft: 8, color: 'var(--color-text-secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                            >
                              Undo
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="form-group">
                    <label htmlFor="vendor-type" className="form-label">Vendor Type</label>
                    <select id="vendor-type" className="form-control" value={form.vendorType} onChange={(e) => setF('vendorType', e.target.value)}>
                      <option value="">— Unclassified —</option>
                      {VENDOR_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor="vendor-coterm" className="form-label">Co-term Complexity</label>
                    <select id="vendor-coterm" className="form-control" value={form.cotermComplexity} onChange={(e) => setF('cotermComplexity', e.target.value)}>
                      <option value="none">Simple — straightforward renewal</option>
                      <option value="moderate">Moderate — some co-term considerations</option>
                      <option value="complex">Complex — multiple products or dates</option>
                    </select>
                  </div>
                </div>
                <div className="form-group">
                  <label htmlFor="vendor-coterm-notes" className="form-label">Co-term Notes</label>
                  <input id="vendor-coterm-notes" className="form-control" placeholder="Notes about co-terming or anniversary dates…" value={form.cotermNotes} onChange={(e) => setF('cotermNotes', e.target.value)} />
                </div>
                <div className="form-group">
                  <label htmlFor="vendor-notes" className="form-label">General Notes</label>
                  <textarea id="vendor-notes" className="form-control" rows={2} value={form.notes} onChange={(e) => setF('notes', e.target.value)} placeholder="Anything useful to know about this vendor…" />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={saving || (dupCheck && dupCheck.matches.length > 0 && !forceCreate)}
                  >
                    {saving ? 'Creating…' : 'Create Vendor'}
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={resetForm}>Cancel</button>
                </div>
              </form>
            </div>
          </div>
        )}

        {error && <div role="alert" className="alert alert-error">{error}</div>}

        <div className="card">
          {loading ? (
            <div className="loading">Loading vendors…</div>
          ) : totalCount === 0 ? (
            <EmptyState
              icon={Briefcase}
              title="No vendors yet"
              sub="Vendors are the parties on the other side of every contract. Add your first one to start linking contracts to it."
              ctaLabel={canEdit ? '+ New vendor' : null}
              ctaOnClick={canEdit ? () => setShowForm(true) : null}
            />
          ) : filteredCount === 0 ? (
            <EmptyState
              icon={Search}
              title="No vendors match your filters"
              sub="Try clearing one or more filters to see more results."
              ctaLabel="Clear all filters"
              ctaOnClick={clearAllFilters}
            />
          ) : (
            <div className="table-wrap list-table--cards">
              <table className="vendors-list-table">
                <thead>
                  <tr>{headers.map(h => renderSortableHeader(h))}</tr>
                  <tr className="filter-row">{headers.map(h => renderFilterCell(h))}</tr>
                </thead>
                <tbody>
                  {filteredRows.map(row => (
                    <tr
                      key={row.original.id}
                      onClick={() => navigate(`/vendors/${row.original.id}`)}
                      tabIndex={0}
                      onKeyDown={kbdActivate(() => navigate(`/vendors/${row.original.id}`))}
                      style={{ cursor: 'pointer' }}
                      className="table-row-clickable"
                    >
                      {row.getVisibleCells().map(cell => {
                        const meta = cell.column.columnDef.meta || {};
                        return (
                          <td
                            key={cell.id}
                            data-label={meta.label || (typeof cell.column.columnDef.header === 'string' ? cell.column.columnDef.header : '')}
                            style={meta.alignRight ? { textAlign: 'right' } : undefined}
                          >
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        );
                      })}
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
