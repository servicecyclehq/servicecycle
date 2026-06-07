// ─────────────────────────────────────────────────────────────────────────────
// ActivityLogPage.jsx — v0.70.1 canonical-pattern propagation
//
// Inherits the /contracts canonical list-page filter behavior (per
// docs/design/list-page-canonical-pattern.md Section 4.3) onto a feed-style
// page. Activity is chronological by design, so it stays a feed not a table —
// the propagation is about the filter primitives + URL sync + saved views,
// not visual table conversion.
//
// What landed in v0.70.1:
//   • ColumnFilterDropdown for Action (multiselect) + User (multiselect) — the
//     same Excel-style typeahead-checkbox primitive used on /contracts and
//     /alerts.
//   • ColumnDateRangeButton for Date (single-button popover replaces the
//     pair of plain <select> filters from the legacy chrome).
//   • URL-synced filter state via f_<columnId>=<JSON> keys (so back-button
//     + share-links round-trip).
//   • Cross-device saved views via useUserPreference('lapseiq:activity-log:
//     saved-views').
//   • Server-side distinct values via GET /api/activity/distinct/:column with
//     Excel narrowing semantics (the requested column's own filter is dropped
//     before the count).
//   • Header chrome migrated to .page-title (brand-tinted) + .page-subtitle
//     so the activity log matches the rest of the SPA.
//   • Clear-all-filters in the page header, amber-warning styled when active.
//   • Inline column-filter count + Clear link in page subtitle.
//
// Preserved verbatim from pre-v0.70:
//   • Feed layout (avatar + action badge + user + contract link + relative
//     time) — this is the page's primary affordance and works well.
//   • ?contractId= deep-link from "View all →" on the contract detail page.
//   • Server-side pagination at 50 rows per page.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Download, Mail, ShieldCheck } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useUserPreference } from '../hooks/useUserPreference';
import ColumnFilterDropdown from '../components/ColumnFilterDropdown';
import ColumnDateRangeButton from '../components/ColumnDateRangeButton';
import SavedViewsMenu from '../components/SavedViewsMenu';
import ActionDropdown from '../components/ActionDropdown';
import Toast from '../components/Toast';
import { downloadAuthedFile } from '../api/download';
import EmptyState from '../components/EmptyState';
import { ClipboardList } from 'lucide-react';

// ── Constants ────────────────────────────────────────────────────────────────

const ACTIVITY_SAVED_VIEWS_KEY = 'lapseiq:activity-log:saved-views';
const BLANK_SENTINEL = '__BLANK__';

// Filter column registry — drives the URL-sync round-trip and the saved-view
// payload shape. Mirrors the meta block on /contracts + /alerts columns.
const FILTER_COLUMNS = [
  { id: 'action', label: 'Action', filterType: 'multiselect', filterParam: 'actionIn' },
  { id: 'user',   label: 'User',   filterType: 'multiselect', filterParam: 'userIdIn' },
  { id: 'date',   label: 'Date',   filterType: 'daterange',
    filterParam: { from: 'dateFrom', to: 'dateTo' } },
];

