// ─────────────────────────────────────────────────────────────────────────────
// alertsColumns.jsx — v0.40 Phase 1A + Phase 2 + v0.56.0 propagation
//
// Same shape as contractsColumns.jsx — column registry + cell helpers — but
// for the flat-table rewrite of AlertsPage. v0.56.0 adds Excel-style
// multi-select dropdowns on Vendor + Product (plus filterParam +
// distinctColumn meta) and a multi-select-aware filterFn.
//
// Row shape (normalized by AlertsPage from /api/alerts/all):
//   { rowKey, alertId, alertType, contract, relevantDate, daysUntil, isDerived }
//
// Actions column (Dismiss / em-dash) is rendered OUTSIDE this registry —
// it's always visible and not user-hidable.
// ─────────────────────────────────────────────────────────────────────────────

import { createColumnHelper } from '@tanstack/react-table';

export const ALERT_TYPE_LABELS = {
  cancel_by:   'Cancel Window',
  review_by:   'Review Due',
  renewal:     'Renewal',
  billing_60:  'Billing (60 days)',
  billing_30:  'Billing (30 days)',
  billing_48:  'Billing (48 hours)',
  payment_due: 'Payment Due',
};

export const ALERT_COLOR = {
  cancel_by:   { bg: 'var(--color-danger-bg)',     text: 'var(--color-danger)',  border: 'var(--color-danger)' },
  review_by:   { bg: 'var(--color-primary-light)', text: 'var(--color-primary)', border: 'var(--color-info)' },
  renewal:     { bg: 'var(--color-renewal-bg)',    text: 'var(--color-renewal-text)', border: 'var(--color-renewal-border)' },
  billing_60:  { bg: 'var(--color-warning-bg)',    text: 'var(--color-warning)', border: 'var(--color-warning)' },
  billing_30:  { bg: 'var(--color-warning-bg)',    text: 'var(--color-warning)', border: 'var(--color-warning)' },
  billing_48:  { bg: 'var(--color-warning-bg)',    text: 'var(--color-warning)', border: 'var(--color-warning)' },
  payment_due: { bg: 'var(--color-warning-bg)',    text: 'var(--color-warning)', border: 'var(--color-warning)' },
};

// v0.56.0: shared sentinel between ColumnFilterDropdown + /api/alerts/distinct
export const BLANK_SENTINEL = '__BLANK__';

export function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function daysUntil(d) {
  if (!d) return null;
  return Math.ceil((new Date(d) - new Date()) / (1000 * 60 * 60 * 24));
}

// v0.71.2 (audit Medium a11y): aria-label adds severity word to each variant
// so screen readers announce "12 days, urgent" instead of just "In 12 days".
export function DaysChip({ days }) {
  if (days === null || days === undefined) return <span className="text-muted">—</span>;
  if (days < 0)   return <span aria-label={`${Math.abs(days)} days, overdue`} style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-danger)' }}>Overdue by {Math.abs(days)}d</span>;
  if (days === 0) return <span aria-label="Due today, urgent" style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-danger)' }}>Due today</span>;
  if (days <= 7)  return <span aria-label={`${days} day${days !== 1 ? 's' : ''}, urgent`} style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-warning)' }}>In {days} day{days !== 1 ? 's' : ''}</span>;
  return <span aria-label={`${days} days, upcoming`} style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>In {days} days</span>;
}

