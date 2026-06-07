// ─────────────────────────────────────────────────────────────────────────────
// ColumnPicker.jsx — v0.40 Phase 1A shared component
//
// Gear-icon button + dropdown popover. Each row is a checkbox that toggles
// one column's visibility. Changes apply live (the parent state updates
// immediately) and persist via whatever onChange the parent wires up (the
// parent typically forwards to a localStorage or AccountSetting helper).
//
// Extracted from ContractsList.jsx so AlertsPage and future list pages
// (Vendors, Activity Log) can drop it in without duplicating ~130 lines.
//
// Props:
//   • columns     — array of TanStack column defs from a registry. Reads
//                   col.id, col.meta.label, col.header.
//   • visibility  — TanStack-shaped { [columnId]: boolean }
//   • onChange    — (nextVisibility) => void. Called on toggle and on
//                   Reset to defaults.
//   • defaults    — visibility map representing the "reset to factory"
//                   state. Passed in (not computed) so the registry can
//                   evolve its own defaults without the picker needing to
//                   know how.
//   • label       — optional button label (default "Columns")
//
// The popover closes on:
//   • click outside (mousedown listener on document)
//   • Escape key
//   • clicking the gear button again
//
// We do NOT use a library here — a ~50-line custom popover keeps the
// dependency footprint flat and avoids dragging in radix/headlessui just
// for one menu.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from 'react';
import { Settings } from 'lucide-react';

export default function ColumnPicker({ columns, visibility, onChange, defaults, label = 'Columns' }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  // Click-outside + Escape handlers. Only mounted while the popover is open
  // so we don't spend listener cycles for closed state.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (id) => {
    const next = { ...visibility, [id]: !(visibility[id] !== false) };
    onChange(next);
  };

  const resetDefaults = () => {
    onChange(defaults);
  };

  // Count visible columns so we can prevent the user from hiding every
  // column (an empty table is a footgun — there'd be no UI to recover
  // from). When only 1 visible column is left, its checkbox is disabled.
  const visibleCount = columns.filter(c => visibility[c.id] !== false).length;

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Choose which columns to show"
        style={{ whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <Settings size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px' }} />
        {label}
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            zIndex: 20,
            minWidth: 220,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
            boxShadow: '0 6px 20px rgba(0,0,0,0.12)',
            padding: '8px 0',
          }}
        >
          <div style={{
            padding: '4px 14px 6px',
            fontSize: 'var(--font-size-xs)',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: 'var(--color-text-secondary)',
          }}>
            Show columns
          </div>
          {columns.map(col => {
            const id      = col.id;
            const colLabel = col.meta?.label || (typeof col.header === 'string' ? col.header : id);
            const checked = visibility[id] !== false;
            // Disable unchecking the last visible column.
            const disabled = checked && visibleCount <= 1;
            return (
              <label
                key={id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '5px 14px',
                  fontSize: 'var(--font-size-ui)',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.55 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggle(id)}
                  style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
                />
                <span>{colLabel}</span>
              </label>
            );
          })}
          <div style={{ borderTop: '1px solid var(--color-border)', marginTop: 6, padding: '6px 14px 2px' }}>
            <button
              type="button"
              onClick={resetDefaults}
              style={{
                all: 'unset',
                cursor: 'pointer',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 600,
                color: 'var(--color-primary)',
              }}
            >
              Reset to defaults
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