const ACTION_META = {
  contract_created:     { label: 'Contract added',          color: 'var(--color-success)',  bg: 'var(--color-success-bg)' },
  status_changed:       { label: 'Status changed',          color: 'var(--color-primary)',  bg: 'var(--color-primary-light)' },
  owner_assigned:       { label: 'Owner assigned',          color: 'var(--color-renewal-text)',               bg: 'var(--color-renewal-bg)' },
  fields_updated:       { label: 'Fields updated',          color: 'var(--color-info)',     bg: 'var(--color-info-bg)' },
  checklist_updated:    { label: 'Checklist updated',       color: 'var(--color-info)',     bg: 'var(--color-info-bg)' },
  contract_renewed:     { label: 'Contract renewed',        color: 'var(--color-warning)',  bg: 'var(--color-warning-bg)' },
  contract_cancelled:   { label: 'Contract cancelled',      color: 'var(--color-danger)',   bg: 'var(--color-danger-bg)' },
  brief_generated:      { label: 'Renewal brief generated', color: 'var(--color-renewal-text)',               bg: 'var(--color-renewal-bg)' },
  document_uploaded:    { label: 'Document uploaded',       color: 'var(--color-info)',     bg: 'var(--color-info-bg)' },
  user_created:         { label: 'User added',              color: 'var(--color-success)',  bg: 'var(--color-success-bg)' },
  login_failed:         { label: 'Failed login attempt',    color: 'var(--color-danger)',   bg: 'var(--color-danger-bg)' },
  permission_denied:    { label: 'Permission denied',       color: 'var(--color-danger)',   bg: 'var(--color-danger-bg)' },
  document_accessed:    { label: 'Document accessed',       color: 'var(--color-info)',     bg: 'var(--color-info-bg)' },
  admin_password_reset: { label: 'Admin password reset',    color: 'var(--color-warning)',  bg: 'var(--color-warning-bg)' },
  account_created:      { label: 'Account created',         color: 'var(--color-success)',  bg: 'var(--color-success-bg)' },
  login_success:        { label: 'Signed in',               color: 'var(--color-text-secondary)', bg: 'var(--color-bg)' },
  category_created:     { label: 'Category created',        color: 'var(--color-info)',     bg: 'var(--color-info-bg)' },
  category_updated:     { label: 'Category updated',        color: 'var(--color-info)',     bg: 'var(--color-info-bg)' },
  category_archived:    { label: 'Category archived',       color: 'var(--color-warning)',  bg: 'var(--color-warning-bg)' },
  category_restored:    { label: 'Category restored',       color: 'var(--color-success)',  bg: 'var(--color-success-bg)' },
  custom_field_created: { label: 'Custom field created',    color: 'var(--color-info)',     bg: 'var(--color-info-bg)' },
  custom_field_updated: { label: 'Custom field updated',    color: 'var(--color-info)',     bg: 'var(--color-info-bg)' },
  custom_field_archived:{ label: 'Custom field archived',   color: 'var(--color-warning)',  bg: 'var(--color-warning-bg)' },
  custom_field_restored:{ label: 'Custom field restored',   color: 'var(--color-success)',  bg: 'var(--color-success-bg)' },
};

const STATUS_LABELS = {
  active:       'Active',
  under_review: 'Under review',
  pending:      'Pending',
  expired:      'Expired',
  cancelled:    'Cancelled',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    + ' · '
    + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtRelative(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);
  if (mins  < 2)  return 'just now';
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days  < 7)  return `${days} days ago`;
  return '';
}

function detailSummary(action, details) {
  if (!details) return null;
  switch (action) {
    case 'contract_created':
      return details.vendorName
        ? `${details.product || 'New contract'} · ${details.vendorName}`
        : details.clonedFrom ? 'Cloned from renewal' : null;
    case 'status_changed':
      return `${STATUS_LABELS[details.from] || details.from} → ${STATUS_LABELS[details.to] || details.to}`;
    case 'fields_updated':
      if (!Array.isArray(details.fields) || details.fields.length === 0) return null;
      return details.fields.slice(0, 4).join(', ')
        + (details.fields.length > 4 ? ` +${details.fields.length - 4} more` : '');
    case 'checklist_updated': {
      const added   = details.checked?.length   || 0;
      const removed = details.unchecked?.length || 0;
      const parts   = [];
      if (added)   parts.push(`${added} item${added   !== 1 ? 's' : ''} checked`);
      if (removed) parts.push(`${removed} item${removed !== 1 ? 's' : ''} unchecked`);
      return parts.join(', ') || null;
    }
    case 'contract_renewed':
      return 'Renewal contract created';
    case 'contract_cancelled':
      return details.from ? `Was ${STATUS_LABELS[details.from] || details.from}` : null;
    case 'brief_generated':
      return details.refresh ? 'Refreshed' : 'Generated';
    default:
      return null;
  }
}

function UserAvatar({ name }) {
  // v0.91.15: neutralized per design-system-spec-v0.91 section 6.5.
  // Was a 7-color hash-to-hue palette which made the log feed read as
  // a barcode. Single neutral matches the rest of the chrome (status pills
  // and day chips already carry the semantic color load on this page).
  const initials = (name || '?')
    .split(' ')
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <div style={{
      width: 30, height: 30, borderRadius: '50%',
      background: 'var(--color-border)',
      color: 'var(--color-text-secondary)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '0.7rem', fontWeight: 700, flexShrink: 0, letterSpacing: '0.02em',
    }}>
      {initials}
    </div>
  );
}

function columnFiltersToRecord(arr) {
  const out = {};
  for (const f of arr || []) {
    if (f && f.id != null && f.value != null) out[f.id] = f.value;
  }
  return out;
}

// Apply one canonical-pattern filter value into URLSearchParams.
function appendColumnFilterParam(params, col, value) {
  if (value == null) return;
  if (col.filterType === 'multiselect' && Array.isArray(value) && value.length > 0) {
    if (typeof col.filterParam === 'string') params.set(col.filterParam, value.join(','));
  } else if (col.filterType === 'daterange' && typeof value === 'object'
             && col.filterParam && typeof col.filterParam === 'object') {
    if (value.from) params.set(col.filterParam.from, value.from);
    if (value.to)   params.set(col.filterParam.to,   value.to);
  }
}

