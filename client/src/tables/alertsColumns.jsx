// ─────────────────────────────────────────────────────────────────────────────
// alertsColumns.jsx — ServiceCycle maintenance-alert column registry.
//
// Row shape (straight from GET /api/alerts → data.alerts[]):
//   { id, alertType, leadDays, status, scheduledAt, sentAt,
//     asset:    { id, equipmentType, manufacturer, model, serialNumber,
//                 governingCondition, site: { id, name } },
//     schedule: { id, nextDueDate, lastCompletedDate,
//                 taskDefinition: { taskName, taskCode, standardRef, requiresOutage } } }
//
// leadDays encodes the tier: positive (180/120/90/60/30/7) = days before due;
// negative (-1/-7/-30/-90) = days overdue (overdue/escalation/breach tiers).
//
// The Acknowledge action column is rendered OUTSIDE this registry by
// AlertsPage — it's always visible and not user-hidable.
// ─────────────────────────────────────────────────────────────────────────────

import { Link } from 'react-router-dom';
import { createColumnHelper } from '@tanstack/react-table';
import { assetLabel, fmtDate } from '../lib/equipment';

export const ALERT_TYPE_LABELS = {
  maintenance_due:   'Maintenance Due',
  overdue:           'Overdue',
  escalation:        'Escalation',
  regulatory_breach: 'Regulatory Breach',
};

// Maintenance Due = slate-blue, Overdue = amber, Escalation = red,
// Regulatory Breach = dark red.
export const ALERT_COLOR = {
  maintenance_due:   { bg: 'var(--color-primary-light)', text: 'var(--color-primary)', border: 'var(--color-info)' },
  overdue:           { bg: 'var(--color-warning-bg)',    text: 'var(--color-warning)', border: 'var(--color-warning)' },
  escalation:        { bg: 'var(--color-danger-bg)',     text: 'var(--color-danger)',  border: 'var(--color-danger)' },
  regulatory_breach: { bg: 'var(--color-danger-bg)',     text: '#7f1d1d',              border: '#7f1d1d' },
};

export function daysUntil(d) {
  if (!d) return null;
  return Math.ceil((new Date(d) - new Date()) / (1000 * 60 * 60 * 24));
}

export function isPastDue(d) {
  const n = daysUntil(d);
  return typeof n === 'number' && n < 0;
}

// leadDays tier → human string. Positive = lead alert, negative = overdue.
export function fmtTier(leadDays) {
  if (leadDays == null) return '—';
  const n = Number(leadDays);
  if (Number.isNaN(n)) return '—';
  if (n >= 0) return `${n} day${n !== 1 ? 's' : ''} before`;
  const abs = Math.abs(n);
  return `${abs} day${abs !== 1 ? 's' : ''} overdue`;
}

export function TypeBadge({ alertType }) {
  const colors = ALERT_COLOR[alertType]
    || { bg: 'var(--color-bg)', text: 'var(--color-text-secondary)', border: 'var(--color-border)' };
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
      {ALERT_TYPE_LABELS[alertType] || alertType}
    </span>
  );
}

// ── Filter functions ─────────────────────────────────────────────────────────

function textContains(row, columnId, filterValue) {
  if (!filterValue) return true;
  const v = String(row.getValue(columnId) ?? '').toLowerCase();
  return v.includes(String(filterValue).toLowerCase());
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

export { textContains, dateRange };

// ── Column registry ──────────────────────────────────────────────────────────

const ch = createColumnHelper();

export const ALERTS_COLUMNS = [
  ch.accessor(r => r.alertType ?? '', {
    id: 'type',
    header: 'Type',
    cell: ({ row }) => <TypeBadge alertType={row.original.alertType} />,
    meta: { widthPct: '15%', defaultVisible: true, label: 'Type', alignRight: false },
  }),

  ch.accessor(r => assetLabel(r.asset), {
    id: 'asset',
    header: 'Asset',
    cell: ({ row }) => {
      const asset = row.original.asset;
      if (!asset?.id) return <span className="text-muted">—</span>;
      return (
        <Link
          to={`/assets/${asset.id}`}
          onClick={e => e.stopPropagation()}
          style={{ fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'none' }}
        >
          {assetLabel(asset)}
        </Link>
      );
    },
    filterFn: textContains,
    meta: { widthPct: '22%', defaultVisible: true, label: 'Asset', alignRight: false, filterType: 'text' },
  }),

  ch.accessor(r => r.asset?.site?.name ?? '', {
    id: 'site',
    header: 'Site',
    cell: ({ row }) => <span>{row.original.asset?.site?.name || '—'}</span>,
    filterFn: textContains,
    meta: { widthPct: '14%', defaultVisible: true, label: 'Site', alignRight: false, filterType: 'text' },
  }),

  ch.accessor(r => r.schedule?.taskDefinition?.taskName ?? '', {
    id: 'task',
    header: 'Task',
    cell: ({ row }) => {
      const td = row.original.schedule?.taskDefinition;
      if (!td?.taskName) return <span className="text-muted">—</span>;
      const tip = [
        td.standardRef ? `Standard: ${td.standardRef}` : null,
        td.taskCode ? `Code: ${td.taskCode}` : null,
        td.requiresOutage ? 'Requires outage' : null,
      ].filter(Boolean).join(' · ');
      return (
        <span title={tip || undefined} style={{ cursor: tip ? 'help' : 'default' }}>
          {td.taskName}
          {td.standardRef && (
            <span style={{ marginLeft: 6, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
              {td.standardRef}
            </span>
          )}
        </span>
      );
    },
    filterFn: textContains,
    meta: { widthPct: '21%', defaultVisible: true, label: 'Task', alignRight: false, filterType: 'text' },
  }),

  ch.accessor(r => r.schedule?.nextDueDate ?? '', {
    id: 'dueDate',
    header: 'Due Date',
    cell: ({ row }) => {
      const d = row.original.schedule?.nextDueDate;
      const past = isPastDue(d);
      return (
        <span style={past ? { color: 'var(--color-danger)', fontWeight: 600 } : undefined}>
          {fmtDate(d)}
        </span>
      );
    },
    filterFn: dateRange,
    meta: { widthPct: '13%', defaultVisible: true, label: 'Due Date', alignRight: true, filterType: 'daterange' },
  }),

  ch.accessor(r => (r.leadDays == null ? Number.MAX_SAFE_INTEGER : Number(r.leadDays)), {
    id: 'tier',
    header: 'Tier',
    cell: ({ row }) => {
      const n = row.original.leadDays;
      const overdue = typeof n === 'number' && n < 0;
      return (
        <span style={{
          fontSize: 'var(--font-size-sm)',
          fontWeight: overdue ? 600 : 400,
          color: overdue ? 'var(--color-danger)' : 'var(--color-text-secondary)',
          whiteSpace: 'nowrap',
        }}>
          {fmtTier(n)}
        </span>
      );
    },
    meta: { widthPct: '12%', defaultVisible: true, label: 'Tier', alignRight: true },
  }),
];

// ── Visibility helpers ───────────────────────────────────────────────────────

export const ALERTS_VISIBILITY_KEY = 'servicecycle:alerts-list:visible-columns';

export function defaultAlertsVisibility() {
  const v = {};
  for (const col of ALERTS_COLUMNS) {
    v[col.id] = col.meta?.defaultVisible !== false;
  }
  return v;
}
