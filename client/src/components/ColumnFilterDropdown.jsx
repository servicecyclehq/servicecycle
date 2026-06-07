// ─────────────────────────────────────────────────────────────────────────────
// ColumnFilterDropdown.jsx — v0.44 Excel-style multi-select column filter
//
// Replaces the v0.43 ColumnFilterInput text-contains pattern for columns
// where the user wants to pick from a discrete set of values (Vendor,
// Product, PO, Owner, Status). Mirrors Excel's AutoFilter UX:
//   • Button shows "Filter" (empty) or "N selected"
//   • Click opens a popover with a typeahead search at top + scrollable
//     checkbox list of distinct values + Select All / Clear All / Apply.
//   • Distinct values are fetched from a backend endpoint that narrows
//     based on other active filters (so filtering to Vendor=Adobe makes
//     the Product dropdown show only Adobe's products).
//
// Props:
//   • columnId       — used as the React key for the popover; passed to
//                       fetchDistinct so the caller can pick the right
//                       column endpoint
//   • label          — column header label, shown in aria-label
//   • value          — currently-selected values (string[])
//   • onChange       — (string[]) => void; called when user clicks Apply
//   • fetchDistinct  — async () => Promise<string[]>; caller-supplied
//                       loader so this component stays generic (doesn't
//                       hard-code any API path)
//   • formatValue    — optional (v: string) => string; used to render
//                       enum values like 'under_review' as 'Under Review'
//                       in the checkbox list AND in the button label.
//
// State management: the popover holds an in-flight "draft" selection that
// only commits to onChange when the user clicks Apply. This matches Excel:
// you can toggle several checkboxes and then commit them in one shot, so
// the table doesn't refetch on every checkbox click.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { ChevronDown, X as XIcon, Check } from 'lucide-react';

// Module-level default formatValue — using a stable reference so useMemo
// downstream doesn't invalidate every render. (Inline default `(v) => v`
// creates a new function ref per call, which silently breaks memoization.)
const IDENTITY = (v) => v;

// v0.45: sentinel value returned by the server's /distinct endpoint to
// represent "rows where this column is blank/null." Rendered as "(Blank)"
// in italic + greyed text, pinned to the top of the list. The dropdown's
// onChange returns it as a literal string in the array; backend translates
// it back to "WHERE column IS NULL" in the where clause.
const BLANK_SENTINEL = '__BLANK__';
const BLANK_LABEL    = '(Blank)';

const BUTTON_STYLE_BASE = {
  width: '100%',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '3px 8px',
  fontSize: 'var(--font-size-xs)',
  fontWeight: 500,
  border: '1px solid var(--color-border)',
  borderRadius: 3,
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  cursor: 'pointer',
  textAlign: 'left',
  boxSizing: 'border-box',
};

const POPOVER_STYLE = {
  position: 'absolute',
  top: '100%',
  left: 0,
  marginTop: 4,
  minWidth: 220,
  maxWidth: 320,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
  zIndex: 1000,
  display: 'flex',
  flexDirection: 'column',
  padding: 8,
};

const SEARCH_STYLE = {
  width: '100%',
  padding: '5px 8px',
  fontSize: 'var(--font-size-sm)',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  background: 'var(--color-bg, var(--color-surface))',
  color: 'var(--color-text)',
  marginBottom: 6,
  boxSizing: 'border-box',
};

const LIST_STYLE = {
  maxHeight: 240,
  overflowY: 'auto',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  padding: '4px 0',
  background: 'var(--color-bg, var(--color-surface))',
};

const ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  fontSize: 'var(--font-size-sm)',
  cursor: 'pointer',
  userSelect: 'none',
};

// Memoized row — re-renders only when its own checked state, value, or
// display label changes. This is the perf hot path: with 200+ items, a
// toggle on one checkbox should NOT re-render the other 199.
const FilterRow = memo(function FilterRow({ value, label, checked, onToggle, isBlank }) {
  return (
    <label
      style={isBlank
        ? { ...ROW_STYLE, fontStyle: 'italic', color: 'var(--color-text-secondary)' }
        : ROW_STYLE}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => { e.stopPropagation(); onToggle(value); }}
        style={{ cursor: 'pointer' }}
      />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </label>
  );
});