// v0.71.0: build the URL query for /api/export/activity mirroring the active
// filter state. Used by the toolbar Export ▼ dropdown.
function buildActivityExportParams({ columnFilters, contractId }) {
  const params = new URLSearchParams();
  const record = columnFiltersToRecord(columnFilters);
  for (const col of FILTER_COLUMNS) {
    appendColumnFilterParam(params, col, record[col.id]);
  }
  if (contractId) params.set('contractId', contractId);
  return params;
}

// ── Main page ───────────────────────────────────────────────────────────────

export default function ActivityLogPage() {
  useDocumentTitle('Activity log');
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // Optional ?contractId= narrows the log to a single contract. Sourced from
  // URL so deep-links from the contract detail "View all →" work.
  const contractId = searchParams.get('contractId') || '';

  const [logs,       setLogs]       = useState([]);
  const [users,      setUsers]      = useState([]);
  const [userLabels, setUserLabels] = useState({}); // {[id]: 'Name'} for dropdown render
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0, limit: 50 });
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [contractContext, setContractContext] = useState(null);
  const [page,       setPage]       = useState(1);
  const [exporting,  setExporting]  = useState(false);
  const [verifying,  setVerifying]  = useState(false);
  const [toast,      setToast]      = useState(null);

  // ── Canonical-pattern state ──────────────────────────────────────────────
  const [columnFilters, setColumnFilters] = useState(() => {
    const init = [];
    for (const col of FILTER_COLUMNS) {
      const raw = searchParams.get('f_' + col.id);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (parsed != null) init.push({ id: col.id, value: parsed });
      } catch { /* malformed, skip */ }
    }
    return init;
  });

  // Sync columnFilters → URL (f_<columnId>=<JSON>)
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const allFilterKeys = FILTER_COLUMNS.map(c => 'f_' + c.id);
    for (const k of allFilterKeys) next.delete(k);
    const record = columnFiltersToRecord(columnFilters);
    for (const [id, val] of Object.entries(record)) {
      if (val == null) continue;
      const isEmptyArr = Array.isArray(val) && val.length === 0;
      const isEmptyRange = !Array.isArray(val) && typeof val === 'object' && val !== null
        && !val.from && !val.to;
      if (isEmptyArr || isEmptyRange) continue;
      next.set('f_' + id, JSON.stringify(val));
    }
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnFilters]);

  // Reset to page 1 whenever filters change
  useEffect(() => { setPage(1); }, [columnFilters]);

  // ── Data fetch ───────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      if (contractId) params.set('contractId', contractId);
      const record = columnFiltersToRecord(columnFilters);
      for (const col of FILTER_COLUMNS) {
        appendColumnFilterParam(params, col, record[col.id]);
      }
      const r = await api.get('/api/activity', { params: Object.fromEntries(params) });
      const d = r.data;
      if (!d.success) throw new Error(d.error || 'Failed to load');
      setLogs(d.data.logs);
      setPagination(d.data.pagination);
      if (d.data.users?.length) {
        setUsers(d.data.users);
        setUserLabels(prev => {
          const next = { ...prev };
          for (const u of d.data.users) next[u.id] = u.name || u.email || u.id;
          return next;
        });
      }
      const firstWithContract = d.data.logs?.find(l => l.contract);
      if (firstWithContract) setContractContext(firstWithContract.contract);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [page, contractId, columnFilters]);

  useEffect(() => { load(); }, [load]);

  // ── Distinct fetcher with Excel narrowing ────────────────────────────────
  const fetchDistinctForColumn = useCallback(async (columnId) => {
    const params = new URLSearchParams();
    const record = columnFiltersToRecord(columnFilters);
    for (const col of FILTER_COLUMNS) {
      if (col.id === columnId) continue; // Excel narrowing: drop the requested column's own filter
      appendColumnFilterParam(params, col, record[col.id]);
    }
    if (contractId) params.set('contractId', contractId);
    const url = '/api/activity/distinct/' + columnId + (params.toString() ? '?' + params.toString() : '');
    const res = await api.get(url);
    if (res.data?.labels) {
      // Cache labels so the dropdown button + saved-view chip can render
      // user names instead of raw ids.
      setUserLabels(prev => ({ ...prev, ...res.data.labels }));
    }
    return res.data?.values || [];
  }, [columnFilters, contractId]);

  // ── Saved-view state ─────────────────────────────────────────────────────
  const currentViewState = useMemo(() => ({ columnFilters }), [columnFilters]);

  const applyView = (state) => {
    if (!state || typeof state !== 'object') return;
    if (Array.isArray(state.columnFilters)) setColumnFilters(state.columnFilters);
  };

  const clearAllFilters = useCallback(() => {
    setColumnFilters([]);
  }, []);

  // ── Export handlers (v0.71.0) ─────────────────────────────────────────────
  async function handleExportView() {
    if (exporting) return;
    setExporting(true);
    try {
      const params = buildActivityExportParams({ columnFilters, contractId });
      const url = `${import.meta.env.VITE_API_URL ?? ''}/api/export/activity?${params}`;
      await downloadAuthedFile(url, `Activity-${new Date().toISOString().split('T')[0]}.xlsx`);
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
      const params = buildActivityExportParams({ columnFilters, contractId });
      const url = `${import.meta.env.VITE_API_URL ?? ''}/api/export/activity?${params}`;
      setToast({ title: 'Preparing export…', message: 'Building your file — this may take a moment.', variant: 'info', duration: 5000 });
      const { filename } = await downloadAuthedFile(url, `Activity-${new Date().toISOString().split('T')[0]}.xlsx`);
      const subject = `Activity log — ${new Date().toISOString().split('T')[0]}`;
      const body =
        `Please find attached the activity log (${filename}).\n\n` +
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

  // ── Render derivations ──────────────────────────────────────────────────
  async function handleVerifyChain() {
    if (verifying) return;
    setVerifying(true);
    try {
      const res = await api.get('/admin/audit-chain/verify');
      const { ok, total, breakAt, verifiedAt } = res.data?.data ?? {};
      if (ok) {
        setToast({
          title: 'Chain intact',
          message: `All ${total} settled entries verified OK at ${new Date(verifiedAt).toLocaleTimeString()}.`,
          variant: 'success',
          duration: 8000,
        });
      } else {
        setToast({
          title: 'Chain break detected',
          message: `${breakAt?.length ?? '?'} break(s) found in ${total} entries. IDs: ${(breakAt ?? []).slice(0, 3).join(', ')}${breakAt?.length > 3 ? '…' : ''}`,
          variant: 'error',
          duration: 15000,
        });
      }
    } catch (e) {
      setToast({ title: 'Verify failed', message: e.response?.data?.error || e.message, variant: 'error', duration: 8000 });
    } finally {
      setVerifying(false);
    }
  }

  const record         = columnFiltersToRecord(columnFilters);
  const hasFilters     = columnFilters.length > 0;
  const filterValue    = (id) => record[id];
  const setFilterValue = (id) => (val) => {
    setColumnFilters((prev) => {
      const next = prev.filter(f => f.id !== id);
      if (val != null) {
        const isEmptyArr = Array.isArray(val) && val.length === 0;
        const isEmptyRange = !Array.isArray(val) && typeof val === 'object' && val !== null
          && !val.from && !val.to;
        if (!isEmptyArr && !isEmptyRange) next.push({ id, value: val });
      }
      return next;
    });
  };

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Activity Log</h1>
          <div className="page-subtitle">
            {loading
              ? 'Loading…'
              : pagination.total === 0
                ? 'No activity found' + (hasFilters || contractId ? ' matching these filters' : '')
                : `${pagination.total.toLocaleString()} event${pagination.total !== 1 ? 's' : ''}`}
            {hasFilters && !loading && (
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
            {contractId && contractContext && (
              <>
                {' · '}Filtered to{' '}
                <Link
                  to={`/contracts/${contractId}`}
                  style={{ color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 600 }}
                >
                  {contractContext.product || 'this contract'}
                  {contractContext.vendor?.name && (
                    <span style={{ fontWeight: 400, color: 'var(--color-text-secondary)' }}> · {contractContext.vendor.name}</span>
                  )}
                </Link>
                {' '}·{' '}
                <button
                  type="button"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete('contractId');
                    setSearchParams(next, { replace: true });
                    setPage(1);
                  }}
                  style={{
                    all: 'unset', cursor: 'pointer',
                    color: 'var(--color-primary)', textDecoration: 'underline',
                    fontSize: 'inherit',
                  }}
                >
                  Clear contract filter
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
            storageKey={ACTIVITY_SAVED_VIEWS_KEY}
            currentState={currentViewState}
            onApply={applyView}
          />
          {!loading && pagination.total > 0 && (
            <ActionDropdown
              label="Export"
              icon={Download}
              title="Export activity log"
              items={[
                {
                  label: 'Download view as XLSX',
                  icon: Download,
                  onClick: handleExportView,
                  disabled: exporting,
                  title: 'Download an XLSX of the activity log matching the active filters',
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
          {user?.role === 'admin' && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleVerifyChain}
              disabled={verifying}
              title="Run audit-chain integrity check (admin only)"
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <ShieldCheck size={14} />
              {verifying ? 'Verifying…' : 'Verify chain'}
            </button>
          )}
        </div>
      </div>

      <div className="page-body">
        {/* ── Filter strip ──────────────────────────────────────────────── */}
        <div className="mb-16" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 160 }}>
            <ColumnFilterDropdown
              columnId="action"
              label="Action"
              value={Array.isArray(filterValue('action')) ? filterValue('action') : []}
              onChange={setFilterValue('action')}
              fetchDistinct={() => fetchDistinctForColumn('action')}
              formatValue={(v) => ACTION_META[v]?.label || v}
            />
          </div>
          <div style={{ minWidth: 160 }}>
            <ColumnFilterDropdown
              columnId="user"
              label="User"
              value={Array.isArray(filterValue('user')) ? filterValue('user') : []}
              onChange={setFilterValue('user')}
              fetchDistinct={() => fetchDistinctForColumn('user')}
              formatValue={(v) => userLabels[v] || v}
            />
          </div>
          <div style={{ minWidth: 200 }}>
            <ColumnDateRangeButton
              label="Date"
              value={filterValue('date')}
              onChange={setFilterValue('date')}
            />
          </div>
        </div>

        {/* ── Feed ─────────────────────────────────────────────────────── */}
        {loading ? (
          <div style={{ padding: '3rem 0', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>
            Loading activity…
          </div>
        ) : error ? (
          <div role="alert" className="alert alert-error">{error}</div>
        ) : logs.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title={hasFilters || contractId ? 'No activity matching these filters' : 'No activity yet'}
            sub={hasFilters || contractId ? 'Try adjusting or clearing your filters to see more entries.' : 'Activity log entries appear here as contracts are created, updated, and accessed.'}
            ctaLabel={hasFilters || contractId ? 'Clear filters' : undefined}
            ctaOnClick={hasFilters || contractId ? () => setSearchParams(new URLSearchParams()) : undefined}
          />
        ) : (
          <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, overflow: 'hidden', background: 'var(--color-surface)' }}>
            {logs.map((log, i) => {
              const meta    = ACTION_META[log.action] || { label: log.action, color: 'var(--color-text-secondary)', bg: 'var(--color-bg)' };
              const detail  = detailSummary(log.action, log.details);
              const relTime = fmtRelative(log.createdAt);
              const isLast  = i === logs.length - 1;
              return (
                <div
                  key={log.id}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 14,
                    padding: '12px 16px',
                    borderBottom: isLast ? 'none' : '1px solid var(--color-border)',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--color-bg)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <UserAvatar name={log.user?.name} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 3 }}>
                      <span style={{
                        fontSize: '0.72rem', fontWeight: 700, padding: '2px 7px',
                        borderRadius: 4, background: meta.bg, color: meta.color,
                        whiteSpace: 'nowrap',
                      }}>
                        {meta.label}
                      </span>
                      <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--color-text)' }}>
                        {log.user?.name || 'System / deleted user'}
                      </span>
                      {log.contract && (
                        <>
                          <span style={{ color: 'var(--color-text-secondary)', fontSize: '0.78rem' }}>on</span>
                          <Link
                            to={`/contracts/${log.contract.id}`}
                            style={{ fontSize: '0.82rem', color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 500 }}
                            onMouseEnter={e => e.target.style.textDecoration = 'underline'}
                            onMouseLeave={e => e.target.style.textDecoration = 'none'}
                          >
                            {log.contract.product}
                            {log.contract.vendor?.name && (
                              <span style={{ color: 'var(--color-text-secondary)', fontWeight: 400 }}>
                                {' '}· {log.contract.vendor.name}
                              </span>
                            )}
                          </Link>
                        </>
                      )}
                    </div>
                    {detail && (
                      <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginTop: 1 }}>
                        {detail}
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 120 }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                      {relTime || fmtDateTime(log.createdAt).split(' · ')[0]}
                    </div>
                    {relTime && (
                      <div style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)', opacity: 0.7, whiteSpace: 'nowrap' }}>
                        {fmtDateTime(log.createdAt).split(' · ')[1]}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Pagination ──────────────────────────────────────────────── */}
        {pagination.pages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem' }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              ← Previous
            </button>
            <span style={{ fontSize: '0.825rem', color: 'var(--color-text-secondary)' }}>
              Page {pagination.page} of {pagination.pages}
            </span>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setPage(p => Math.min(pagination.pages, p + 1))}
              disabled={page === pagination.pages}
            >
              Next →
            </button>
          </div>
        )}
      </div>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
