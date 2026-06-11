// ─────────────────────────────────────────────────────────────────────────────
// HeaderFilter.jsx — D1 Excel-style per-column header filter control.
//
// Rendered inside a dedicated filter row directly beneath the column headers
// (AssetsList). One compact "Filter ▾" button per column; clicking opens a
// fixed-position popover whose body depends on the column type:
//
//   • type="multi"  — distinct-value checkbox list (multi-select, OR within
//                     the column) with a search box once the list passes 8
//                     entries. value: string[]
//   • type="text"   — contains-text input. value: string
//   • type="date"   — from/to date range. value: { from, to } (yyyy-mm-dd)
//   • type="number" — min/max inputs. value: { min, max } (strings)
//
// The popover is position:fixed (anchored to the button's rect) so it can't
// be clipped by .table-wrap's overflow-x:clip. It closes on outside click,
// Escape, window resize, and any scroll outside the popover itself.
//
// Active state: the button switches to the primary palette and shows a short
// summary ("2 selected", "“qd”", "≥ 1000", a date range) plus an inline ×
// that clears just this column without opening the popover.
//
// Both themes work out of the box — every color is a CSS variable from
// index.css.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from 'react';

/** Is this column's filter value non-empty (i.e. actively filtering)? */
export function filterIsActive(type, value) {
  if (value == null) return false;
  if (type === 'multi')  return Array.isArray(value) && value.length > 0;
  if (type === 'text')   return String(value).trim() !== '';
  if (type === 'date')   return !!(value.from || value.to);
  if (type === 'number') return value.min !== '' || value.max !== '';
  return false;
}

const truncate = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