export default function ColumnFilterDropdown({
  columnId,
  label,
  value = [],
  onChange,
  fetchDistinct,
  formatValue,
  emptyLabel,
}) {
  // Stabilize formatValue — falls back to a module-level identity so the
  // useMemo on filteredList doesn't invalidate every render.
  const fmt = formatValue || IDENTITY;
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [distinct, setDistinct] = useState(null); // array | null = not loaded yet
  const [search, setSearch] = useState('');
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const triggerRef = useRef(null); // T3-N7: restore focus on close

  // Display helper that handles the __BLANK__ sentinel. Real values pass
  // through fmt() (which handles the snake_case -> Title Case for enums);
  // __BLANK__ becomes "(Blank)".
  const displayValue = (v) => (v === BLANK_SENTINEL ? BLANK_LABEL : fmt(v));

  const selectedCount = Array.isArray(value) ? value.length : 0;
  const buttonLabel = selectedCount === 0
    ? (emptyLabel || 'Filter')
    : selectedCount === 1
      ? displayValue(value[0])
      : `${selectedCount} selected`;

  // v0.46: immediate-apply mode. The dropdown no longer holds a "draft" —
  // every checkbox toggle commits to the parent via onChange. Parent
  // debounces its server fetch (300ms) so rapid clicks coalesce into one
  // network call. Fetch distinct values lazily on each open.
  useEffect(() => {
    if (!open) return;
    setSearch('');
    setTimeout(() => searchRef.current?.focus(), 0);
    // Always re-fetch on each open because other active filters may have
    // changed since last open (Excel narrowing semantics).
    setLoading(true);
    setError(null);
    fetchDistinct()
      .then(vals => {
        setDistinct(Array.isArray(vals) ? vals : []);
        setLoading(false);
      })
      .catch(err => {
        setError(err?.message || 'Failed to load values');
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // v0.52.6: NO document mousedown click-outside listener. Multiple attempts
  // to close-on-outside-only-when-actually-outside kept misfiring and closing
  // the popover when the user clicked a checkbox inside it. The current
  // close mechanisms are:
  //   • clicking the trigger button again (line ~260, setOpen(o => !o))
  //   • pressing Escape (below)
  // This matches Excel AutoFilter UX where the dropdown stays open until you
  // explicitly dismiss it. Users can toggle as many checkboxes as they want
  // without the popover going away.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filteredList = useMemo(() => {
    if (!distinct) return [];
    // v0.45: pin __BLANK__ to the top of the list, ahead of any real value.
    // Excel puts (Blanks) at the bottom; Dustin specifically asked for top.
    const hasBlank = distinct.includes(BLANK_SENTINEL);
    const rest = distinct.filter(v => v !== BLANK_SENTINEL);
    const q = search.trim().toLowerCase();
    if (!q) return hasBlank ? [BLANK_SENTINEL, ...rest] : rest;
    // Search matches either the formatted label of a real value OR the
    // string "blank" (so users can type "bla" to surface the (Blank) entry).
    const blankMatches = hasBlank && BLANK_LABEL.toLowerCase().includes(q);
    const restMatches  = rest.filter(v => fmt(v).toLowerCase().includes(q));
    return blankMatches ? [BLANK_SENTINEL, ...restMatches] : restMatches;
  }, [distinct, search, fmt]);

  // O(1) lookup table for committed-value membership. Each checkbox row
  // tests valueSet.has(v) in O(1) instead of value.includes(v) O(n).
  const valueSet = useMemo(() => new Set(Array.isArray(value) ? value : []), [value]);

  // v0.46 immediate-apply: every toggle commits directly to the parent
  // via onChange. Parent debounces the resulting fetchContracts so a rapid
  // sequence of checkbox clicks coalesces into one server call.
  const toggleOne = useCallback((v) => {
    const next = new Set(valueSet);
    if (next.has(v)) next.delete(v); else next.add(v);
    onChange(next.size > 0 ? [...next] : undefined);
  }, [valueSet, onChange]);

  const allFilteredSelected = filteredList.length > 0 && filteredList.every(v => valueSet.has(v));

  const toggleAllVisible = useCallback(() => {
    const next = new Set(valueSet);
    if (allFilteredSelected) {
      for (const v of filteredList) next.delete(v);
    } else {
      for (const v of filteredList) next.add(v);
    }
    onChange(next.size > 0 ? [...next] : undefined);
  }, [valueSet, filteredList, allFilteredSelected, onChange]);

  const clearFilter = () => onChange(undefined);

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label ? `Filter ${label}` : 'Filter column'}
        style={{
          ...BUTTON_STYLE_BASE,
          // v0.46: stronger active-state styling. Full primary color background
          // with white text when a filter is set — much more scannable than
          // the previous border-only highlight. Works in both light + dark.
          borderColor: selectedCount > 0 ? 'var(--color-primary)' : 'var(--color-border)',
          background: selectedCount > 0 ? 'var(--color-primary)' : BUTTON_STYLE_BASE.background,
          color: selectedCount > 0 ? '#fff' : BUTTON_STYLE_BASE.color,
          fontWeight: selectedCount > 0 ? 700 : 500,
        }}
        title={selectedCount > 0 ? value.map(displayValue).join(', ') : `Filter by ${label || 'column'}`}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {buttonLabel}
        </span>
        <ChevronDown size={12} strokeWidth={2} style={{ flexShrink: 0, marginLeft: 4 }} />
      </button>
      {open && (
        <>
          {/* v0.53.0: backdrop captures click-anywhere-else-to-close without
              propagating to underlying row click handlers. */}
          <div
            onClick={() => { setOpen(false); triggerRef.current?.focus(); }}
            onMouseDown={(e) => e.stopPropagation()}
            style={{ position: 'fixed', inset: 0, zIndex: 999, background: 'transparent', cursor: 'default' }}
          />
          <div
            style={POPOVER_STYLE}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            style={SEARCH_STYLE}
            aria-label="Search values"
          />
          <div style={LIST_STYLE}>
            {loading && <div style={{ padding: 12, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', textAlign: 'center' }}>Loading…</div>}
            {error && <div style={{ padding: 12, fontSize: 'var(--font-size-sm)', color: 'var(--color-danger)' }}>{error}</div>}
            {!loading && !error && filteredList.length === 0 && (
              <div style={{ padding: 12, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', textAlign: 'center' }}>
                {distinct && distinct.length === 0 ? 'No values' : 'No matches'}
              </div>
            )}
            {!loading && !error && filteredList.length > 0 && (
              <>
                <label
                  style={{
                    ...ROW_STYLE,
                    fontWeight: 600,
                    borderBottom: '1px solid var(--color-border)',
                    marginBottom: 2,
                  }}
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleAllVisible(); }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={() => {}}
                    style={{ cursor: 'pointer' }}
                  />
                  <span>{allFilteredSelected ? 'Deselect all' : 'Select all'}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)' }}>
                    {filteredList.length}
                  </span>
                </label>
                {filteredList.map(v => (
                  <FilterRow
                    key={v}
                    value={v}
                    label={displayValue(v)}
                    isBlank={v === BLANK_SENTINEL}
                    checked={valueSet.has(v)}
                    onToggle={toggleOne}
                  />
                ))}
              </>
            )}
          </div>
          {/* v0.46 immediate-apply: no Apply / Cancel buttons. Toggles commit
              to parent state immediately. Popover closes on click-outside or
              Escape. Only the "Clear filter" affordance remains for one-click
              column-reset. */}
          {/* v0.53.0: footer with Clear (when selections exist) + Done. */}
          <div style={{ display: 'flex', marginTop: 8, gap: 6, justifyContent: 'space-between', alignItems: 'center' }}>
            {selectedCount > 0 ? (
              <button
                type="button"
                onClick={clearFilter}
                style={{
                  fontSize: 'var(--font-size-xs)', fontWeight: 500, padding: '4px 10px',
                  border: '1px solid var(--color-border)', borderRadius: 3,
                  background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer',
                }}
                title="Reset this column's filter"
              >
                <XIcon size={11} strokeWidth={2} style={{ verticalAlign: '-1px', marginRight: 4 }} />
                Clear filter
              </button>
            ) : <span />}
            <button
              type="button"
              onClick={() => { setOpen(false); triggerRef.current?.focus(); }}
              style={{
                fontSize: 'var(--font-size-xs)', fontWeight: 600, padding: '4px 14px',
                border: '1px solid var(--color-primary)', borderRadius: 3,
                background: 'var(--color-primary)', color: '#fff', cursor: 'pointer',
              }}
              title="Close this filter"
            >
              Done
            </button>
          </div>
        </div>
        </>
      )}
    </div>
  );
}
