// ─────────────────────────────────────────────────────────────────────────────
// ColumnFilterInput.jsx — v0.40 Phase 2 shared component
//
// Renders the per-column filter input that sits in the secondary <th> row
// of a table header. Three types supported, all visually flush so the row
// reads like an Excel/AutoFilter strip:
//
//   • 'text'         — single text input, case-insensitive contains
//   • 'daterange'    — from + to date inputs stacked vertically (preserves
//                       narrow column widths)
//   • 'numberrange'  — min + max number inputs side by side
//
// The component is intentionally controlled — the parent reads/writes the
// filter value through TanStack's `column.getFilterValue()` /
// `column.setFilterValue()`. No internal state.
//
// Value shapes (what the parent stores via setFilterValue):
//   • text         → string
//   • daterange    → { from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' } | undefined
//   • numberrange  → { min?: number, max?: number } | undefined
//
// `undefined` (or empty string) means "no filter on this column".
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';

const INPUT_STYLE = {
  width: '100%',
  padding: '3px 6px',
  fontSize: 'var(--font-size-xs)',
  border: '1px solid var(--color-border)',
  borderRadius: 3,
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  boxSizing: 'border-box',
};

export default function ColumnFilterInput({ type, value, onChange, label, alignRight }) {
  if (type === 'text') {
    return <TextFilter value={value} onChange={onChange} label={label} alignRight={alignRight} />;
  }
  if (type === 'daterange') {
    return <DateRangeFilter value={value} onChange={onChange} label={label} />;
  }
  if (type === 'numberrange') {
    return <NumberRangeFilter value={value} onChange={onChange} label={label} alignRight={alignRight} />;
  }
  return null;
}

// ── Text contains ────────────────────────────────────────────────────────────
// Debounced so typing doesn't re-filter on every keystroke (also helps with
// the row-key changes downstream). 150ms feels snappy.

function TextFilter({ value, onChange, label, alignRight }) {
  const [draft, setDraft] = useState(value || '');

  useEffect(() => { setDraft(value || ''); }, [value]);

  useEffect(() => {
    const t = setTimeout(() => {
      // Only fire onChange when the debounced value differs from what the
      // parent already has — prevents an unnecessary state churn.
      if (draft !== (value || '')) onChange(draft || undefined);
    }, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      placeholder="Filter…"
      aria-label={label ? `Filter by ${label}` : 'Filter column'}
      onClick={(e) => e.stopPropagation()}
      style={{ ...INPUT_STYLE, textAlign: alignRight ? 'right' : 'left' }}
    />
  );
}

// ── Date range ───────────────────────────────────────────────────────────────
// from + to stacked vertically — date inputs are visually wide, side-by-side
// would overflow on narrow columns. Inputs are inclusive on both ends.

function DateRangeFilter({ value, onChange, label }) {
  const v = value || {};
  const update = (patch) => {
    const next = { ...v, ...patch };
    // Collapse empty {} → undefined so "no filter" is uniform.
    if (!next.from && !next.to) onChange(undefined);
    else onChange(next);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <input
        type="date"
        value={v.from || ''}
        onChange={(e) => update({ from: e.target.value || undefined })}
        aria-label={label ? `Filter ${label} from` : 'Filter from date'}
        onClick={(e) => e.stopPropagation()}
        style={INPUT_STYLE}
      />
      <input
        type="date"
        value={v.to || ''}
        onChange={(e) => update({ to: e.target.value || undefined })}
        aria-label={label ? `Filter ${label} to` : 'Filter to date'}
        onClick={(e) => e.stopPropagation()}
        style={INPUT_STYLE}
      />
    </div>
  );
}

// ── Number range ─────────────────────────────────────────────────────────────
// min + max side-by-side. Both inclusive. Allows negative numbers (important
// for Days Until — overdue rows have negative daysUntil values).

function NumberRangeFilter({ value, onChange, label, alignRight }) {
  const v = value || {};
  const update = (patch) => {
    const next = { ...v, ...patch };
    if (next.min == null && next.max == null) onChange(undefined);
    else onChange(next);
  };
  const parse = (raw) => (raw === '' || raw === '-' ? undefined : Number(raw));

  return (
    <div style={{ display: 'flex', gap: 3 }}>
      <input
        type="number"
        value={v.min ?? ''}
        onChange={(e) => update({ min: parse(e.target.value) })}
        placeholder="min"
        aria-label={label ? `Filter ${label} min` : 'Filter min'}
        onClick={(e) => e.stopPropagation()}
        style={{ ...INPUT_STYLE, textAlign: alignRight ? 'right' : 'left' }}
      />
      <input
        type="number"
        value={v.max ?? ''}
        onChange={(e) => update({ max: parse(e.target.value) })}
        placeholder="max"
        aria-label={label ? `Filter ${label} max` : 'Filter max'}
        onClick={(e) => e.stopPropagation()}
        style={{ ...INPUT_STYLE, textAlign: alignRight ? 'right' : 'left' }}
      />
    </div>
  );
}