export function TypeBadge({ alertType, daysUntil }) {
  // v0.92.x: a review alert whose date has already passed reads "Past Due" in
  // the danger palette rather than the neutral "Review Due" â€” it is overdue.
  const isPastReview = alertType === 'review_by' && typeof daysUntil === 'number' && daysUntil < 0;
  const colors = isPastReview
    ? { bg: 'var(--alert-pastdue-bg)', text: 'var(--alert-pastdue-text)', border: 'var(--alert-pastdue-border)' }
    : (ALERT_COLOR[alertType] || { bg: 'var(--color-bg)', text: '#6366f1', border: 'var(--color-border)' });
  const label = isPastReview ? 'Past Due' : (ALERT_TYPE_LABELS[alertType] || alertType);
  return (
    <span style={{
      display: 'inline-block',
      padding: '3px 10px',
      borderRadius: 20,
      fontSize: 'var(--font-size-xs)',
      fontWeight: 700,
      letterSpacing: '0.04em',
      background: colors.bg,
      color: colors.text,
      border: `1px solid ${colors.border}`,
      whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  );
}

// ── Filter functions ─────────────────────────────────────────────────────────

function textContains(row, columnId, filterValue) {
  if (!filterValue) return true;
  const v = String(row.getValue(columnId) ?? '').toLowerCase();
  return v.includes(String(filterValue).toLowerCase());
}

// v0.56.0: Multi-select match. filterValue is a string[] from ColumnFilterDropdown.
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
  if (typeof v !== 'number' || v === Number.MAX_SAFE_INTEGER) return false;
  if (min != null && v < Number(min)) return false;
  if (max != null && v > Number(max)) return false;
  return true;
}

export { textContains, multiSelectMatch, dateRange, numberRange };

// ── Column registry ──────────────────────────────────────────────────────────

const ch = createColumnHelper();

export const ALERTS_COLUMNS = [
  ch.accessor(r => r.alertType ?? '', {
    id: 'type',
    header: 'Type',
    cell: ({ row }) => <TypeBadge alertType={row.original.alertType} daysUntil={row.original.daysUntil} />,
    meta: { widthPct: '14%', defaultVisible: true, label: 'Type', alignRight: false },
  }),

  ch.accessor(r => r.contract?.vendor?.name ?? '', {
    id: 'vendor',
    header: 'Vendor',
    cell: ({ row }) => <span style={{ fontWeight: 600 }}>{row.original.contract?.vendor?.name || '—'}</span>,
    filterFn: multiSelectMatch,
    meta: {
      widthPct: '20%',
      defaultVisible: true,
      label: 'Vendor',
      alignRight: false,
      filterType: 'multiselect',
      filterParam: 'vendorIn',
      distinctColumn: 'vendor',
    },
  }),

  ch.accessor(r => r.contract?.product ?? '', {
    id: 'product',
    header: 'Product',
    cell: ({ row }) => <span>{row.original.contract?.product || '—'}</span>,
    filterFn: multiSelectMatch,
    meta: {
      widthPct: '24%',
      defaultVisible: true,
      label: 'Product',
      alignRight: false,
      filterType: 'multiselect',
      filterParam: 'productIn',
      distinctColumn: 'product',
    },
  }),

  ch.accessor(r => r.relevantDate ?? '', {
    id: 'date',
    header: 'Date',
    cell: ({ row }) => <span>{fmtDate(row.original.relevantDate)}</span>,
    filterFn: dateRange,
    meta: {
      widthPct: '14%',
      defaultVisible: true,
      label: 'Date',
      alignRight: true,
      filterType: 'daterange',
      filterParam: { from: 'dateFrom', to: 'dateTo' },
    },
  }),

  ch.accessor(r => r.daysUntil ?? Number.MAX_SAFE_INTEGER, {
    id: 'daysUntil',
    header: 'Days Until',
    cell: ({ row }) => <DaysChip days={row.original.daysUntil} />,
    filterFn: numberRange,
    meta: {
      widthPct: '14%',
      defaultVisible: true,
      label: 'Days Until',
      alignRight: true,
      filterType: 'numberrange',
      filterParam: { min: 'daysMin', max: 'daysMax' },
    },
  }),
];

// ── Visibility helpers ───────────────────────────────────────────────────────

export const ALERTS_VISIBILITY_KEY = 'lapseiq:alerts-list:visible-columns';

export function defaultAlertsVisibility() {
  const v = {};
  for (const col of ALERTS_COLUMNS) {
    v[col.id] = col.meta?.defaultVisible !== false;
  }
  return v;
}

export function loadAlertsVisibility() {
  const def = defaultAlertsVisibility();
  if (typeof window === 'undefined') return def;
  try {
    const raw = window.localStorage.getItem(ALERTS_VISIBILITY_KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return def;
    const known = new Set(ALERTS_COLUMNS.map(c => c.id));
    const merged = { ...def };
    for (const [id, vis] of Object.entries(parsed)) {
      if (known.has(id) && typeof vis === 'boolean') merged[id] = vis;
    }
    return merged;
  } catch {
    return def;
  }
}

export function saveAlertsVisibility(visibility) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ALERTS_VISIBILITY_KEY, JSON.stringify(visibility));
  } catch {
    /* ignore */
  }
}
