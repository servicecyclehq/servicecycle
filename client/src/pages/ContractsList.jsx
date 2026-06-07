import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { Upload, Download, FileUp, Plus, FileText, Search, Mail, X as XIcon, ChevronUp, ChevronDown } from 'lucide-react';
import ActionDropdown from '../components/ActionDropdown';
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
} from '@tanstack/react-table';
import api from '../api/client';
import { kbdActivate } from '../lib/a11y'; // H7 (audit High): <tr> keyboard reach (deferred from C9)
import { downloadAuthedFile } from '../api/download';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { useUserPreference } from '../hooks/useUserPreference';
import ColumnFilterInput from '../components/ColumnFilterInput';
import ColumnFilterDropdown from '../components/ColumnFilterDropdown';
import ColumnDateRangeButton from '../components/ColumnDateRangeButton';
import EmptyState from '../components/EmptyState';
import ColumnPicker from '../components/ColumnPicker';
import SavedViewsMenu from '../components/SavedViewsMenu';
import Toast from '../components/Toast';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  CONTRACTS_COLUMNS,
  CONTRACTS_VISIBILITY_KEY, // kept for the cross-tab storage listener below
  defaultContractsVisibility,
  fmt,
  daysUntil,
  DaysChip,
  StatusBadge,
  formatCurrency,
} from '../tables/contractsColumns.jsx';

const BTN_ICON = { size: 14, strokeWidth: 1.75, style: { verticalAlign: '-2px', marginRight: 6 } };

// v0.53.0: stash the current /contracts URL (incl. filter querystring) in
// sessionStorage AND pass it as React Router state when navigating to a
// contract detail page. ContractDetail's back button reads from these to
// return the user to their filtered list view rather than a bare /contracts.
function navigateToContract(navigate, contractId, location) {
  const from = (location?.pathname || '/contracts') + (location?.search || '');
  try { sessionStorage.setItem('lapseiq_last_contracts_url', from); } catch (e) {}
  navigate('/contracts/' + contractId, { state: { from } });
}

const CONTRACTS_SAVED_VIEWS_KEY = 'lapseiq:contracts-list:saved-views';

// ── SortTh ────────────────────────────────────────────────────────────────────
function SortTh({ field, label, sort, sortDir, onSort, style }) {
  const active = sort === field;
  const icon = active
    ? (sortDir === 'asc'
        ? <ChevronUp size={14} strokeWidth={1.75} />
        : <ChevronDown size={14} strokeWidth={1.75} />)
    : null;
  const ariaSort = active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
  return (
    <th scope="col" className={`sortable${active ? ' sorted' : ''}`} aria-sort={ariaSort} style={style}>
      <button
        type="button"
        onClick={() => onSort(field)}
        className="th-sort-button"
        style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, width: '100%' }}
      >
        {label}{icon && <span className="sort-icon" aria-hidden="true">{icon}</span>}
        <span style={{ position: 'absolute', left: -9999, top: 'auto', width: 1, height: 1, overflow: 'hidden' }}>
          {active ? `(sorted ${sortDir === 'asc' ? 'ascending' : 'descending'})` : ', sortable'}
        </span>
      </button>
    </th>
  );
}

// ── Fiscal year / quarter helpers ─────────────────────────────────────────────
function getFiscalYear(dateStr, fyStartMonth) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const month = d.getMonth() + 1;
  const year  = d.getFullYear();
  if (fyStartMonth === 1) return year;
  return month >= fyStartMonth ? year : year - 1;
}

function fyLabel(year, fyStartMonth) {
  if (fyStartMonth === 1) return String(year);
  const endYear = year + 1;
  const startMonthName = new Date(year, fyStartMonth - 1, 1).toLocaleDateString('en-US', { month: 'short' });
  const endMonthName   = new Date(endYear, fyStartMonth - 2, 1).toLocaleDateString('en-US', { month: 'short' });
  return `FY${year}  ·  ${startMonthName} ${year} – ${endMonthName} ${endYear}`;
}

function getQuarter(dateStr) {
  if (!dateStr) return null;
  const month = new Date(dateStr).getMonth() + 1;
  return month <= 3 ? 1 : month <= 6 ? 2 : month <= 9 ? 3 : 4;
}

const QUARTER_LABELS = {
  1: 'Q1  ·  Jan – Mar',
  2: 'Q2  ·  Apr – Jun',
  3: 'Q3  ·  Jul – Sep',
  4: 'Q4  ·  Oct – Dec',
};

const CHECKBOX_COL_WIDTH = '3%';

// ── ContractTable (TanStack-driven) ──────────────────────────────────────────

