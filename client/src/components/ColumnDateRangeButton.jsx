// ─────────────────────────────────────────────────────────────────────────────
// ColumnDateRangeButton.jsx — v0.44 single-button date-range filter
//
// Replaces the v0.43 stacked from/to date inputs with one button that opens
// a popover containing both inputs. Button label shows the active range
// (e.g. "Jan 1 — Mar 31, 2026") when set, or just "Filter" when empty.
//
// Props:
//   • label   — column header label, used in aria-label + tooltip
//   • value   — { from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' } | undefined
//   • onChange — callback, fired 500ms after user changes either date (or on Clear)
//
// State management: immediate-apply with 500ms debounce — consistent with
// ColumnFilterDropdown. Apply/Cancel buttons removed (T8-N7). Click-outside
// or Escape closes the popover; committed values remain active.
//
// Why two native <input type="date"> + a popover instead of a full calendar
// grid component? It's a one-line button trigger, the native picker is
// universally supported, no new dependency, and the layout reads cleanly.
// If a future version wants the Airbnb/Notion-style range calendar, swap
// in react-day-picker (~30KB) without touching the calling code.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from 'react';
import { Calendar } from 'lucide-react';

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
  right: 0,
  marginTop: 4,
  minWidth: 240,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
  zIndex: 1000,
  padding: 12,
};

const DATE_INPUT_STYLE = {
  width: '100%',
  padding: '5px 8px',
  fontSize: 'var(--font-size-sm)',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  background: 'var(--color-bg, var(--color-surface))',
  color: 'var(--color-text)',
  boxSizing: 'border-box',
};

function formatDate(iso) {
  if (!iso) return '';
  // Parse YYYY-MM-DD as a local date (avoid the UTC->local off-by-one)
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatRangeLabel(value) {
  const from = value?.from;
  const to   = value?.to;
  if (!from && !to) return 'Filter';
  if (from && to) {
    // Drop the year on the first date if both dates are in the same year
    const [fy] = from.split('-');
    const [ty] = to.split('-');
    if (fy === ty) {
      const fromShort = new Date(...from.split('-').map((s,i) => i===0 ? Number(s) : i===1 ? Number(s)-1 : Number(s)))
        .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `${fromShort} – ${formatDate(to)}`;
    }
    return `${formatDate(from)} – ${formatDate(to)}`;
  }
  if (from) return `From ${formatDate(from)}`;
  return `Until ${formatDate(to)}`;
}

// T8-N7 (v0.71.8): unified to immediate-apply mode — debounced 500ms so
// rapid keystrokes don't hammer the server. Apply/Cancel removed; click-
// outside or Escape closes the popover. Consistent with ColumnFilterDropdown.
export default function ColumnDateRangeButton({ label, value, onChange }) {
  const [open, setOpen]         = useState(false);
  const [draftFrom, setDraftFrom] = useState(value?.from || '');
  const [draftTo,   setDraftTo]   = useState(value?.to   || '');
  const rootRef = useRef(null);
  const triggerRef = useRef(null); // T3-N7: restore focus on close

  const hasValue    = !!(value?.from || value?.to);
  const buttonLabel = formatRangeLabel(value);

  // Sync draft when external value changes (e.g. "Clear all filters")
  useEffect(() => {
    setDraftFrom(value?.from || '');
    setDraftTo(value?.to   || '');
  }, [value?.from, value?.to]);

  // Immediate-apply with 500ms debounce — only fires when popover is open
  // so mounting with an initial value doesn't trigger an extra onChange.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      const next = {};
      if (draftFrom) next.from = draftFrom;
      if (draftTo)   next.to   = draftTo;
      onChange(Object.keys(next).length ? next : undefined);
    }, 500);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftFrom, draftTo, open]);

  // Close on click-outside + Escape
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) { setOpen(false); triggerRef.current?.focus(); }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const clearAndClose = () => {
    setDraftFrom('');
    setDraftTo('');
    onChange(undefined);
    setOpen(false);
  };

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label ? `Filter ${label} by date range` : 'Filter date range'}
        style={{
          ...BUTTON_STYLE_BASE,
          borderColor: hasValue ? 'var(--color-primary)' : 'var(--color-border)',
          background:  hasValue ? 'var(--color-primary)' : BUTTON_STYLE_BASE.background,
          color:       hasValue ? '#fff' : BUTTON_STYLE_BASE.color,
          fontWeight:  hasValue ? 700 : 500,
        }}
        title={hasValue ? `${label || 'Date'}: ${buttonLabel}` : `Filter ${label || 'date'} by range`}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {buttonLabel}
        </span>
        <Calendar size={12} strokeWidth={1.75} style={{ flexShrink: 0, marginLeft: 4 }} />
      </button>
      {open && (
        <div style={POPOVER_STYLE} onClick={(e) => e.stopPropagation()}>
          <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
            {label ? `${label} range` : 'Date range'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 2 }}>
                From
              </label>
              <input
                type="date"
                value={draftFrom}
                onChange={(e) => setDraftFrom(e.target.value)}
                style={DATE_INPUT_STYLE}
                aria-label="Start date"
              />
            </div>
            <div>
              <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 2 }}>
                To
              </label>
              <input
                type="date"
                value={draftTo}
                onChange={(e) => setDraftTo(e.target.value)}
                style={DATE_INPUT_STYLE}
                aria-label="End date"
              />
            </div>
          </div>
          {hasValue && (
            <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-start' }}>
              <button
                type="button"
                onClick={clearAndClose}
                style={{
                  fontSize: 'var(--font-size-xs)',
                  padding: '4px 8px',
                  border: '1px solid var(--color-border)',
                  borderRadius: 3,
                  background: 'transparent',
                  color: 'var(--color-text-secondary)',
                  cursor: 'pointer',
                }}
              >
                Clear filter
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
