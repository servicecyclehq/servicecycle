// ─────────────────────────────────────────────────────────────────────────────
// vendorsColumns.jsx — v0.70.0 canonical-pattern propagation for /vendors
//
// Mirrors alertsColumns.jsx structure. Column registry + cell helpers + filter
// fns for the TanStack-table rewrite of VendorsList.
//
// Row shape (normalized by VendorsList.jsx from /api/vendors):
//   {
//     id, name, vendorType, cotermComplexity, cotermNotes,
//     contractCount,   // computed: _count.contracts ?? 0
//     activeSpend,     // computed: sum of cost*qty across active contracts
//     lastContactedAt, // server-provided unified date or fallback
//   }
//
// Filtering happens client-side via TanStack's getFilteredRowModel — the
// vendors dataset is bounded (typically <100 rows even on large accounts)
// so a server-side bootstrap + distinct route doesn't earn its keep here.
// (Mirrors the alerts decision in canonical doc Section 4.1.)
// ─────────────────────────────────────────────────────────────────────────────

import { createColumnHelper } from '@tanstack/react-table';

export const BLANK_SENTINEL = '__BLANK__';

export const COTERM_LABELS = {
  none:     'Simple',
  moderate: 'Moderate',
  complex:  'Complex',
};

export const COTERM_COLORS = {
  none:     'badge-active',
  moderate: 'badge-under_review',
  complex:  'badge-cancelled',
};

export const VENDOR_TYPES = [
  'SaaS', 'Hardware', 'Professional Services', 'Cloud / Hosting',
  'Telecom', 'Staffing', 'Facilities', 'Other',
];

export const COTERM_TOOLTIP =
  'How complex is renewing this vendor — Simple = single product on one date, ' +
  'Moderate = some co-term considerations, Complex = multiple products or staggered dates.';

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

function CotermBadge({ value }) {
  if (!value) return <span className="text-muted">—</span>;
  const label = COTERM_LABELS[value] || value;
  const cls   = COTERM_COLORS[value] || 'badge-active';
  return (
    <span
      className={`badge ${cls}`}
      title={COTERM_TOOLTIP}
      style={{ cursor: 'help' }}
    >
      {label}
    </span>
  );
}

// ── Column registry ──────────────────────────────────────────────────────────

const ch = createColumnHelper();

export const VENDORS_COLUMNS = [
  ch.accessor(r => r.name ?? '', {
    id: 'name',
    header: 'Vendor',
    cell: ({ row }) => <span style={{ fontWeight: 600 }}>{row.original.name}</span>,
    filterFn: multiSelectMatch,
    meta: {
      widthPct: '24%', defaultVisible: true, label: 'Vendor', alignRight: false,
      filterType: 'multiselect', filterParam: 'nameIn', distinctColumn: 'name',
    },
  }),

  ch.accessor(r => r.vendorType ?? '', {
    id: 'vendorType',
    header: 'Type',
    cell: ({ row }) => <span className="td-muted">{row.original.vendorType || '—'}</span>,
    filterFn: multiSelectMatch,
    meta: {
      widthPct: '14%', defaultVisible: true, label: 'Type', alignRight: false,
      filterType: 'multiselect', filterParam: 'typeIn', distinctColumn: 'vendorType',
    },
  }),

  ch.accessor(r => r.cotermComplexity ?? 'none', {
    id: 'cotermComplexity',
    header: () => (
      <span title={COTERM_TOOLTIP} style={{ cursor: 'help' }}>
        Co-term <span style={{ color: 'var(--color-text-secondary)', fontWeight: 400 }}>ⓘ</span>
      </span>
    ),
    cell: ({ row }) => <CotermBadge value={row.original.cotermComplexity} />,
    filterFn: multiSelectMatch,
    meta: {
      widthPct: '12%', defaultVisible: true, label: 'Co-term', alignRight: false,
      filterType: 'multiselect', filterParam: 'complexityIn',
      distinctColumn: 'cotermComplexity',
      formatValue: (v) => COTERM_LABELS[v] || v,
    },
  }),

  ch.accessor(r => r.contractCount ?? 0, {
    id: 'contractCount',
    header: 'Contracts',
    cell: ({ row }) => <span className="td-muted">{row.original.contractCount ?? 0}</span>,
    filterFn: numberRange,
    meta: {
      widthPct: '10%', defaultVisible: true, label: 'Contracts', alignRight: true,
      filterType: 'numberrange', filterParam: { min: 'contractsMin', max: 'contractsMax' },
    },
  }),

  ch.accessor(r => r.activeSpend ?? 0, {
    id: 'activeSpend',
    header: 'Active Spend',
    cell: ({ row }) => {
      const v = row.original.activeSpend;
      return (
        <span style={{
          fontWeight: v > 0 ? 600 : 400,
          color: v > 0 ? 'var(--color-text)' : 'var(--color-text-secondary)',
        }}>
          {fmtMoney(v)}
        </span>
      );
    },
    filterFn: numberRange,
    meta: {
      widthPct: '12%', defaultVisible: true, label: 'Active Spend', alignRight: true,
      filterType: 'numberrange', filterParam: { min: 'spendMin', max: 'spendMax' },
    },
  }),

  ch.accessor(r => r.lastContactedAt ?? '', {
    id: 'lastContactedAt',
    header: 'Last Contacted',
    cell: ({ row }) => <span className="td-muted">{fmtDate(row.original.lastContactedAt)}</span>,
    filterFn: dateRange,
    meta: {
      widthPct: '14%', defaultVisible: true, label: 'Last Contacted', alignRight: false,
      filterType: 'daterange', filterParam: { from: 'lastContactFrom', to: 'lastContactTo' },
    },
  }),

  ch.accessor(r => r.cotermNotes ?? '', {
    id: 'cotermNotes',
    header: 'Co-term Notes',
    cell: ({ row }) => (
      <span className="td-muted" style={{ maxWidth: 240, whiteSpace: 'normal', display: 'inline-block' }}>
        {row.original.cotermNotes || '—'}
      </span>
    ),
    enableSorting: false,
    meta: {
      widthPct: '14%', defaultVisible: false, label: 'Co-term Notes', alignRight: false,
      // No filter on this — it's a free-text notes column with high cardinality.
    },
  }),
];

// ── Visibility helpers ───────────────────────────────────────────────────────

export const VENDORS_VISIBILITY_KEY = 'vendors.columnVisibility';

export function defaultVendorsVisibility() {
  const v = {};
  for (const col of VENDORS_COLUMNS) {
    v[col.id] = col.meta?.defaultVisible !== false;
  }
  return v;
}
