// ─────────────────────────────────────────────────────────────────────────────
// contractsColumns.jsx — Phase 1A of the v0.40+ table-control roadmap
// (see memory: lapseiq-roadmap-table-control-export).
//
// Column registry for the Contracts list table. Each entry has:
//   • id           — stable identifier (used for state + localStorage)
//   • header       — human label rendered in the <th>
//   • sortField    — server-side sort key. null → unsortable column.
//   • widthPct     — colgroup width (sums roughly to 100% with the optional
//                    leading-checkbox column). Strings, not numbers, so
//                    table-layout:fixed + the existing CSS-Grid filter
//                    alignment continue to agree (see CONTRACTS_COL_WIDTHS
//                    history in ContractsList.jsx pre-refactor).
//   • alignRight   — right-align both <th> label AND every <td> body cell
//   • defaultVisible — initial visibility for fresh users / no localStorage
//   • accessor     — value used for export, future filtering, and TanStack's
//                    internal sort/group machinery. NOT used for the visual
//                    cell — that's `cell`.
//   • cell         — function (contract) → ReactNode rendered inside the <td>.
//                    The wrapping <td> is provided by the table renderer so
//                    alignment + width are applied consistently.
//
// The leading select checkbox column is intentionally NOT in this registry —
// it's driven by the `selection` prop on ContractTable and is shown/hidden
// based on bulk-permission, not user preference. Hiding the select column
// via the column-picker would be a footgun.
//
// Phase 1B will extend each entry with `filterType` (text/enum/date/number)
// and a server-side `filterField` once per-column filtering ships. Saved
// views are Phase 1C.
// ─────────────────────────────────────────────────────────────────────────────

import { createColumnHelper } from '@tanstack/react-table';
import { renewalUrgency, URGENCY_CHIP_CLASS } from '../lib/urgency';

// ── Formatters ────────────────────────────────────────────────────────────────
// Pure helpers. Duplicated-by-design from ContractsList.jsx so this module
// has no upward import dependency (avoiding the circular import that would
// arise if columns imported from a page that imports columns).

export function fmt(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const diff = new Date(dateStr) - new Date();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

export function DaysChip({ dateStr }) {
  const days = daysUntil(dateStr);
  if (days === null) return <span className="text-muted">—</span>;
  let cls = 'days-chip-ok';
  let label = `${days} days`;
  if (days < 0)        { cls = 'days-chip-overdue'; label = `${Math.abs(days)} days`; }
  else if (days <= 14) { cls = 'days-chip-overdue'; }
  else if (days <= 30) { cls = 'days-chip-urgent'; }
  else if (days <= 60) { cls = 'days-chip-soon'; }
  return <span className={`days-chip ${cls}`}>{label}</span>;
}

const STATUS_LABELS = {
  active:       'Active',
  under_review: 'Under Review',
  renewed:      'Renewed',
  cancelled:    'Cancelled',
  expired:      'Expired',
};

export function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABELS[status] || status}</span>;
}

export function formatCurrency(cost, qty) {
  if (!cost || !qty) return '—';
  const total = parseFloat(cost) * parseInt(qty);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(total);
}

// ── Column registry ───────────────────────────────────────────────────────────

const ch = createColumnHelper();