function ContractTable({ contracts, sort, sortDir, onSort, navigate, selection, columnVisibility, showFilterRow = false, columnFilters = {}, onColumnFilterChange = null, fetchDistinctForColumn = null }) {
  const location = useLocation();
  const sel = selection;
  const selectable = !!sel;

  const table = useReactTable({
    data:    contracts,
    columns: CONTRACTS_COLUMNS,
    state:   { columnVisibility },
    getCoreRowModel: getCoreRowModel(),
  });

  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const rows    = table.getRowModel().rows;

  return (
    <div className="table-wrap list-table--cards">
      <table style={{ tableLayout: 'fixed' }}>
        <colgroup>
          {selectable && <col style={{ width: CHECKBOX_COL_WIDTH }} />}
          {headers.map(h => (
            <col key={h.id} style={{ width: h.column.columnDef.meta?.widthPct }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {selectable && (
              <th scope="col" style={{ width: 28, paddingLeft: 12, paddingRight: 0 }}>
                <input
                  type="checkbox"
                  checked={sel.allVisibleSelected}
                  ref={el => {
                    if (el) el.indeterminate = sel.anyVisibleSelected && !sel.allVisibleSelected;
                  }}
                  onChange={sel.onToggleAll}
                  aria-label="Select all on this page"
                  style={{ cursor: 'pointer' }}
                />
              </th>
            )}
            {headers.map(header => {
              const meta = header.column.columnDef.meta || {};
              const thStyle = meta.alignRight ? { textAlign: 'right' } : undefined;
              const label   = typeof header.column.columnDef.header === 'string'
                ? header.column.columnDef.header
                : flexRender(header.column.columnDef.header, header.getContext());
              if (meta.sortField) {
                return (
                  <SortTh
                    key={header.id}
                    field={meta.sortField}
                    label={label}
                    sort={sort}
                    sortDir={sortDir}
                    onSort={onSort}
                    style={thStyle}
                  />
                );
              }
              return <th key={header.id} scope="col" style={thStyle}>{label}</th>;
            })}
          </tr>
          {showFilterRow && onColumnFilterChange && (
            <tr>
              {selectable && <td style={{ width: 28, padding: '4px 6px' }} />}
              {headers.map(header => {
                const meta = header.column.columnDef.meta || {};
                if (!meta.filterType) {
                  return <td key={'f-' + header.id} style={{ padding: '4px 6px' }} />;
                }
                const colId = header.column.id;
                const value = columnFilters[colId];
                const onChange = (v) => onColumnFilterChange(colId, v);
                let inner = null;
                if (meta.filterType === 'multiselect') {
                  inner = (
                    <ColumnFilterDropdown
                      columnId={colId}
                      label={meta.label}
                      value={Array.isArray(value) ? value : []}
                      onChange={onChange}
                      fetchDistinct={() => fetchDistinctForColumn(meta.distinctColumn || colId)}
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
                  <td key={'f-' + colId} style={{ padding: '4px 6px', fontWeight: 400, overflow: 'visible' }}>
                    {inner}
                  </td>
                );
              })}
            </tr>
          )}
        </thead>
        <tbody>
          {rows.map(row => {
            const c = row.original;
            const cancelDays = daysUntil(c.cancelByDate);
            const isTrap = c.autoRenewal && cancelDays !== null && cancelDays >= 0 && cancelDays <= 30;
            const isSelected = selectable ? sel.selected.has(c.id) : false;

            const handleCheckboxClick = (e) => {
              e.stopPropagation();
              sel.onToggle(c.id);
            };

            return (
              <tr
                key={c.id}
                className={isTrap ? 'trap-row' : ''}
                style={{ cursor: 'pointer' }}
                onClick={() => navigateToContract(navigate, c.id, location)}
              >
                {selectable && (
                  <td onClick={handleCheckboxClick} style={{ width: 28, paddingLeft: 12, paddingRight: 0 }}>
                    <input
                      type="checkbox"
                      checked={!!isSelected}
                      onChange={() => sel.onToggle(c.id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Select ${c.product}`}
                      style={{ cursor: 'pointer' }}
                    />
                  </td>
                )}
                {row.getVisibleCells().map(cell => {
                  const meta = cell.column.columnDef.meta || {};
                  const tdStyle = meta.alignRight ? { textAlign: 'right' } : undefined;
                  return (
                    <td key={cell.id} data-label={meta.label || (typeof cell.column.columnDef.header === 'string' ? cell.column.columnDef.header : '')} style={tdStyle}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Bulk action bar (list view only) ──────────────────────────────────────────

function BulkActionBar({ count, busy, message, members, canArchive, onSetStatus, onSetOwner, onExport, onArchive, onClear }) {
  const confirm = useConfirm();
  if (count === 0) return null;

  const STATUS_OPTIONS = [
    { value: 'active',       label: 'Active' },
    { value: 'under_review', label: 'Under review' },
    { value: 'renewed',      label: 'Renewed' },
    { value: 'cancelled',    label: 'Cancelled' },
    { value: 'expired',      label: 'Expired' },
  ];

  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 10,
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10,
      padding: '10px 14px',
      background: 'var(--color-primary)', color: 'var(--color-surface)',
      borderRadius: 'var(--radius)', marginBottom: 10,
      boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
    }}>
      <div style={{ fontWeight: 700, fontSize: 'var(--font-size-ui)' }}>
        {count} selected
      </div>

      <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.3)' }} />

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-sm)' }}>
        <span style={{ opacity: 0.85 }}>Set status</span>
        <select
          aria-label="Set status for selected contracts"
          disabled={busy}
          value=""
          onChange={(e) => { if (e.target.value) onSetStatus(e.target.value); e.target.value = ''; }}
          style={{ padding: '4px 8px', fontSize: 'var(--font-size-sm)', borderRadius: 4, border: 'none', background: 'rgba(255,255,255,0.15)', color: 'var(--color-surface)', fontWeight: 600 }}
        >
          <option value="" disabled>Choose…</option>
          {STATUS_OPTIONS.map(o => (
            <option key={o.value} value={o.value} style={{ color: 'var(--color-text)' }}>{o.label}</option>
          ))}
        </select>
      </label>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-sm)' }}>
        <span style={{ opacity: 0.85 }}>Assign owner</span>
        <select
          aria-label="Assign owner to selected contracts"
          disabled={busy}
          value=""
          onChange={(e) => { if (e.target.value !== 'NO_OP') onSetOwner(e.target.value); e.target.value = 'NO_OP'; }}
          style={{ padding: '4px 8px', fontSize: 'var(--font-size-sm)', borderRadius: 4, border: 'none', background: 'rgba(255,255,255,0.15)', color: 'var(--color-surface)', fontWeight: 600, minWidth: 140 }}
        >
          <option value="NO_OP" disabled>Choose…</option>
          <option value="" style={{ color: 'var(--color-text)' }}>— Unassigned —</option>
          {(members || []).map(m => (
            <option key={m.id} value={m.id} style={{ color: 'var(--color-text)' }}>{m.name || m.email}</option>
          ))}
        </select>
      </label>

      <div style={{ width: 1, height: 22, background: 'rgba(255,255,255,0.3)' }} />

      <button
        type="button"
        onClick={onExport}
        disabled={busy}
        style={{ padding: '5px 12px', fontSize: 'var(--font-size-sm)', fontWeight: 600, border: '1px solid rgba(255,255,255,0.4)', borderRadius: 4, background: 'transparent', color: 'var(--color-surface)', cursor: busy ? 'wait' : 'pointer' }}
      >
        ⬇ Export selected
      </button>

      {canArchive && (
        <button
          type="button"
          onClick={async () => {
            if (await confirm({
              title: 'Archive contracts',
              message: `Archive ${count} contract${count === 1 ? '' : 's'}? They will move to the Archive list and stop appearing in active reports.`,
              confirmLabel: 'Archive',
              danger: true,
            })) {
              onArchive();
            }
          }}
          disabled={busy}
          style={{ padding: '5px 12px', fontSize: 'var(--font-size-sm)', fontWeight: 600, border: '1px solid rgba(255,200,200,0.6)', borderRadius: 4, background: 'transparent', color: 'var(--color-surface)', cursor: busy ? 'wait' : 'pointer' }}
        >
          Archive
        </button>
      )}

      <div style={{ flex: 1 }} />

      {message && (
        <div style={{
          fontSize: 'var(--font-size-sm)', padding: '4px 10px', borderRadius: 4,
          background: message.ok ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.30)',
          color: 'var(--color-surface)', fontWeight: 600,
        }}>
          {message.ok ? '✓ ' : '✗ '}{message.text}
        </div>
      )}

      <button
        type="button"
        onClick={onClear}
        disabled={busy}
        style={{ padding: '5px 10px', fontSize: 'var(--font-size-sm)', fontWeight: 600, border: 'none', borderRadius: 4, background: 'rgba(255,255,255,0.15)', color: 'var(--color-surface)', cursor: busy ? 'wait' : 'pointer' }}
      >
        Clear selection
      </button>
    </div>
  );
}

// ── Quarter grouped view ──────────────────────────────────────────────────────

function QuarterView({ contracts, fyStartMonth = 1, sort, sortDir, onSort, navigate, columnVisibility }) {
  const groups = {};
  const noDate = [];
  for (const c of contracts) {
    const q = getQuarter(c.endDate);
    if (q === null) { noDate.push(c); continue; }
    const year = getFiscalYear(c.endDate, fyStartMonth) ?? new Date(c.endDate).getFullYear();
    const key  = `${year}-Q${q}`;
    if (!groups[key]) groups[key] = { year, q, contracts: [] };
    groups[key].contracts.push(c);
  }

  const sortedKeys = Object.keys(groups).sort((a, b) => {
    const ga = groups[a], gb = groups[b];
    return ga.year !== gb.year ? ga.year - gb.year : ga.q - gb.q;
  });

  return (
    <div>
      {sortedKeys.map(key => {
        const { year, q, contracts: grpContracts } = groups[key];
        return (
          <div key={key} style={{ marginBottom: 24 }}>
            <div style={{
              padding: '8px 16px',
              background: 'var(--color-surface)',
              borderLeft: '3px solid var(--color-primary)',
              borderBottom: '1px solid var(--color-border)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span style={{ fontWeight: 700, fontSize: 'var(--font-size-ui)', color: 'var(--color-text)' }}>
                {QUARTER_LABELS[q]} {year}
              </span>
              <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                {grpContracts.length} contract{grpContracts.length !== 1 ? 's' : ''}
              </span>
            </div>
            <ContractTable
              contracts={grpContracts}
              sort={sort} sortDir={sortDir} onSort={onSort}
              navigate={navigate}
              columnVisibility={columnVisibility}
            />
          </div>
        );
      })}
      {noDate.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ padding: '8px 16px', background: 'var(--color-surface)', borderLeft: '3px solid var(--color-border-strong)', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontWeight: 700, fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>No End Date</span>
            <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>{noDate.length} contract{noDate.length !== 1 ? 's' : ''}</span>
          </div>
          <ContractTable
            contracts={noDate}
            sort={sort} sortDir={sortDir} onSort={onSort}
            navigate={navigate}
            columnVisibility={columnVisibility}
          />
        </div>
      )}
    </div>
  );
}

// ── Fiscal year calendar view ─────────────────────────────────────────────────

function FiscalYearView({ contracts, fyStartMonth, navigate, sort, sortDir, onSort, columnVisibility }) {
  const now = new Date();
  const defaultYear = (now.getMonth() + 1) >= fyStartMonth ? now.getFullYear() : now.getFullYear() - 1;
  const [selectedYear, setSelectedYear] = useState(defaultYear);

  const filtered = contracts.filter(c => getFiscalYear(c.endDate, fyStartMonth) === selectedYear);

  const groups = { 1: [], 2: [], 3: [], 4: [], null: [] };
  for (const c of filtered) {
    const q = getQuarter(c.endDate);
    (groups[q] ?? groups[null]).push(c);
  }

  const totalValue = filtered.reduce((sum, c) => {
    if (!c.costPerLicense || !c.quantity) return sum;
    return sum + parseFloat(c.costPerLicense) * parseInt(c.quantity);
  }, 0);

  const fmtTotal = totalValue > 0
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(totalValue)
    : null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 16px', background: 'var(--color-surface)', borderBottom: '1px solid var(--color-border)', borderRadius: 'var(--radius) var(--radius) 0 0' }}>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => setSelectedYear(y => y - 1)}
        >← {fyStartMonth === 1 ? selectedYear - 1 : `FY${selectedYear - 1}`}</button>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 'var(--font-size-base)' }}>{fyLabel(selectedYear, fyStartMonth)}</span>
          <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginLeft: 12 }}>
            {filtered.length} contract{filtered.length !== 1 ? 's' : ''}
            {fmtTotal && ` · ${fmtTotal} total committed`}
          </span>
        </div>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => setSelectedYear(y => y + 1)}
        >{fyStartMonth === 1 ? selectedYear + 1 : `FY${selectedYear + 1}`} →</button>
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-data)' }}>
          No contracts with end dates in {fyLabel(selectedYear, fyStartMonth)}.
        </div>
      ) : (
        [1, 2, 3, 4].map(q => {
          if (groups[q].length === 0) return null;
          return (
            <div key={q} style={{ marginBottom: 16 }}>
              <div style={{ padding: '6px 16px', background: 'var(--color-bg)', borderLeft: '3px solid var(--color-primary)', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{QUARTER_LABELS[q]}</span>
                <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>{groups[q].length}</span>
              </div>
              <ContractTable
                contracts={groups[q]}
                sort={sort} sortDir={sortDir} onSort={onSort}
                navigate={navigate}
                columnVisibility={columnVisibility}
              />
            </div>
          );
        })
      )}
    </div>
  );
}

// ── CSV Import Modal (v0.6.0) ────────────────────────────────────────────────

const TEMPLATE_HEADERS = [
  'Vendor','Product','Contract #','Customer #','Status',
  'Start Date','End Date','Quantity','Cost Per License',
  'Auto Renewal','Notice Days','PO Number','Invoice Number',
  'Department','Team','Cost Center','Requestor',
  'Reseller','Reseller Account #','Reseller Contact','Reseller Email','Notes',
];

const TEMPLATE_SAMPLE_ROW = [
  'Microsoft','Microsoft 365 E3','MS-2024-001','','active',
  '2024-01-01','2025-01-01','50','36.00',
  'Yes','30','PO-1234','',
  'IT','','','Jane Smith',
  'SoftwareOne','','','','Enterprise agreement renewal',
];

export function CsvImportModal({ onClose, onImported, archived = false }) {
  const fileRef = useRef();
  const [step, setStep]             = useState('upload');
  const [file, setFile]             = useState(null);
  const [preview, setPreview]       = useState(null);
  const [mapping, setMapping]       = useState({});
  const [dedupeStrategy, setDedupeStrategy] = useState('skip');
  const [createMissingVendors, setCreateMissingVendors] = useState(false);
  const [busy, setBusy]             = useState(false);
  const [results, setResults]       = useState(null);
  const [error, setError]           = useState('');

  function downloadTemplate() {
    const lines = [TEMPLATE_HEADERS.join(','), TEMPLATE_SAMPLE_ROW.join(',')];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lapseiq-import-template.csv';
    a.click();
  }

  async function uploadForPreview(f) {
    if (!f) return;
    if (!/\.(csv|xlsx|xls)$/i.test(f.name)) { setError('Please select a .csv or .xlsx file.'); return; }
    setError(''); setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await api.post('/api/contracts/import?step=preview', fd);
      setFile(f);
      setPreview(res.data.data);
      setMapping(res.data.data.suggestedMapping || {});
      setStep('preview');
    } catch (err) {
      const msg = err.response?.data?.error || err.message || 'Preview failed.';
      setError(msg);
      if (err.response?.data?.data?.headers) {
        setFile(f);
        setPreview(err.response.data.data);
        setMapping(err.response.data.data.suggestedMapping || {});
        setStep('preview');
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirmImport() {
    setError(''); setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mapping', JSON.stringify(mapping));
      fd.append('dedupeStrategy', dedupeStrategy);
      fd.append('createMissingVendors', createMissingVendors ? 'true' : 'false');
      if (archived) fd.append('archived', 'true');
      const res = await api.post('/api/contracts/import?step=commit', fd);
      setResults(res.data.data);
      setStep('done');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  function downloadErrorCsv() {
    if (!results?.errorCsv) return;
    const binary = atob(results.errorCsv);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lapseiq-import-errors-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  }

  const fieldOptions = [
    { value: '', label: '— Ignore column —' },
    ...(preview?.schemaFields || []).map(f => ({
      value: f.key,
      label: f.label + (f.required ? ' *' : ''),
    })),
    ...(preview?.customFields || []).map(f => ({
      value: `custom:${f.key}`,
      label: `[Custom] ${f.name}` + (f.required ? ' *' : ''),
    })),
  ];

  const totalRows  = preview?.totalRows ?? 0;
  const errCount   = preview?.validationErrors?.length ?? 0;
  const dupCount   = preview?.duplicates?.length ?? 0;
  const unkVendors = preview?.unknownVendors || [];
  const targetFields = Object.values(mapping).filter(Boolean);
  const missingVendor  = !targetFields.includes('vendor');
  const missingProduct = !targetFields.includes('product');
  const canConfirm = !busy
    && !missingVendor
    && !missingProduct
    && (createMissingVendors || unkVendors.length === 0);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card" style={{ width: 880, maxWidth: '96vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div className="card-header" style={{ flexShrink: 0 }}>
          <div className="card-title">{archived ? 'Import Archived Contracts' : 'Import Contracts from CSV or Excel'}</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--color-text-secondary)' }}>×</button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {step === 'upload' && (
            <div className="card-body">
              <p style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-text-secondary)', marginBottom: 20 }}>
                Upload a CSV or Excel file (.xlsx) to bulk-import contracts. A previously-exported CSV works with zero mapping; for other files you'll be able to map columns on the next step. Up to 1000 rows per file.
              </p>
              <button className="btn btn-secondary" onClick={downloadTemplate} style={{ marginBottom: 20 }}>⬇ Download Template CSV</button>
              <div
                onClick={() => fileRef.current.click()}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); uploadForPreview(e.dataTransfer.files[0]); }}
                style={{ border: '2px dashed var(--color-border-strong)', borderRadius: 'var(--radius-lg)', padding: '36px 24px', textAlign: 'center', cursor: busy ? 'wait' : 'pointer', background: 'var(--color-surface)', opacity: busy ? 0.6 : 1 }}
              >
                <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" style={{ display: 'none' }} onChange={e => uploadForPreview(e.target.files[0])} />
                <div style={{ fontSize: 'var(--font-size-3xl)', marginBottom: 8 }}>📋</div>
                <div style={{ fontWeight: 600 }}>{busy ? 'Parsing file…' : 'Drop your CSV or Excel file here, or click to browse'}</div>
                <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginTop: 4 }}>Up to {preview?.maxRows || 1000} rows · .csv or .xlsx</div>
              </div>
              {error && <div role="alert" className="alert alert-error" style={{ marginTop: 16 }}>{error}</div>}
            </div>
          )}
          {step === 'preview' && preview && (
            <div className="card-body">
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
                <div style={{ padding: '8px 12px', background: 'var(--color-surface)', borderRadius: 'var(--radius)', fontSize: 'var(--font-size-ui)' }}>
                  <strong>{totalRows}</strong> row{totalRows !== 1 ? 's' : ''}
                </div>
                {errCount > 0 && (
                  <div style={{ padding: '8px 12px', background: 'var(--color-danger-bg)', borderRadius: 'var(--radius)', fontSize: 'var(--font-size-ui)', color: 'var(--color-danger)' }}>
                    <strong>{errCount}</strong> with errors
                  </div>
                )}
                {dupCount > 0 && (
                  <div style={{ padding: '8px 12px', background: '#fff8e1', borderRadius: 'var(--radius)', fontSize: 'var(--font-size-ui)', color: '#9a6700' }}>
                    <strong>{dupCount}</strong> duplicate{dupCount !== 1 ? 's' : ''}
                  </div>
                )}
                {unkVendors.length > 0 && (
                  <div style={{ padding: '8px 12px', background: 'var(--color-info-bg)', borderRadius: 'var(--radius)', fontSize: 'var(--font-size-ui)', color: 'var(--color-info)' }}>
                    <strong>{unkVendors.length}</strong> new vendor{unkVendors.length !== 1 ? 's' : ''}
                  </div>
                )}
              </div>

              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Column Mapping</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 10 }}>
                  Map each file column to a LapseIQ field. Required fields are marked with *. Unmapped columns are ignored.
                </div>
                <table style={{ fontSize: 'var(--font-size-ui)', width: '100%' }}>
                  <thead>
                    <tr>
                      <th scope="col" style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--color-border)' }}>File Column</th>
                      <th scope="col" style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--color-border)' }}>Maps To</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(preview.headers || []).map(h => (
                      <tr key={h}>
                        <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--font-size-sm)' }}>{h}</td>
                        <td style={{ padding: '4px 8px' }}>
                          <select
                            aria-label={`Map column ${h} to field`}
                            className="form-control"
                            style={{ maxWidth: 320 }}
                            value={mapping[h] ?? ''}
                            onChange={e => setMapping({ ...mapping, [h]: e.target.value || null })}
                          >
                            {fieldOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(missingVendor || missingProduct) && (
                  <div role="alert" className="alert alert-error" style={{ marginTop: 10, fontSize: 'var(--font-size-ui)' }}>
                    Required field{(missingVendor && missingProduct) ? 's' : ''} not mapped: {[missingVendor && 'Vendor', missingProduct && 'Product'].filter(Boolean).join(', ')}.
                  </div>
                )}
              </div>

              {preview.sampleRows && preview.sampleRows.length > 0 && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Sample (first 10 rows)</div>
                  <div style={{ overflowX: 'auto', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)' }}>
                    <table style={{ fontSize: 'var(--font-size-sm)' }}>
                      <thead>
                        <tr>
                          {['vendorName','product','endDate','quantity','costPerLicense','status'].map(c =>
                            <th key={c} scope="col" style={{ padding: '6px 10px', textAlign: 'left', borderBottom: '1px solid var(--color-border)' }}>{c}</th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.sampleRows.map((row, i) => (
                          <tr key={i}>
                            {['vendorName','product','endDate','quantity','costPerLicense','status'].map(c => (
                              <td key={c} style={{ padding: '4px 10px', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {row[c] == null || row[c] === '' ? <span style={{ color: 'var(--color-text-muted)' }}>—</span> : (
                                  c === 'endDate' && row[c] ? String(row[c]).split('T')[0] : String(row[c])
                                )}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {errCount > 0 && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, marginBottom: 8, color: 'var(--color-danger)' }}>Validation errors ({errCount})</div>
                  <div style={{ maxHeight: 140, overflowY: 'auto', border: '1px solid var(--color-danger-bg-strong)', borderRadius: 'var(--radius)', background: 'var(--color-danger-bg)', padding: 8, fontSize: 'var(--font-size-sm)' }}>
                    {preview.validationErrors.slice(0, 20).map((e, i) => (
                      <div key={i} style={{ marginBottom: 4 }}>
                        <strong>Row {e.row}:</strong>{' '}
                        {e.errors.map(er => `${er.field} — ${er.error}`).join('; ')}
                      </div>
                    ))}
                    {preview.validationErrors.length > 20 && (
                      <div style={{ color: 'var(--color-text-secondary)', marginTop: 4 }}>…and {preview.validationErrors.length - 20} more. They'll appear in the error CSV after import.</div>
                    )}
                  </div>
                </div>
              )}

              {dupCount > 0 && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Duplicates ({dupCount})</div>
                  <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                    Rows whose (vendor, end date) already exists. Choose how to handle them:
                  </div>
                  {[
                    { v: 'skip',   label: 'Skip — keep the existing row, ignore the import row' },
                    { v: 'update', label: 'Update — overwrite the existing row with the import values' },
                    { v: 'create', label: 'Create — add the import row alongside the existing one' },
                  ].map(opt => (
                    <label key={opt.v} style={{ display: 'block', fontSize: 'var(--font-size-ui)', padding: '4px 0', cursor: 'pointer' }}>
                      <input type="radio" name="dedupe" value={opt.v}
                        checked={dedupeStrategy === opt.v}
                        onChange={e => setDedupeStrategy(e.target.value)}
                        style={{ marginRight: 8 }}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              )}

              {unkVendors.length > 0 && (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>New Vendors ({unkVendors.length})</div>
                  <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                    These vendor names aren't in your account yet:{' '}
                    <em>{unkVendors.slice(0, 8).join(', ')}{unkVendors.length > 8 ? `, …and ${unkVendors.length - 8} more` : ''}</em>
                  </div>
                  <label style={{ display: 'block', fontSize: 'var(--font-size-ui)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={createMissingVendors}
                      onChange={e => setCreateMissingVendors(e.target.checked)}
                      style={{ marginRight: 8 }}
                    />
                    Auto-create these vendors during import
                  </label>
                  {!createMissingVendors && (
                    <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-danger)', marginTop: 4 }}>
                      Required — or remove the affected rows from your CSV and try again.
                    </div>
                  )}
                </div>
              )}

              {error && <div role="alert" className="alert alert-error" style={{ marginTop: 8 }}>{error}</div>}
            </div>
          )}
          {step === 'done' && results && (
            <div className="card-body">
              <div style={{ textAlign: 'center', padding: '16px 0 8px' }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>{results.failed > 0 ? '⚠' : '✓'}</div>
                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Import Complete</div>
                <div style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-text-secondary)' }}>
                  <strong style={{ color: 'var(--color-success)' }}>{results.created}</strong> created
                  {results.updated > 0 && <>, <strong style={{ color: 'var(--color-info)' }}>{results.updated}</strong> updated</>}
                  {results.skipped > 0 && <>, <strong>{results.skipped}</strong> skipped (duplicate)</>}
                  {results.failed > 0 && <>, <strong style={{ color: 'var(--color-danger)' }}>{results.failed}</strong> failed</>}
                </div>
              </div>
              {results.errorCsv && (
                <div style={{ marginTop: 16, textAlign: 'center' }}>
                  <button className="btn btn-secondary" onClick={downloadErrorCsv}>⬇ Download Error CSV</button>
                  <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 6 }}>
                    Fix the rows in the error CSV and re-import.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ flexShrink: 0, padding: '12px 20px', borderTop: '1px solid var(--color-border)', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {step === 'upload' && <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>}
          {step === 'preview' && (
            <>
              <button className="btn btn-secondary" onClick={() => { setStep('upload'); setPreview(null); setError(''); }} disabled={busy}>← Back</button>
              <button className="btn btn-primary" onClick={confirmImport} disabled={!canConfirm}>
                {busy ? 'Importing…' : `Import ${totalRows - errCount} valid row${(totalRows - errCount) !== 1 ? 's' : ''}`}
              </button>
            </>
          )}
          {step === 'done' && (
            <button className="btn btn-primary" onClick={(results?.created || results?.updated) > 0 ? onImported : onClose}>
              {(results?.created || results?.updated) > 0 ? 'View Contracts' : 'Close'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Renewal filter labels ─────────────────────────────────────────────────────

const RENEWAL_LABELS = {
  renewing30:     'Expiring in 30 days',
  renewing60:     'Expiring in 60 days',
  renewing90:     'Expiring in 90 days',
  cancel30:       '⚠ Auto-renewal — action needed',
  overdue:        '⚠ Overdue',
  expiringMonth:  'Expiring this month',
};

function statusLabel(s) {
  const map = { active: 'Active', under_review: 'Under Review', renewed: 'Renewed', cancelled: 'Cancelled', expired: 'Expired' };
  return map[s] || s;
}

// ── Co-term grouped view ───────────────────────────────────────────────────────

function CotermView({ navigate }) {
  const location = useLocation();
  const [groups, setGroups] = useState(null);
  const [error, setError]   = useState('');

  useEffect(() => {
    api.get('/api/contracts/coterm-summary')
      .then(r => setGroups(r.data.data?.groups || []))
      .catch(() => setError('Failed to load co-term groups.'));
  }, []);

  if (error) return <div role="alert" className="alert alert-error">{error}</div>;
  if (!groups) return <div className="loading">Loading co-term groups…</div>;

  if (groups.length === 0) {
    // v0.68.4 (audit Quick Win): use shared EmptyState for visual + a11y parity.
    return (
      <EmptyState
        title="No co-term groups yet"
        body={<>Edit a contract and set its <strong>Co-Term Group</strong> field (e.g. <em>Microsoft Q4 2027</em>) to bundle multiple contracts into a single renewal event. Combined annual spend will surface here.</>}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {groups.map(g => (
        <div key={g.name} className="card">
          <div className="card-header" style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div className="card-title" style={{ marginBottom: 2 }}>{g.name}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                {g.count} contract{g.count !== 1 ? 's' : ''}
                {g.earliestEndDate && <> · earliest renewal {fmt(g.earliestEndDate)}</>}
              </div>
              {g.warning === 'drift' && (
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 6, fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-warning)', background: 'var(--color-warning-bg)', borderRadius: 4, padding: '3px 8px' }}>
                  ⚠️ End dates span {g.endDateSpread} days — may not co-term cleanly
                </div>
              )}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Combined annual spend
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)' }}>
                {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(g.annualSpend)}
              </div>
            </div>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Vendor</th>
                <th scope="col">Product</th>
                <th scope="col">End Date</th>
                <th scope="col">Status</th>
                <th scope="col" style={{ textAlign: 'right' }}>Annual Value</th>
              </tr>
            </thead>
            <tbody>
              {g.contracts.map(c => (
                <tr key={c.id} onClick={() => navigateToContract(navigate, c.id, location)} tabIndex={0} onKeyDown={kbdActivate(() => navigateToContract(navigate, c.id, location))} style={{ cursor: 'pointer' }}>
                  <td>{c.vendor?.name || '—'}</td>
                  <td>{c.product}</td>
                  <td>{fmt(c.endDate)}</td>
                  <td>{statusLabel(c.status)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {c.annualValue > 0
                      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(c.annualValue)
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

// ── Build the URL query for /api/export/contracts mirroring the active filters ─
function buildContractsExportParams({
  search, statusFilter, vendorId, ownerId, categoryId, hasPO, evaluateBy,
  endMonth, renewalWindow, hideExpired, columnVisibility,
}) {
  const params = new URLSearchParams();
  if (search)        params.set('search', search);
  if (statusFilter)  params.set('status', statusFilter);
  else if (hideExpired) params.set('excludeExpired', 'true');
  if (vendorId)      params.set('vendorId', vendorId);
  if (ownerId)       params.set('ownerId', ownerId);
  if (categoryId)    params.set('categoryId', categoryId);
  if (hasPO)         params.set('hasPO', hasPO);
  if (evaluateBy)    params.set('evaluateBy', evaluateBy);
  if (endMonth)      params.set('endMonth', endMonth);
  if (renewalWindow) params.set('renewal', renewalWindow);
  const visibleIds = CONTRACTS_COLUMNS.filter(c => columnVisibility[c.id] !== false).map(c => c.id);
  if (visibleIds.length > 0) params.set('columns', visibleIds.join(','));
  return params;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ContractsList() {
  useDocumentTitle('Contracts');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const { user, features } = useAuth();

  const [contracts, setContracts]       = useState([]);
  const [pagination, setPagination]     = useState({ page: 1, limit: 25, total: 0, pages: 1 });
  const [scopeRestricted, setScopeRestricted] = useState(false);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState('');
  const [members, setMembers]           = useState([]);
  const [vendorOptions, setVendorOptions] = useState([]);
  const [categoryOptions, setCategoryOptions] = useState([]);

  const [viewMode, setViewMode]         = useState(() => {
    const v = searchParams.get('view');
    return ['list','quarter','fiscal','coterm'].includes(v) ? v : 'list';
  });
  const [fyStartMonth, setFyStartMonth] = useState(1);

  const [search, setSearch]             = useState(searchParams.get('search') || '');
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || '');
  const [renewalWindow, setRenewalWindow] = useState(searchParams.get('renewal') || '');
  const [vendorId, setVendorId]         = useState(searchParams.get('vendorId') || '');
  const [vendorName, setVendorName]     = useState(searchParams.get('vendorName') || '');
  const [endMonth, setEndMonth]         = useState(searchParams.get('endMonth') || '');
  const [ownerId, setOwnerId]           = useState(searchParams.get('ownerId') || '');
  const [categoryId, setCategoryId]     = useState(searchParams.get('categoryId') || '');
  const [hasPO, setHasPO]              = useState(searchParams.get('hasPO') || '');
  const [evaluateBy, setEvaluateBy]    = useState(searchParams.get('evaluateBy') || '');
  const currentMonthVal = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();
  const [sort, setSort]                 = useState('endDate');
  const [sortDir, setSortDir]           = useState('asc');
  const [page, setPage]                 = useState(1);
  const [showImport, setShowImport]     = useState(false);
  const [hideExpired, setHideExpired]   = useState(!searchParams.get('status'));
  const [exporting, setExporting]       = useState(false);
  const [toast, setToast]               = useState(null);

  // v0.47 perf: tracks whether the initial /api/bootstrap call has resolved.
  // First fetchContracts() invocation hits /api/bootstrap (which also hydrates
  // members / vendorOptions / categoryOptions / fyStartMonth); subsequent
  // invocations (filter changes, paging, sort) hit /api/contracts directly.
  const bootstrapDoneRef = useRef(false);

  // v0.43 per-column filters. One state object keyed by column id; each
  // value is whatever the column's filterType expects (string for text,
  // { from, to } for daterange, { min, max } for numberrange). URL-synced
  // under _<columnId> keys so back-button + share-links work.
  const [columnFilters, setColumnFilters] = useState(() => {
    const init = {};
    for (const col of CONTRACTS_COLUMNS) {
      const ft = col.meta?.filterType;
      if (!ft) continue;
      const raw = searchParams.get('f_' + col.id);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed != null) init[col.id] = parsed;
      } catch { /* malformed param, skip */ }
    }
    return init;
  });

  // Sync columnFilters -> URL on change. Uses a stringified JSON value per
  // column so the daterange/numberrange shapes round-trip cleanly. Strips
  // keys whose value is empty so the URL stays clean.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    // Drop any prior f_* keys before writing the current state
    const allFilterKeys = CONTRACTS_COLUMNS
      .filter(col => col.meta?.filterType)
      .map(col => 'f_' + col.id);
    for (const k of allFilterKeys) next.delete(k);
    for (const [id, val] of Object.entries(columnFilters)) {
      if (val == null || val === '') continue;
      // v0.52.3: same array-vs-range distinction as setColumnFilter above.
      const isEmptyArrayVal = Array.isArray(val) && val.length === 0;
      const isEmptyRangeVal = !Array.isArray(val) && typeof val === 'object' && val !== null
        && !val.from && !val.to && val.min == null && val.max == null;
      if (isEmptyArrayVal || isEmptyRangeVal) continue;
      next.set('f_' + id, JSON.stringify(val));
    }
    // v0.49 loop fix: skip no-op replace; otherwise location.key mints a new
    // value every render, which re-fires the line 1174 auto-clear effect,
    // which calls clearAllFilters -> setColumnFilters({}), which re-fires
    // THIS effect, which calls setSearchParams again. Infinite ping-pong.
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnFilters]);

  const setColumnFilter = useCallback((id, value) => {
    setColumnFilters(prev => {
      const next = { ...prev };
      // v0.52.3: distinguish between empty multi-select arrays and empty
      // range objects. Pre-v0.52.3 the empty-range check fired for ANY
      // typeof===object value without from/to/min/max - which includes
      // multi-select arrays like ['AIG']. So every multi-select toggle
      // was being instantly wiped: setColumnFilters({vendor:['AIG']})
      // matched the "empty range" condition (arrays have no from/to/min/max)
      // and deleted the just-set key. Result: checkbox never rendered checked
      // and filters never applied. Bug has been present since v0.43 (the
      // initial per-column filter commit) but was masked by other interactions
      // before v0.52.1 removed the auto-clear effect.
      const isEmptyArray = Array.isArray(value) && value.length === 0;
      const isEmptyRange = !Array.isArray(value) && typeof value === 'object' && value !== null
        && !value.from && !value.to && value.min == null && value.max == null;
      if (value == null || value === '' || isEmptyArray || isEmptyRange) {
        delete next[id];
      } else {
        next[id] = value;
      }
      return next;
    });
  }, []);

  const clearAllColumnFilters = useCallback(() => setColumnFilters({}), []);

  // v0.44: fetch distinct values for a given column from the backend.
  // Backend's /api/contracts/distinct/:column endpoint applies all OTHER
  // active filters (including toolbar + sibling column filters), so the
  // dropdown's checkbox list narrows like Excel's AutoFilter.
  const fetchDistinctForColumn = useCallback(async (distinctColumn) => {
    // Build the same param set the main fetchContracts uses, sans pagination/sort.
    const params = {};
    if (search)        params.search    = search;
    if (statusFilter)  params.status    = statusFilter;
    else if (hideExpired) params.excludeExpired = 'true';
    if (renewalWindow) params.renewal   = renewalWindow;
    if (vendorId)      params.vendorId  = vendorId;
    if (endMonth)      params.endMonth  = endMonth;
    if (ownerId)       params.ownerId   = ownerId;
    if (categoryId)    params.categoryId = categoryId;
    if (hasPO)         params.hasPO      = hasPO;
    if (evaluateBy)    params.evaluateBy = evaluateBy;
    for (const col of CONTRACTS_COLUMNS) {
      const ft = col.meta?.filterType;
      if (!ft) continue;
      const val = columnFilters[col.id];
      if (val == null) continue;
      const fp = col.meta.filterParam;
      if (ft === 'multiselect' && Array.isArray(val) && val.length > 0) {
        params[fp] = val.join(',');
      } else if (ft === 'daterange' && typeof val === 'object' && fp && typeof fp === 'object') {
        if (val.from) params[fp.from] = val.from;
        if (val.to)   params[fp.to]   = val.to;
      } else if (ft === 'numberrange' && typeof val === 'object' && fp && typeof fp === 'object') {
        if (val.min != null) params[fp.min] = val.min;
        if (val.max != null) params[fp.max] = val.max;
      }
    }
    const res = await api.get('/api/contracts/distinct/' + distinctColumn, { params });
    return res.data?.values || [];
  }, [search, statusFilter, hideExpired, renewalWindow, vendorId, endMonth, ownerId, categoryId, hasPO, evaluateBy, columnFilters]);
  const activeColumnFilterCount = Object.keys(columnFilters).length;

  // v0.42: cross-device column visibility via UserPreference. The old
  // localStorage helpers (loadContractsVisibility / saveContractsVisibility)
  // are kept exported for now so other consumers don't break, but the page
  // itself reads/writes via the new hook so the picker state follows the
  // user across browsers.
  const [columnVisibility, setColumnVisibility] = useUserPreference(
    'contracts.columnVisibility',
    defaultContractsVisibility()
  );
  const setColumnVisibilityState = setColumnVisibility; // alias for downstream callers

  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== CONTRACTS_VISIBILITY_KEY || !e.newValue) return;
      try {
        const parsed = JSON.parse(e.newValue);
        if (parsed && typeof parsed === 'object') setColumnVisibilityState(parsed);
      } catch { /* ignore */ }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // v0.47 perf: the 4 separate mount-time fetches that used to populate
  // fyStartMonth + members + vendorOptions + categoryOptions are now bundled
  // into the /api/bootstrap call in fetchContracts below (first invocation
  // only). On warm navigations within the SPA, these state slices already
  // exist and do not need to be refetched.
  //
  // The useUserPreference("contracts.columnVisibility") hook still fires its
  // own /api/preferences/contracts.columnVisibility request in parallel.
  // Folding that into the bootstrap requires teaching the hook to accept a
  // server-seed value -- deferred to a follow-up. The call is parallel with
  // everything else now, so it is no longer slowest-of-six.

  function clearAllFilters() {
    setSearch(''); setStatusFilter(''); setRenewalWindow('');
    setVendorId(''); setVendorName(''); setEndMonth(''); setOwnerId('');
    setCategoryId(''); setHasPO(''); setEvaluateBy('');
    setHideExpired(true);
    // v0.44.2: also clear the v0.43 per-column header filters so the "Clear
    // all filters" button in the page header truly resets everything.
    setColumnFilters({});
    setPage(1);
  }

  // v0.53.1: when the user clicks the sidebar's Contracts link while already
  // on /contracts with filters applied, the Sidebar pushes location.state
  // with a fresh `clearFilters` token. Mirror the page-title click handler:
  // clear every filter and rewrite the URL to bare /contracts. Consume the
  // state by navigating without it so the effect doesn't re-fire if the user
  // toggles to another page and back.
  useEffect(() => {
    if (location.state && location.state.clearFilters) {
      clearAllFilters();
      navigate('/contracts', { replace: true, state: {} });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state?.clearFilters]);

  useEffect(() => {
    const p = new URLSearchParams();
    if (viewMode && viewMode !== 'list') p.set('view', viewMode);
    if (search)        p.set('search', search);
    if (statusFilter)  p.set('status', statusFilter);
    if (renewalWindow) p.set('renewal', renewalWindow);
    if (vendorId)      p.set('vendorId', vendorId);
    if (vendorName)    p.set('vendorName', vendorName);
    if (endMonth)      p.set('endMonth', endMonth);
    if (ownerId)       p.set('ownerId', ownerId);
    if (categoryId)    p.set('categoryId', categoryId);
    if (hasPO)         p.set('hasPO', hasPO);
    if (evaluateBy)    p.set('evaluateBy', evaluateBy);
    // v0.49 loop fix (same reason as the f_* effect above)
    if (p.toString() === searchParams.toString()) return;
    setSearchParams(p, { replace: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, search, statusFilter, renewalWindow, vendorId, vendorName, endMonth, ownerId, categoryId, hasPO, evaluateBy]);

  // v0.52.1: removed the location.key auto-clear effect. It was firing on
  // every URL change (including programmatic setSearchParams from the two
  // URL-sync effects above) and racing the searchParams hook update. The
  // race occasionally observed searchParams.toString() as empty during a
  // render where a column filter had just been set, then called
  // clearAllFilters() and wiped the just-applied filter. Replaced with an
  // explicit clearAllFilters() in the page-title click handler so the
  // intent (user clicks Contracts heading -> clear filters + reset to bare
  // /contracts) is conveyed without a side-effect that fires on every URL
  // change.

  // Legacy "Export CSV" handler — kept for backward compat / public-API users.
  const handleExportCsv = async () => {
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    if (search) params.set('search', search);
    const token = localStorage.getItem('lapseiq_token');
    const url = `${import.meta.env.VITE_API_URL ?? ''}/api/contracts/export?${params}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lapseiq-contracts-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  // v0.40 Phase 4: Export-current-view as XLSX. Visible columns + full
  // toolbar filters (not just status/search like the legacy CSV).
  async function handleExportView() {
    if (exporting) return;
    setExporting(true);
    try {
      const params = buildContractsExportParams({
        search, statusFilter, vendorId, ownerId, categoryId, hasPO, evaluateBy,
        endMonth, renewalWindow, hideExpired, columnVisibility,
      });
      const url = `${import.meta.env.VITE_API_URL ?? ''}/api/export/contracts?${params}`;
      await downloadAuthedFile(url, `Contracts-${new Date().toISOString().split('T')[0]}.xlsx`);
    } catch (e) {
      setError(e.message || 'Export failed.');
    } finally {
      setExporting(false);
    }
  }

  // v0.40 Phase 5: Email-this-view. Download + open default mail client with
  // pre-filled subject + body explaining how to attach (download bar →
  // Show in folder → drag onto email draft).
  async function handleEmailView() {
    if (exporting) return;
    setExporting(true);
    try {
      const params = buildContractsExportParams({
        search, statusFilter, vendorId, ownerId, categoryId, hasPO, evaluateBy,
        endMonth, renewalWindow, hideExpired, columnVisibility,
      });
      const url = `${import.meta.env.VITE_API_URL ?? ''}/api/export/contracts?${params}`;
      setToast({ title: 'Preparing export…', message: 'Building your file — this may take a moment.', variant: 'info', duration: 5000 });
      const { filename } = await downloadAuthedFile(url, `Contracts-${new Date().toISOString().split('T')[0]}.xlsx`);
      const subject = `Contracts list — ${new Date().toISOString().split('T')[0]}`;
      const body =
        `Please find attached the contracts list (${filename}).\n\n` +
        `Drag the file from your Downloads folder onto this email to attach it ` +
        `(or find it in your Downloads folder).`;
      window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      // v0.41: inline Toast replaces window.alert (non-blocking, in-app styled).
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

  // v0.49 perf: pack the 14 fetchContracts deps into two memoized objects.
  // filterParams = everything that should reset the page to 1 when it changes.
  // queryParams = filterParams + page = the full input to fetchContracts.
  // fetchContracts then becomes stable identity ([] deps), reading via ref.
  // This kills the useCallback identity churn that the v0.49.1 hotfix worked
  // around (gated the bootstrap dupe-fire) but didn't fix at the source.
  const filterParams = useMemo(() => ({
    search, statusFilter, renewalWindow, vendorId, endMonth, ownerId,
    categoryId, hasPO, evaluateBy, sort, sortDir, viewMode, hideExpired,
    columnFilters,
  }), [search, statusFilter, renewalWindow, vendorId, endMonth, ownerId,
      categoryId, hasPO, evaluateBy, sort, sortDir, viewMode, hideExpired, columnFilters]);

  const queryParams = useMemo(() => ({ ...filterParams, page }),
    [filterParams, page]);

  const queryParamsRef = useRef(queryParams);
  useEffect(() => { queryParamsRef.current = queryParams; }, [queryParams]);

  const fetchContracts = useCallback(async () => {
    const p = queryParamsRef.current;
    const { page, search, statusFilter, renewalWindow, vendorId, endMonth,
            ownerId, categoryId, hasPO, evaluateBy, sort, sortDir, viewMode,
            hideExpired, columnFilters } = p;
    if (viewMode === 'coterm') { setLoading(false); return; }
    // v0.52.9: NO setLoading(true) on refetch. Was triggering a full-screen
    // 'Loading contracts...' branch in the JSX ternary, which unmounted
    // ContractTable and all its ColumnFilterDropdown children, resetting
    // their open state. Initial cold-mount loading is handled by
    // useState(true) at the top of this component.
    setError('');
    try {
      const isGrouped = viewMode !== 'list';
      const params = {
        page:    isGrouped ? 1    : page,
        limit:   isGrouped ? 500  : 25,
        sort,
        sortDir,
      };
      if (search)        params.search    = search;
      if (statusFilter)  params.status    = statusFilter;
      else if (hideExpired) params.excludeExpired = 'true';
      if (renewalWindow) params.renewal   = renewalWindow;
      if (vendorId)      params.vendorId  = vendorId;
      if (endMonth)      params.endMonth  = endMonth;
      if (ownerId)       params.ownerId   = ownerId;
      if (categoryId)    params.categoryId = categoryId;
      if (hasPO)         params.hasPO      = hasPO;
      if (evaluateBy)    params.evaluateBy = evaluateBy;

      // v0.44 per-column filters. Each column's value is either:
      //   multiselect -> string[] (sent as comma-joined to backend In[] param)
      //   daterange   -> { from, to }
      //   numberrange -> { min, max }
      for (const col of CONTRACTS_COLUMNS) {
        const ft = col.meta?.filterType;
        if (!ft) continue;
        const val = columnFilters[col.id];
        if (val == null) continue;
        const fp = col.meta.filterParam;
        if (ft === 'multiselect' && Array.isArray(val) && val.length > 0) {
          // Comma-join the array; backend parseList handles split + trim.
          params[fp] = val.join(',');
        } else if (ft === 'daterange' && typeof val === 'object' && fp && typeof fp === 'object') {
          if (val.from) params[fp.from] = val.from;
          if (val.to)   params[fp.to]   = val.to;
        } else if (ft === 'numberrange' && typeof val === 'object' && fp && typeof fp === 'object') {
          if (val.min != null) params[fp.min] = val.min;
          if (val.max != null) params[fp.max] = val.max;
        }
      }

      // v0.47 perf: first call uses /api/bootstrap so members / vendorOptions
      // / categoryOptions / fyStartMonth all hydrate from one round-trip
      // alongside the contracts page. Subsequent calls (filter changes,
      // sort, paging) use /api/contracts directly -- the lookup state is
      // already populated, so re-fetching it would be waste.
      let res;
      if (!bootstrapDoneRef.current) {
        res = await api.get('/api/bootstrap', { params });
        const d = res.data?.data || {};
        // Hydrate lookup state from the same response -- these used to be
        // 4 separate mount useEffects in pre-v0.47.
        if (Array.isArray(d.members))    setMembers(d.members);
        if (Array.isArray(d.vendors))    setVendorOptions(d.vendors);
        if (Array.isArray(d.categories)) setCategoryOptions(d.categories);
        if (d.settings && typeof d.settings.fiscalYearStartMonth === 'number') {
          setFyStartMonth(d.settings.fiscalYearStartMonth);
        }
        bootstrapDoneRef.current = true;
      } else {
        res = await api.get('/api/contracts', { params });
      }
      setContracts(res.data.data.contracts);
      setPagination(res.data.data.pagination);
      setScopeRestricted(res.data.data.scopeRestricted || false);
    } catch (err) {
      setError('Failed to load contracts.');
    } finally {
      setLoading(false);
    }
  }, []); // v0.49: stable identity; reads latest params via queryParamsRef

  // v0.46: 300ms debounce on EVERY filter change (not just search). Pairs
  // with the immediate-apply pattern in ColumnFilterDropdown — each
  // checkbox toggle commits to columnFilters, which changes fetchContracts'
  // identity. Without debounce, rapid clicks would fire a fetch per click.
  // With the cleanup-on-rerender pattern below, only the LAST fetch in a
  // 300ms burst actually hits the server.

  // v0.49 hotfix: skip the 300ms debounce on the very first fetch (the
  // one that hits /api/bootstrap). Subsequent calls (filter/sort changes)
  // go through the debounce as before. Cold-load trace showed the
  // debounce re-arming ~400 times before firing, gating bootstrap behind
  // ~2.6s of pure setTimeout thrash. bootstrapDoneRef.current is the
  // natural gate (already maintained inside fetchContracts itself), so a
  // failed bootstrap will retry-immediate on the next dep change instead
  // of waiting 300ms.
  // v0.49.1 fix: bootstrapDoneRef is set INSIDE fetchContracts AFTER the
  // await resolves, so v0.49.0's gate fired bootstrap ~10 times in
  // parallel before any returned. Use a synchronous "initiated" ref that
  // locks BEFORE the fetch is called.
  const firstFetchInitiatedRef = useRef(false);
  useEffect(() => {
    if (!firstFetchInitiatedRef.current) {
      firstFetchInitiatedRef.current = true;
      // v0.51: check if index.html's inline preload-fetch already kicked off
      // the bootstrap request before React mounted. If so, await that promise
      // instead of issuing a redundant fetch. The inline script fires at
      // ~30-50ms after navigation start (HTML parse time); the React-side
      // useEffect previously didn't run until ~227ms. Awaiting the in-flight
      // promise gives us a 150-200ms head start on bootstrap.
      // Fails open: if the preload didn't fire (other route), no token, or
      // 4xx/5xx response, the global is undefined or resolves to null. In
      // all those cases we fall through to the normal fetchContracts() path
      // so behavior is identical to v0.50.
      if (typeof window !== 'undefined' && window.__lapseiqBootstrap && typeof window.__lapseiqBootstrap.then === 'function') {
        let cancelled = false;
        setLoading(true);
        setError('');
        (async () => {
          const body = await window.__lapseiqBootstrap;
          // Consume once; clear so subsequent re-mounts (SPA-nav back) don't
          // try to reuse stale data.
          window.__lapseiqBootstrap = null;
          if (cancelled) return;
          if (body && body.success && body.data) {
            const d = body.data;
            if (Array.isArray(d.contracts))   setContracts(d.contracts);
            if (d.pagination)                 setPagination(d.pagination);
            setScopeRestricted(d.scopeRestricted || false);
            if (Array.isArray(d.members))    setMembers(d.members);
            if (Array.isArray(d.vendors))    setVendorOptions(d.vendors);
            if (Array.isArray(d.categories)) setCategoryOptions(d.categories);
            if (d.settings && typeof d.settings.fiscalYearStartMonth === 'number') {
              setFyStartMonth(d.settings.fiscalYearStartMonth);
            }
            bootstrapDoneRef.current = true;
            setLoading(false);
            return;
          }
          // Preload failed (no token, 401, network) — fall back to normal flow
          fetchContracts();
        })();
        return () => { cancelled = true; };
      }
      // No preload available (normal cold load fallback)
      fetchContracts();
      return;
    }
    if (!bootstrapDoneRef.current) {
      // First fetch is in flight; skip queueing another to avoid the
      // 10x-bootstrap dupe-fire seen on v0.49.0.
      return;
    }
    const timer = setTimeout(fetchContracts, 300);
    return () => clearTimeout(timer);
  }, [queryParams]); // v0.49: deps now the memoized params, not the (now-stable) fetchContracts

  useEffect(() => { setPage(1); }, [filterParams]); // v0.49: same semantics, stable dep

  useEffect(() => {
    setLoading(true);
    setContracts([]);
  }, [viewMode]);

  const handleSort = (field) => {
    if (sort === field) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); }
    else { setSort(field); setSortDir('asc'); }
  };

  const hasFilters = search || statusFilter || renewalWindow || vendorId || endMonth || ownerId || categoryId || hasPO || evaluateBy || !hideExpired || activeColumnFilterCount > 0;

  function fmtMonthLabel(ym) {
    if (!ym) return '';
    const [yr, mo] = ym.split('-').map(Number);
    return new Date(yr, mo - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }

  // ── Bulk selection (list view only) ────────────────────────────────────────
  const [selected, setSelected] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMessage, setBulkMessage] = useState(null);
  const canBulk = features.contracts_write && (user?.role === 'admin' || user?.role === 'manager');

  useEffect(() => {
    setSelected(new Set());
  }, [search, statusFilter, renewalWindow, vendorId, endMonth, ownerId, evaluateBy, viewMode, hideExpired]);

  const visibleIds = contracts.map(c => c.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selected.has(id));
  const anyVisibleSelected = visibleIds.some(id => selected.has(id));

  const onToggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const onToggleAll = () => {
    setSelected(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());

  const selectionForTable = canBulk && viewMode === 'list' ? {
    selected,
    onToggle:           onToggleSelect,
    onToggleAll,
    allVisibleSelected,
    anyVisibleSelected,
  } : null;

  async function runBulkPatch(payload, successLabel) {
    setBulkBusy(true);
    setBulkMessage(null);
    try {
      const ids = Array.from(selected);
      const res = await api.patch('/api/contracts/bulk', { ids, ...payload });
      const d = res.data?.data || {};
      setBulkMessage({
        ok: true,
        text: `${successLabel}: ${d.updated} updated${d.matched < d.requested ? ` (${d.requested - d.matched} skipped — outside your scope or wrong account)` : ''}`,
      });
      clearSelection();
      fetchContracts();
    } catch (err) {
      setBulkMessage({ ok: false, text: err?.response?.data?.error || 'Bulk update failed.' });
    } finally {
      setBulkBusy(false);
      setTimeout(() => setBulkMessage(null), 6000);
    }
  }
  const bulkSetStatus  = (status) => runBulkPatch({ status },           `Status set to "${status}"`);
  const bulkSetOwner   = (ownerId) => runBulkPatch(
    { internalOwnerId: ownerId === '' ? null : ownerId },
    ownerId === '' ? 'Owner cleared' : 'Owner assigned'
  );
  const bulkArchive    = ()       => runBulkPatch({ archive: true  },   'Archived');

  async function bulkExportSelected() {
    setBulkBusy(true);
    setBulkMessage(null);
    try {
      const ids = Array.from(selected).join(',');
      const token = localStorage.getItem('lapseiq_token');
      const url = `${import.meta.env.VITE_API_URL ?? ''}/api/contracts/export?ids=${encodeURIComponent(ids)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `lapseiq-contracts-selected-${new Date().toISOString().split('T')[0]}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      setBulkMessage({ ok: true, text: `Exported ${selected.size} selected contract${selected.size === 1 ? '' : 's'}` });
    } catch {
      setBulkMessage({ ok: false, text: 'Export failed.' });
    } finally {
      setBulkBusy(false);
      setTimeout(() => setBulkMessage(null), 6000);
    }
  }

  const viewModes = [
    { id: 'list',    label: '≡ List' },
    { id: 'quarter', label: '⊞ Quarter' },
    { id: 'fiscal',  label: '🗓 Fiscal Year' },
    { id: 'coterm',  label: '🔗 Co-Term' },
  ];

  const showColumnPicker = viewMode !== 'coterm';

  // ── Saved views (v0.40 Phase 3) ─────────────────────────────────────────
  const currentViewState = useMemo(() => ({
    viewMode,
    search, statusFilter, renewalWindow,
    vendorId, vendorName, endMonth, ownerId, categoryId,
    hasPO, evaluateBy, hideExpired,
    sort, sortDir,
    columnVisibility,
  }), [
    viewMode, search, statusFilter, renewalWindow,
    vendorId, vendorName, endMonth, ownerId, categoryId,
    hasPO, evaluateBy, hideExpired, sort, sortDir, columnVisibility,
  ]);

  const applyView = (state) => {
    if (!state || typeof state !== 'object') return;
    if (typeof state.viewMode === 'string'
        && ['list','quarter','fiscal','coterm'].includes(state.viewMode)) {
      setViewMode(state.viewMode);
    }
    setSearch(typeof state.search === 'string' ? state.search : '');
    setStatusFilter(typeof state.statusFilter === 'string' ? state.statusFilter : '');
    setRenewalWindow(typeof state.renewalWindow === 'string' ? state.renewalWindow : '');
    setVendorId(typeof state.vendorId === 'string' ? state.vendorId : '');
    setVendorName(typeof state.vendorName === 'string' ? state.vendorName : '');
    setEndMonth(typeof state.endMonth === 'string' ? state.endMonth : '');
    setOwnerId(typeof state.ownerId === 'string' ? state.ownerId : '');
    setCategoryId(typeof state.categoryId === 'string' ? state.categoryId : '');
    setHasPO(typeof state.hasPO === 'string' ? state.hasPO : '');
    setEvaluateBy(typeof state.evaluateBy === 'string' ? state.evaluateBy : '');
    setHideExpired(typeof state.hideExpired === 'boolean' ? state.hideExpired : true);
    setSort(typeof state.sort === 'string' ? state.sort : 'endDate');
    setSortDir(state.sortDir === 'desc' ? 'desc' : 'asc');
    if (state.columnVisibility && typeof state.columnVisibility === 'object') {
      setColumnVisibility(state.columnVisibility);
    }
    setPage(1);
  };

  return (
    <>
      {showImport && (
        <CsvImportModal
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); fetchContracts(); }}
        />
      )}
      <div className="page-header">
        <div>
          {location.state?.from === 'dashboard' && (
            <button
              type="button"
              onClick={() => navigate('/dashboard')}
              style={{ background: 'none', border: 'none', padding: 0, marginBottom: 4, color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              aria-label="Back to dashboard"
            >
              {String.fromCharCode(8592)} Dashboard
            </button>
          )}
          <h1 className="page-title">
            Contracts
          </h1>
          <div className="page-subtitle">
            {pagination.total} contract{pagination.total !== 1 ? 's' : ''}
            {hasFilters ? ' · filtered' : ' total'}
            {vendorName && ` — ${vendorName}`}
            {endMonth && ` — ${fmtMonthLabel(endMonth)}`}
            {renewalWindow && ` — ${RENEWAL_LABELS[renewalWindow] || renewalWindow}`}
            {activeColumnFilterCount > 0 && (
              <>
                {' · '}
                <span
                  style={{
                    fontSize: 'var(--font-size-xs)',
                    fontWeight: 600,
                    padding: '1px 8px',
                    borderRadius: 10,
                    background: 'var(--color-primary-light)',
                    color: 'var(--color-primary)',
                    marginLeft: 2,
                  }}
                >
                  {activeColumnFilterCount} column filter{activeColumnFilterCount === 1 ? '' : 's'}
                </span>
                <button
                  type="button"
                  onClick={clearAllColumnFilters}
                  style={{
                    all: 'unset',
                    cursor: 'pointer',
                    marginLeft: 8,
                    fontSize: 'var(--font-size-sm)',
                    color: 'var(--color-primary)',
                    textDecoration: 'underline',
                  }}
                  title="Clear all column-header filters"
                >
                  Clear
                </button>
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {/* v0.46: always-visible Clear All Filters button. Disabled state
              when nothing to clear so the affordance is permanent and
              discoverable. */}
          <button
            className="btn btn-secondary"
            onClick={clearAllFilters}
            disabled={!hasFilters}
            title={hasFilters
              ? "Reset every active filter: search, status, vendor, owner, date ranges, value range, column-header dropdowns, and the 'hide expired' default."
              : "No filters active"}
            style={hasFilters
              ? { borderColor: 'var(--color-warning)', color: 'var(--color-warning)', fontWeight: 600 }
              : { opacity: 0.45, cursor: 'not-allowed' }}
          >
            <XIcon {...BTN_ICON} />Clear all filters
          </button>
          {/* v0.52: Add and Export dropdowns replace 5 individual toolbar
              buttons (Import CSV, Download view, Email view, Export CSV,
              Upload Doc). Less visual noise on the page header, fewer
              decisions for the user. New Contract stays standalone because
              it is the most-clicked action. See list-page-canonical-pattern
              docs Section 1.2 for the rationale. */}
          {(features.contracts_write || features.ingest) && (
            <ActionDropdown
              label="Import"
              icon={Upload}
              title="Import contracts into LapseIQ"
              items={[
                {
                  label: 'Import CSV',
                  icon: Upload,
                  hidden: !features.contracts_write,
                  onClick: () => setShowImport(true),
                  title: 'Bulk import contracts from a CSV or Excel file',
                },
                {
                  label: 'Import via PDF / AI Extraction',
                  icon: FileUp,
                  hidden: !features.ingest,
                  onClick: () => navigate('/ingest'),
                  title: 'Upload a contract PDF and let AI extract fields automatically — saves minutes of manual entry',
                },
              ]}
            />
          )}
          {features.export && (
            <ActionDropdown
              label="Export"
              icon={Download}
              title="Export contracts"
              items={[
                {
                  label: 'Download view as XLSX',
                  icon: Download,
                  onClick: handleExportView,
                  disabled: exporting,
                  title: 'Download an XLSX of contracts currently visible (visible columns + active filters)',
                },
                {
                  label: 'Email view',
                  icon: Mail,
                  onClick: handleEmailView,
                  disabled: exporting,
                  title: 'Download an XLSX and open your default mail client with a draft. Drag the file from the download bar onto the draft to attach.',
                },
                {
                  label: 'Export all as CSV',
                  icon: Download,
                  onClick: handleExportCsv,
                  title: 'Download all rows as CSV (legacy export, all columns)',
                },
              ]}
            />
          )}
          {features.contracts_write && (
            <button className="btn btn-primary" onClick={() => navigate('/contracts/new')}><Plus {...BTN_ICON} />New Contract</button>
          )}
        </div>
      </div>

      <div className="page-body">
        {scopeRestricted && (
          <div className="alert" style={{ background: 'var(--color-primary-light)', color: 'var(--color-primary-hover)', border: '1px solid #bfdbfe', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>👤</span>
            <span>Showing contracts assigned to you. Contact an admin to expand your access.</span>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', flex: '1 1 180px', maxWidth: 400 }}>
            <input
              type="text" className="search-input"
              placeholder="Search vendor, product, contract #, PO #…"
              value={search} onChange={e => setSearch(e.target.value)}
              style={{ width: '100%', paddingRight: search ? 26 : undefined }}
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                title="Clear search"
                style={{
                  position: 'absolute', right: 7, background: 'none', border: 'none',
                  cursor: 'pointer', color: 'var(--color-text-secondary)',
                  fontSize: 16, lineHeight: 1, padding: 0, display: 'flex', alignItems: 'center',
                }}
              >×</button>
            )}
          </div>

          {!statusFilter && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setHideExpired(h => !h)}
              style={{
                background:  hideExpired ? undefined : 'var(--color-primary)',
                color:       hideExpired ? undefined : 'var(--color-on-primary, white)',
                borderColor: hideExpired ? undefined : 'var(--color-primary)',
                whiteSpace: 'nowrap',
              }}
              title={hideExpired ? 'Expired contracts not shown — click to include them' : 'Showing all including expired'}
            >
              {hideExpired ? '+ Expired' : '− Expired'}
            </button>
          )}

          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setEndMonth(endMonth === currentMonthVal ? '' : currentMonthVal)}
            style={{
              background:  endMonth === currentMonthVal ? 'var(--color-primary)' : undefined,
              color:       endMonth === currentMonthVal ? 'var(--color-on-primary, white)' : undefined,
              borderColor: endMonth === currentMonthVal ? 'var(--color-primary)' : undefined,
              whiteSpace: 'nowrap',
            }}
            title="Show contracts expiring this calendar month"
          >
            This Month
          </button>

          {/* v0.45: "Mine" quick-toggle replaces the Owner='Mine' shortcut
              from the removed toolbar Owner dropdown. Click toggles between
              "only my contracts" and "all". */}
          {user?.id && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setOwnerId(ownerId === user.id ? '' : user.id)}
              style={{
                background:  ownerId === user.id ? 'var(--color-primary)' : undefined,
                color:       ownerId === user.id ? 'var(--color-on-primary, white)' : undefined,
                borderColor: ownerId === user.id ? 'var(--color-primary)' : undefined,
                whiteSpace: 'nowrap',
              }}
              title="Show only contracts assigned to me"
            >
              Mine
            </button>
          )}

          {renewalWindow && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setRenewalWindow('')}
              style={{
                background: 'var(--color-warning-bg)',
                color: 'var(--color-warning)',
                borderColor: 'var(--color-warning)',
                whiteSpace: 'nowrap',
                fontWeight: 600,
              }}
              title="Clear renewal filter"
            >
              {RENEWAL_LABELS[renewalWindow] || renewalWindow} ×
            </button>
          )}

          <div style={{ flex: 1 }} />

          <SavedViewsMenu
            storageKey={CONTRACTS_SAVED_VIEWS_KEY}
            currentState={currentViewState}
            onApply={applyView}
          />

          {showColumnPicker && (
            <ColumnPicker
              columns={CONTRACTS_COLUMNS}
              visibility={columnVisibility}
              onChange={setColumnVisibility}
              defaults={defaultContractsVisibility()}
            />
          )}

          <div style={{ display: 'flex', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', overflow: 'hidden', flexShrink: 0 }}>
            {viewModes.map((vm, idx) => (
              <button
                key={vm.id}
                onClick={() => setViewMode(vm.id)}
                style={{
                  padding: '5px 12px', fontSize: 'var(--font-size-sm)', fontWeight: 600,
                  border: 'none',
                  borderRight: idx < viewModes.length - 1 ? '1px solid var(--color-border)' : 'none',
                  cursor: 'pointer',
                  background: viewMode === vm.id ? 'var(--color-primary)' : 'var(--color-surface)',
                  color: viewMode === vm.id ? 'var(--color-on-primary, white)' : 'var(--color-text-secondary)',
                  transition: 'background 0.15s',
                  whiteSpace: 'nowrap',
                }}
              >
                {vm.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-16" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* v0.45: Vendor / Status / Owner toolbar dropdowns removed —
              column-header dropdowns (with (Blank) sentinel for Owner) now
              cover those workflows with multi-select. "Mine" shortcut moved
              to the row-1 quick-toggle button. */}

          <select
            aria-label="Filter by renewal window"
            className="filter-select"
            style={{ width: 170 }}
            value={renewalWindow}
            onChange={e => setRenewalWindow(e.target.value)}
          >
            <option value="">All Renewals</option>
            <option value="overdue">⚠ Overdue</option>
            <option value="expiringMonth">Expiring this month</option>
            <option value="renewing30">Expiring ≤ 30 days</option>
            <option value="renewing60">Expiring ≤ 60 days</option>
            <option value="renewing90">Expiring ≤ 90 days</option>
            <option value="cancel30">⚠ Auto-Renewal — Action Needed</option>
          </select>

          <select
            aria-label="Filter by evaluation date window"
            className="filter-select"
            style={{ width: 170 }}
            value={evaluateBy}
            onChange={e => setEvaluateBy(e.target.value)}
            title="Show contracts whose evaluation start date falls within this window"
          >
            <option value="">Evaluate By: Any</option>
            <option value="30">Evaluate By ≤ 30 days</option>
            <option value="60">Evaluate By ≤ 60 days</option>
            <option value="90">Evaluate By ≤ 90 days</option>
          </select>

        </div>

        {/* v0.46: pills row removed. The Clear All Filters button (page
            header, top-right) is the master indicator + reset. Column
            filter buttons in the secondary header row show their own
            "X selected" state. The toolbar dropdowns (Renewal/EvaluateBy)
            and quick-toggles (Mine, This Month, +/- Expired) carry their
            own active-state styling. No need for a separate pills row. */}

        {error && <div role="alert" className="alert alert-error">{error}</div>}

        <div className="card">
          {loading ? (
            <div className="loading" style={{ minHeight: 600 }}>Loading contracts…</div>
          ) : (viewMode !== 'coterm' && contracts.length === 0) ? (
            <EmptyState
              icon={hasFilters ? Search : FileText}
              title={hasFilters ? 'No contracts match your filters' : 'No contracts yet'}
              sub={hasFilters
                ? 'Try clearing a filter or two — your contract might be just outside the current window.'
                : 'Track your first contract to start surfacing renewal alerts, savings opportunities, and license utilization.'}
              ctaLabel={!hasFilters ? '+ New contract' : null}
              ctaOnClick={!hasFilters ? () => navigate('/contracts/new') : null}
            />
          ) : (
            <>
              {viewMode === 'list' && (
                <>
                  {selectionForTable && (
                    <BulkActionBar
                      count={selected.size}
                      busy={bulkBusy}
                      message={bulkMessage}
                      members={members}
                      canArchive={true}
                      onSetStatus={bulkSetStatus}
                      onSetOwner={bulkSetOwner}
                      onExport={bulkExportSelected}
                      onArchive={bulkArchive}
                      onClear={clearSelection}
                    />
                  )}
                  <ContractTable
                    contracts={contracts}
                    sort={sort} sortDir={sortDir} onSort={handleSort}
                    navigate={navigate}
                    selection={selectionForTable}
                    columnVisibility={columnVisibility}
                    showFilterRow={true}
                    columnFilters={columnFilters}
                    onColumnFilterChange={setColumnFilter}
                    fetchDistinctForColumn={fetchDistinctForColumn}
                  />
                  {pagination.pages > 1 && (
                    <div className="pagination">
                      <div className="pagination-info">
                        Showing {(pagination.page - 1) * pagination.limit + 1}–{Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}
                      </div>
                      <div className="pagination-controls">
                        <button className="page-btn" onClick={() => setPage(p => p - 1)} disabled={page === 1}>← Prev</button>
                        {Array.from({ length: pagination.pages }, (_, i) => i + 1)
                          .filter(p => Math.abs(p - page) <= 2)
                          .map(p => (
                            <button key={p} className={`page-btn${p === page ? ' active' : ''}`} onClick={() => setPage(p)}>{p}</button>
                          ))}
                        <button className="page-btn" onClick={() => setPage(p => p + 1)} disabled={page === pagination.pages}>Next →</button>
                      </div>
                    </div>
                  )}
                </>
              )}

              {viewMode === 'quarter' && (
                <QuarterView
                  contracts={contracts}
                  fyStartMonth={fyStartMonth}
                  sort={sort} sortDir={sortDir} onSort={handleSort}
                  navigate={navigate}
                  columnVisibility={columnVisibility}
                />
              )}

              {viewMode === 'fiscal' && (
                <FiscalYearView
                  contracts={contracts}
                  fyStartMonth={fyStartMonth}
                  navigate={navigate}
                  sort={sort} sortDir={sortDir} onSort={handleSort}
                  columnVisibility={columnVisibility}
                />
              )}

              {viewMode === 'coterm' && (
                <CotermView navigate={navigate} />
              )}
            </>
          )}
        </div>
      </div>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
