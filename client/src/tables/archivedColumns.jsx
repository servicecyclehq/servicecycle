// ─────────────────────────────────────────────────────────────────────────────
// archivedColumns.jsx — v0.70.2 canonical-pattern propagation for
// /contracts/archived. Mirrors vendorsColumns.jsx + alertsColumns.jsx shape.
//
// Row shape (normalized by ArchivedContracts.jsx from /api/contracts/archived):
//   {
//     id, product, status, vendorName, vendorId,
//     value,           // computed: costPerLicense * quantity (or null)
//     endDate, archivedAt, ownerName,
//   }
//
// The Restore button is rendered OUTSIDE this registry — it's an always-visible
// row action, not a hide-able column.
// ─────────────────────────────────────────────────────────────────────────────

import { createColumnHelper } from '@tanstack/react-table';

export const BLANK_SENTINEL = '__BLANK__';

export const STATUS_LABELS = {
  active:       'Active',
  under_review: 'Under Review',
  renewed:      'Renewed',
  cancelled:    'Cancelled',
  expired:      'Expired',
  pending:      'Pending',
};

// ── Formatters ───────────────────────────────────────────────────────────────

export function fmtMoney(v) {
  if (v == null || v === 0) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(v);
}

export function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

// ── Filter functions ─────────────────────────────────────────────────────────

function multiSelectMatch(row, columnId, filterValue) {
  if (!Array.isArray(filterValue) || filterValue.length === 0) return true;
  const raw = row.getValue(columnId);
  const isBlank = raw == null || raw === '';
  if (isBlank) return filterValue.includes(BLANK_SENTINEL);
  return filterValue.includes(String(raw));
}

function dateRange(row, columnId, filterValue) {
  if (!filterValue) return true;
  const { from, to } = filterValue;
  if (!from && !to) return true;
  const raw = row.getValue(columnId);
  if (!raw) return false;
  const t = new Date(raw).getTime();
  if (Number.isNaN(t)) return false;
  if (from && t < new Date(from).getTime()) return false;
  if (to && t > new Date(to).getTime() + 86399999) return false;
  return true;
}

function numberRange(row, columnId, filterValue) {
  if (!filterValue) return true;
  const { min, max } = filterValue;
  if (min == null && max == null) return true;
  const v = row.getValue(columnId);
  if (typeof v !== 'number') return false;
  if (min != null && v < Number(min)) return false;
  if (max != null && v > Number(max)) return false;
  return true;
}

export { multiSelectMatch, dateRange, numberRange };

// ── Cell renderers ───────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABELS[status] || status}</span>;
}

// ── Column registry ──────────────────────────────────────────────────────────

const ch = createColumnHelper();

export const ARCHIVED_COLUMNS = [
  ch.accessor(r => r.vendorName ?? '', {
    id: 'vendor',
    header: 'Vendor',
    cell: ({ row }) => (
      <div>
        <div style={{ fontWeight: 600 }}>{row.original.vendorName || '—'}</div>
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{row.original.product}</div>
      </div>
    ),
    filterFn: multiSelectMatch,
    meta: {
      widthPct: '26%', defaultVisible: true, label: 'Vendor', alignRight: false,
      filterType: 'multiselect', filterParam: 'vendorIn', distinctColumn: 'vendorName',
    },
  }),

  ch.accessor(r => r.product ?? '', {
    id: 'product',
    header: 'Product',
    cell: ({ row }) => <span className="td-muted">{row.original.product || '—'}</span>,
    filterFn: multiSelectMatch,
    meta: {
      widthPct: '18%', defaultVisible: false, label: 'Product', alignRight: false,
      filterType: 'multiselect', filterParam: 'productIn', distinctColumn: 'product',
    },
  }),

  ch.accessor(r => r.status ?? '', {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge status={row.original.status} />,
    filterFn: multiSelectMatch,
    meta: {
      widthPct: '12%', defaultVisible: true, label: 'Status', alignRight: false,
      filterType: 'multiselect', filterParam: 'statusIn', distinctColumn: 'status',
      formatValue: (v) => STATUS_LABELS[v] || v,
    },
  }),

  ch.accessor(r => r.value ?? 0, {
    id: 'value',
    header: 'Value',
    cell: ({ row }) => {
      const v = row.original.value;
      return v
        ? <span style={{ fontWeight: 500 }}>{fmtMoney(v)}</span>
        : <span style={{ color: 'var(--color-text-secondary)' }}>—</span>;
    },
    filterFn: numberRange,
    meta: {
      widthPct: '12%', defaultVisible: true, label: 'Value', alignRight: true,
      filterType: 'numberrange', filterParam: { min: 'valueMin', max: 'valueMax' },
    },
  }),

  ch.accessor(r => r.endDate ?? '', {
    id: 'endDate',
    header: 'End Date',
    cell: ({ row }) => <span style={{ fontSize: 'var(--font-size-ui)' }}>{fmtDate(row.original.endDate)}</span>,
    filterFn: dateRange,
    meta: {
      widthPct: '14%', defaultVisible: true, label: 'End Date', alignRight: false,
      filterType: 'daterange', filterParam: { from: 'endDateFrom', to: 'endDateTo' },
    },
  }),

  ch.accessor(r => r.archivedAt ?? '', {
    id: 'archivedAt',
    header: 'Archived',
    cell: ({ row }) => (
      <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
        {fmtDate(row.original.archivedAt)}
      </span>
    ),
    filterFn: dateRange,
    meta: {
      widthPct: '14%', defaultVisible: true, label: 'Archived', alignRight: false,
      filterType: 'daterange', filterParam: { from: 'archivedFrom', to: 'archivedTo' },
    },
  }),

  ch.accessor(r => r.ownerName ?? '', {
    id: 'owner',
    header: 'Owner',
    cell: ({ row }) => <span className="td-muted">{row.original.ownerName || '—'}</span>,
    filterFn: multiSelectMatch,
    meta: {
      widthPct: '14%', defaultVisible: false, label: 'Owner', alignRight: false,
      filterType: 'multiselect', filterParam: 'ownerIn', distinctColumn: 'ownerName',
    },
  }),
];

// ── Visibility helpers ───────────────────────────────────────────────────────

export const ARCHIVED_VISIBILITY_KEY = 'archived.columnVisibility';

export function defaultArchivedVisibility() {
  const v = {};
  for (const col of ARCHIVED_COLUMNS) {
    v[col.id] = col.meta?.defaultVisible !== false;
  }
  return v;
}