const fmtShortDate = (iso) => {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const POP_WIDTH = 248;

const inputStyle = {
  width: '100%',
  padding: '5px 8px',
  fontSize: 'var(--font-size-sm)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 6,
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  outline: 'none',
  boxSizing: 'border-box',
};

const miniLabelStyle = {
  display: 'block',
  fontSize: 'var(--font-size-xs)',
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  marginBottom: 3,
};

export default function HeaderFilter({ label, type, options = [], value, onChange, align = 'left' }) {
  const [open, setOpen]   = useState(false);
  const [pos, setPos]     = useState({ top: 0, left: 0 });
  const [query, setQuery] = useState('');
  const btnRef = useRef(null);
  const popRef = useRef(null);

  const active = filterIsActive(type, value);

  const emptyValue =
    type === 'multi'  ? []
    : type === 'text' ? ''
    : type === 'date' ? { from: '', to: '' }
    :                   { min: '', max: '' };

  function openPopover() {
    const r = btnRef.current.getBoundingClientRect();
    let left = align === 'right' ? r.right - POP_WIDTH : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - POP_WIDTH - 8));
    const top = Math.min(r.bottom + 4, window.innerHeight - 60);
    setPos({ top, left });
    setQuery('');
    setOpen(true);
  }

  // Close on outside click / Escape / resize / scroll outside the popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey    = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onScroll = (e) => { if (popRef.current?.contains(e.target)) return; setOpen(false); };
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  function summary() {
    if (!active) return 'Filter';
    if (type === 'multi') {
      if (value.length === 1) {
        const opt = options.find(o => o.value === value[0]);
        return truncate(String(opt?.label ?? value[0]), 14);
      }
      return `${value.length} selected`;
    }
    if (type === 'text') return `“${truncate(String(value).trim(), 11)}”`;
    if (type === 'date') {
      if (value.from && value.to) return `${fmtShortDate(value.from)} – ${fmtShortDate(value.to)}`;
      if (value.from) return `≥ ${fmtShortDate(value.from)}`;
      return `≤ ${fmtShortDate(value.to)}`;
    }
    if (type === 'number') {
      if (value.min !== '' && value.max !== '') return `${value.min}–${value.max}`;
      if (value.min !== '') return `≥ ${value.min}`;
      return `≤ ${value.max}`;
    }
    return 'Filter';
  }

  const toggleOption = (v) => {
    const next = value.includes(v) ? value.filter(x => x !== v) : [...value, v];
    onChange(next);
  };

  const visibleOptions = type === 'multi'
    ? options.filter(o => !query || String(o.label).toLowerCase().includes(query.toLowerCase()))
    : [];

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        onClick={() => (open ? setOpen(false) : openPopover())}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={active ? `${label} filter active — click to edit` : `Filter ${label}`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          maxWidth: '100%',
          padding: '2px 8px', borderRadius: 6, cursor: 'pointer',
          fontSize: 'var(--font-size-xs)',
          fontWeight: active ? 700 : 500,
          whiteSpace: 'nowrap',
          textTransform: 'none', letterSpacing: 'normal',
          background: active ? 'var(--color-primary-light, #eef6f6)' : 'var(--color-surface)',
          color: active ? 'var(--color-primary)' : 'var(--color-text-muted)',
          border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-border)'}`,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{summary()}</span>
        <span aria-hidden="true" style={{ fontSize: 8, lineHeight: 1 }}>▾</span>
        {active && (
          <span
            role="button"
            tabIndex={0}
            aria-label={`Clear ${label} filter`}
            title={`Clear ${label} filter`}
            onClick={(e) => { e.stopPropagation(); onChange(emptyValue); setOpen(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault(); e.stopPropagation();
                onChange(emptyValue); setOpen(false);
              }
            }}
            style={{ fontWeight: 700, lineHeight: 1, padding: '0 1px', fontSize: 12 }}
          >
            ×
          </span>
        )}
      </button>

      {open && (
        <div
          ref={popRef}
          role="dialog"
          aria-label={`Filter by ${label}`}
          style={{
            position: 'fixed', top: pos.top, left: pos.left, zIndex: 60,
            width: POP_WIDTH,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius, 8px)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
            padding: '10px 12px',
            textTransform: 'none', letterSpacing: 'normal',
            fontSize: 'var(--font-size-sm)', fontWeight: 400,
            color: 'var(--color-text)',
          }}
        >
          <div style={{
            fontSize: 'var(--font-size-xs)', fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: '0.05em',
            color: 'var(--color-text-secondary)', marginBottom: 8,
          }}>
            Filter: {label}
          </div>

          {type === 'multi' && (
            <>
              {options.length > 8 && (
                <input
                  type="search"
                  placeholder="Search values…"
                  aria-label={`Search ${label} values`}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  autoFocus
                  style={{ ...inputStyle, marginBottom: 8 }}
                />
              )}
              <div style={{ maxHeight: 230, overflowY: 'auto', margin: '0 -4px' }}>
                {visibleOptions.length === 0 && (
                  <div style={{ padding: '6px 4px', color: 'var(--color-text-muted)' }}>No matching values</div>
                )}
                {visibleOptions.map(o => (
                  <label
                    key={String(o.value)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '4px 4px', borderRadius: 6, cursor: 'pointer',
                      fontSize: 'var(--font-size-sm)', color: 'var(--color-text)',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={value.includes(o.value)}
                      onChange={() => toggleOption(o.value)}
                      style={{ cursor: 'pointer', flexShrink: 0 }}
                    />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {o.label}
                    </span>
                  </label>
                ))}
              </div>
            </>
          )}

          {type === 'text' && (
            <input
              type="search"
              placeholder="Contains…"
              aria-label={`${label} contains`}
              value={value}
              onChange={e => onChange(e.target.value)}
              autoFocus
              style={inputStyle}
            />
          )}

          {type === 'date' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={miniLabelStyle}>From</label>
                <input
                  type="date"
                  aria-label={`${label} from`}
                  value={value.from}
                  onChange={e => onChange({ ...value, from: e.target.value })}
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={miniLabelStyle}>To</label>
                <input
                  type="date"
                  aria-label={`${label} to`}
                  value={value.to}
                  onChange={e => onChange({ ...value, to: e.target.value })}
                  style={inputStyle}
                />
              </div>
            </div>
          )}

          {type === 'number' && (
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={miniLabelStyle}>Min</label>
                <input
                  type="number"
                  aria-label={`${label} minimum`}
                  value={value.min}
                  onChange={e => onChange({ ...value, min: e.target.value })}
                  autoFocus
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={miniLabelStyle}>Max</label>
                <input
                  type="number"
                  aria-label={`${label} maximum`}
                  value={value.max}
                  onChange={e => onChange({ ...value, max: e.target.value })}
                  style={inputStyle}
                />
              </div>
            </div>
          )}

          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--color-border)',
          }}>
            <button
              type="button"
              disabled={!active}
              onClick={() => onChange(emptyValue)}
              style={{
                all: 'unset', cursor: active ? 'pointer' : 'not-allowed',
                fontSize: 'var(--font-size-sm)', fontWeight: 600,
                color: active ? 'var(--color-danger)' : 'var(--color-text-muted)',
              }}
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              style={{
                all: 'unset', cursor: 'pointer',
                fontSize: 'var(--font-size-sm)', fontWeight: 600,
                color: 'var(--color-primary)',
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </>
  );
}