export const CONTRACTS_COLUMNS = [
  ch.accessor(c => c.vendor?.name ?? '', {
    id: 'vendor',
    header: 'Vendor',
    cell: ({ row }) => <span style={{ fontWeight: 600 }}>{row.original.vendor?.name || '—'}</span>,
    meta: {
      sortField:      'vendor',
      widthPct:       '12%',
      alignRight:     false,
      defaultVisible: true,
      label:          'Vendor',
      filterType:     'multiselect', // v0.44 — Excel-style checkbox dropdown
      filterParam:    'vendorIn',
      distinctColumn: 'vendor',      // backend /api/contracts/distinct/:column key
    },
  }),

  ch.accessor(c => c.product ?? '', {
    id: 'product',
    header: 'Product',
    cell: ({ row }) => {
      const c = row.original;
      return (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            {c.category?.icon && (
              <span
                title={c.category.name}
                aria-label={`Category: ${c.category.name}`}
                style={{ fontSize: 'var(--font-size-ui)', lineHeight: 1, flexShrink: 0 }}
              >
                {c.category.icon}
              </span>
            )}
            <span>{c.product}</span>
          </div>
          {c.contractNumber && (
            <div className="text-secondary" style={{ fontSize: 'var(--font-size-xs)', marginTop: 2 }}>
              {c.contractNumber}
            </div>
          )}
        </>
      );
    },
    meta: {
      sortField:      'product',
      widthPct:       '19%',
      alignRight:     false,
      defaultVisible: true,
      label:          'Product',
      filterType:     'multiselect',
      filterParam:    'productIn',
      distinctColumn: 'product',
    },
  }),

  // v0.45: Category column. Multi-select dropdown with (Blank) sentinel for
  // contracts with no categoryId. Backend supports sort via { category: {
  // name } } but we leave sortField: null for now — common workflow is filter
  // by category, not sort by it.
  ch.accessor(c => c.category?.name ?? '', {
    id: 'category',
    header: 'Category',
    cell: ({ row }) => {
      const cat = row.original.category;
      if (!cat) return <span className="text-muted">—</span>;
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {cat.icon && <span aria-hidden="true">{cat.icon}</span>}
          <span>{cat.name}</span>
        </span>
      );
    },
    meta: {
      sortField:      null,
      widthPct:       '13%',
      alignRight:     false,
      defaultVisible: true,
      label:          'Category',
      filterType:     'multiselect',
      filterParam:    'categoryIn',
      distinctColumn: 'category',
    },
  }),

  ch.accessor(c => c.internalOwner?.name ?? '', {
    id: 'owner',
    header: 'Owner',
    cell: ({ row }) =>
      row.original.internalOwner?.name
        ? <span>{row.original.internalOwner.name}</span>
        : <span className="text-muted">Unassigned</span>,
    meta: {
      sortField:      'owner',
      widthPct:       '10%',
      alignRight:     false,
      defaultVisible: true,
      label:          'Owner',
      filterType:     'multiselect',
      filterParam:    'ownerIn',
      distinctColumn: 'owner',
    },
  }),

  ch.display({
    id: 'status',
    header: 'Status',
    cell: ({ row }) => {
      const c = row.original;
      const cancelDays = daysUntil(c.cancelByDate);
      const isTrap = c.autoRenewal && cancelDays !== null && cancelDays >= 0 && cancelDays <= 30;
      return (
        // v0.91.1: stack the auto-renew indicator BELOW the status pill so the
        // icon + text always sit on one line under the badge instead of wrapping
        // mid-string in narrow cells. Same treatment for the red ⚠ trap state.
        <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <StatusBadge status={c.status} />
          {c.autoRenewal && (
            <span
              title={isTrap ? 'Auto-renews within the cancel window' : 'Auto-renewal is ON'}
              style={{
                fontSize: 'var(--font-size-xs)',
                fontWeight: 700,
                whiteSpace: 'nowrap',
                color: isTrap ? 'var(--color-danger)' : 'var(--color-warning)',
              }}
            >
              {isTrap ? '⚠ Auto' : '↻ Auto'}
            </span>
          )}
        </span>
      );
    },
    meta: {
      sortField:      null,
      widthPct:       '11%',
      alignRight:     false,
      defaultVisible: true,
      label:          'Status',
      filterType:     'multiselect',
      filterParam:    'statusIn',
      distinctColumn: 'status',
      // Render snake_case enums as Title Case in the dropdown
      formatValue:    (v) => ({
        active:       'Active',
        under_review: 'Under Review',
        renewed:      'Renewed',
        cancelled:    'Cancelled',
        expired:      'Expired',
      }[v] || v),
    },
  }),

  ch.accessor(c => c.endDate ?? '', {
    id: 'endDate',
    header: 'End Date',
    cell: ({ row }) => {
      const c = row.original;
      return (
        <>
          <div>{fmt(c.endDate)}</div>
          {c.endDate && (() => { const u = renewalUrgency(c); if (u === 'neutral') return null; const days = daysUntil(c.endDate); const cls = URGENCY_CHIP_CLASS[u] || 'days-chip-ok'; return <span className={`days-chip ${cls}`}>{Math.abs(days)} days</span>; })()}
        </>
      );
    },
    meta: {
      sortField:      'endDate',
      widthPct:       '10%',
      alignRight:     true,
      defaultVisible: true,
      label:          'End Date',
      filterType:     'daterange',
      filterParam:    { from: 'endDateFrom', to: 'endDateTo' },
    },
  }),

  ch.accessor(c => c.evaluationStartByDate ?? '', {
    id: 'evaluationStart',
    header: 'Evaluate By',
    cell: ({ row }) => {
      const c = row.original;
      return (
        <>
          <div>{fmt(c.evaluationStartByDate)}</div>
          {c.status === 'under_review' ? (
            <span
              className="days-chip"
              style={{
                background: 'var(--color-primary-light)',
                color: 'var(--color-primary)',
                borderColor: 'var(--color-info)',
              }}
            >
              In review
            </span>
          ) : c.status === 'active' && c.evaluationStartByDate ? (
            <DaysChip dateStr={c.evaluationStartByDate} />
          ) : null}
        </>
      );
    },
    meta: {
      sortField:      'evaluationStartByDate',
      widthPct:       '9%',
      alignRight:     true,
      defaultVisible: true,
      label:          'Evaluate By',
      filterType:     'daterange',
      filterParam:    { from: 'evalStartFrom', to: 'evalStartTo' },
    },
  }),

  ch.accessor(c => c.cancelByDate ?? '', {
    id: 'cancelBy',
    header: 'Cancel By',
    cell: ({ row }) => {
      const c = row.original;
      if (!(c.autoRenewal && c.cancelByDate)) return <span className="text-muted">—</span>;
      const cancelDays = daysUntil(c.cancelByDate);
      const isTrap = cancelDays !== null && cancelDays >= 0 && cancelDays <= 30;
      const isTerminal = renewalUrgency(c) === 'neutral'; // renewed/cancelled/expired -> no overdue chip
      return (
        <>
          <div style={{ fontWeight: isTrap ? 700 : 400 }}>{fmt(c.cancelByDate)}</div>
          {!isTerminal && <DaysChip dateStr={c.cancelByDate} />}
        </>
      );
    },
    meta: {
      sortField:      'cancelByDate',
      widthPct:       '9%',
      alignRight:     true,
      defaultVisible: true,
      label:          'Cancel By',
      filterType:     'daterange',
      filterParam:    { from: 'cancelByFrom', to: 'cancelByTo' },
    },
  }),

  ch.display({
    id: 'poNumbers',
    header: 'PO Numbers',
    cell: ({ row }) => {
      const c = row.original;
      const count  = c._count?.purchaseOrders ?? 0;
      const recent = (c.purchaseOrders && c.purchaseOrders[0]) || null;
      if (count === 0 && !c.poNumber) return <span className="text-muted">—</span>;
      if (count === 0 && c.poNumber)  return <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--font-size-sm)' }}>{c.poNumber}</span>;
      return (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--font-size-sm)', fontWeight: 500 }}>
            {recent?.poNumber || '—'}
          </span>
          {count > 1 && (
            <span
              title={`${count} POs under this contract`}
              style={{
                fontSize: 'var(--font-size-2xs)',
                fontWeight: 600,
                background: 'var(--color-primary-light)',
                color: 'var(--color-primary)',
                padding: '1px 6px',
                borderRadius: 10,
              }}
            >
              +{count - 1}
            </span>
          )}
        </div>
      );
    },
    meta: {
      sortField:      null,
      widthPct:       '11%',
      alignRight:     false,
      defaultVisible: true,
      label:          'PO Numbers',
      filterType:     'multiselect',
      filterParam:    'poIn',
      distinctColumn: 'po',
    },
  }),

  ch.accessor(c => {
    if (!c.costPerLicense || !c.quantity) return 0;
    return parseFloat(c.costPerLicense) * parseInt(c.quantity);
  }, {
    id: 'value',
    header: 'Value',
    cell: ({ row }) => formatCurrency(row.original.costPerLicense, row.original.quantity),
    meta: {
      sortField:      'value',
      widthPct:       '9%',
      alignRight:     true,
      defaultVisible: true,
      label:          'Value',
      filterType:     'numberrange',
      filterParam:    { min: 'valueMin', max: 'valueMax' },
    },
  }),

  // ── v0.57: six new columns (all defaultVisible:false; opt-in via picker) ──
  // All 6 are first-class scalar fields on the Contract Prisma model — no
  // migration needed. Hidden by default so existing users aren't surprised
  // by a wider table on their next page load. They show up in the column
  // picker dropdown immediately, and once toggled on they persist via the
  // existing `contracts.columnVisibility` user preference.

  // Auto-Renewal — boolean rendered as Yes/No. Multi-select dropdown
  // (distinct values are simply ['Yes', 'No']; server's /distinct/:column
  // returns them as a static set without a contract scan).
  ch.accessor(c => (c.autoRenewal ? 'Yes' : 'No'), {
    id: 'autoRenewal',
    header: 'Auto-Renewal',
    cell: ({ row }) =>
      row.original.autoRenewal
        ? <span style={{ fontWeight: 600 }}>Yes</span>
        : <span className="text-muted">No</span>,
    meta: {
      sortField:      null,
      widthPct:       '9%',
      alignRight:     false,
      defaultVisible: false,
      label:          'Auto-Renewal',
      filterType:     'multiselect',
      filterParam:    'autoRenewalIn',
      distinctColumn: 'autoRenewal',
      // identity — values are already 'Yes' / 'No'
      formatValue:    (v) => v,
    },
  }),

  // Start Date — DateTime, optional. Same date-range dropdown UX as End
  // Date / Evaluate By / Cancel By. Sortable.
  ch.accessor(c => c.startDate ?? '', {
    id: 'startDate',
    header: 'Start Date',
    cell: ({ row }) => <div>{fmt(row.original.startDate)}</div>,
    meta: {
      sortField:      'startDate',
      widthPct:       '10%',
      alignRight:     true,
      defaultVisible: false,
      label:          'Start Date',
      filterType:     'daterange',
      filterParam:    { from: 'startDateFrom', to: 'startDateTo' },
    },
  }),

  // Department — free-text scalar with __BLANK__ sentinel.
  ch.accessor(c => c.department ?? '', {
    id: 'department',
    header: 'Department',
    cell: ({ row }) =>
      row.original.department
        ? <span>{row.original.department}</span>
        : <span className="text-muted">—</span>,
    meta: {
      sortField:      null,
      widthPct:       '10%',
      alignRight:     false,
      defaultVisible: false,
      label:          'Department',
      filterType:     'multiselect',
      filterParam:    'departmentIn',
      distinctColumn: 'department',
    },
  }),

  // Contract # — vendor/customer agreement number (Contract.contractNumber).
  // Mono font so long alphanumerics line up.
  ch.accessor(c => c.contractNumber ?? '', {
    id: 'contractNumber',
    header: 'Contract #',
    cell: ({ row }) =>
      row.original.contractNumber
        ? <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--font-size-sm)' }}>{row.original.contractNumber}</span>
        : <span className="text-muted">—</span>,
    meta: {
      sortField:      null,
      widthPct:       '10%',
      alignRight:     false,
      defaultVisible: false,
      label:          'Contract #',
      filterType:     'multiselect',
      filterParam:    'contractNumberIn',
      distinctColumn: 'contractNumber',
    },
  }),

  // Customer # — buyer-side reference number (Contract.customerNumber).
  ch.accessor(c => c.customerNumber ?? '', {
    id: 'customerNumber',
    header: 'Customer #',
    cell: ({ row }) =>
      row.original.customerNumber
        ? <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--font-size-sm)' }}>{row.original.customerNumber}</span>
        : <span className="text-muted">—</span>,
    meta: {
      sortField:      null,
      widthPct:       '10%',
      alignRight:     false,
      defaultVisible: false,
      label:          'Customer #',
      filterType:     'multiselect',
      filterParam:    'customerNumberIn',
      distinctColumn: 'customerNumber',
    },
  }),

  // Reseller — distributor / partner name (Contract.resellerName).
  // The other reseller-* scalar fields (account/contact name/email) stay
  // on the contract detail page; only the name surfaces in the list.
  ch.accessor(c => c.resellerName ?? '', {
    id: 'reseller',
    header: 'Reseller',
    cell: ({ row }) =>
      row.original.resellerName
        ? <span>{row.original.resellerName}</span>
        : <span className="text-muted">—</span>,
    meta: {
      sortField:      null,
      widthPct:       '10%',
      alignRight:     false,
      defaultVisible: false,
      label:          'Reseller',
      filterType:     'multiselect',
      filterParam:    'resellerIn',
      distinctColumn: 'reseller',
    },
  }),

  // category-conditional lease columns (contract-section-refresh). Native
  // nullable scalars; surfaced on the contract Lease Terms card for hardware +
  // lease_rent. Hidden by default; opt-in via the column picker. Display-only
  // (no filterType) so no /distinct backend support is required.
  ch.accessor(c => c.leaseStart ?? '', {
    id: 'leaseStart',
    header: 'Lease Start',
    cell: ({ row }) => <div>{fmt(row.original.leaseStart)}</div>,
    meta: {
      sortField:      null,
      widthPct:       '10%',
      alignRight:     true,
      defaultVisible: false,
      label:          'Lease Start',
    },
  }),

  ch.accessor(c => c.leaseEnd ?? '', {
    id: 'leaseEnd',
    header: 'Lease End',
    cell: ({ row }) => <div>{fmt(row.original.leaseEnd)}</div>,
    meta: {
      sortField:      null,
      widthPct:       '10%',
      alignRight:     true,
      defaultVisible: false,
      label:          'Lease End',
    },
  }),

  ch.accessor(c => c.leaseType ?? '', {
    id: 'leaseType',
    header: 'Lease Type',
    cell: ({ row }) =>
      row.original.leaseType
        ? <span>{row.original.leaseType}</span>
        : <span className="text-muted">&mdash;</span>,
    meta: {
      sortField:      null,
      widthPct:       '10%',
      alignRight:     false,
      defaultVisible: false,
      label:          'Lease Type',
    },
  }),

  ch.accessor(c => (c.leaseBuyout != null ? parseFloat(c.leaseBuyout) : 0), {
    id: 'leaseBuyout',
    header: 'Buyout',
    cell: ({ row }) => {
      const v = row.original.leaseBuyout;
      if (v == null) return <span className="text-muted">&mdash;</span>;
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(parseFloat(v));
    },
    meta: {
      sortField:      null,
      widthPct:       '9%',
      alignRight:     true,
      defaultVisible: false,
      label:          'Buyout',
    },
  }),];

// ── Visibility helpers ────────────────────────────────────────────────────────

// localStorage key — namespaced under `lapseiq:` so a future export of the
// app's persisted user-prefs is trivially greppable.
export const CONTRACTS_VISIBILITY_KEY = 'lapseiq:contracts-list:visible-columns';

// Build the default TanStack columnVisibility map from the registry's
// defaultVisible flag. Shape: { [columnId]: boolean }.
export function defaultContractsVisibility() {
  const v = {};
  for (const col of CONTRACTS_COLUMNS) {
    v[col.id] = col.meta?.defaultVisible !== false;
  }
  return v;
}

// Load the persisted visibility map from localStorage, merged on top of the
// default. Unknown ids (from a future column that's been removed) are
// discarded; missing ids (from a new column added in a later release) fall
// back to the registry's `defaultVisible`. This makes the persistence forward-
// AND backward-compatible across releases.
export function loadContractsVisibility() {
  const def = defaultContractsVisibility();
  if (typeof window === 'undefined') return def;
  try {
    const raw = window.localStorage.getItem(CONTRACTS_VISIBILITY_KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return def;
    const known = new Set(CONTRACTS_COLUMNS.map(c => c.id));
    const merged = { ...def };
    for (const [id, vis] of Object.entries(parsed)) {
      if (known.has(id) && typeof vis === 'boolean') merged[id] = vis;
    }
    return merged;
  } catch {
    return def;
  }
}

// Persist the current visibility map. Best-effort — a quota-exceeded error
// (private window, full storage) is swallowed; users still get column-picker
// behaviour in-session, they just won't have it on next page load.
export function saveContractsVisibility(visibility) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CONTRACTS_VISIBILITY_KEY, JSON.stringify(visibility));
  } catch {
    /* ignore */
  }
}
