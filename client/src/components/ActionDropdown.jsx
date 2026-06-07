// ─────────────────────────────────────────────────────────────────────────────
// ActionDropdown.jsx — v0.52 toolbar consolidation
//
// Generic button-triggers-menu component for list-page toolbars. Replaces a
// horizontal row of related action buttons with a single labelled dropdown.
//
// Used by ContractsList for the "Add ▼" (Import CSV / Upload document) and
// "Export ▼" (Download view / Email view / Export CSV) collapses; will be
// reused by Alerts / Vendors / etc. when they inherit the canonical list-page
// pattern (see docs/design/list-page-canonical-pattern.md).
//
// Behavior parity with the rest of the app:
//   • Click trigger button → opens popover
//   • Click outside / Escape / click an item → closes popover
//   • Items can be disabled (rendered greyed out, no click handler)
//   • Items with `hidden: true` are filtered out — lets callers pre-compute
//     items array without conditional .filter() noise at the call site
//
// Props:
//   • label      — string shown on the trigger button (e.g. "Add", "Export")
//   • icon       — optional lucide-react icon for the trigger button
//   • items      — array of { label, icon, onClick, disabled?, hidden?, title? }
//   • align      — 'left' | 'right' (default 'right'); positions popover
//                  relative to the trigger
//   • className  — optional extra class on the trigger button (default uses
//                  .btn .btn-secondary same as the other toolbar buttons)
//   • title      — optional tooltip on the trigger button itself
//
// If every item is hidden, the trigger button renders disabled-greyed so the
// affordance is permanent (consistent with how Clear-all-filters works on
// ContractsList).
//
// A11y (CR-7 / v0.71.7):
//   • ARIA menu pattern: role="menu" + role="menuitem" + aria-haspopup="menu"
//   • Focus moves into first enabled menuitem on open
//   • Arrow-key (↑↓) + Home/End navigation within menu
//   • Escape closes menu AND returns focus to trigger
//   • Item click/Enter/Space closes menu AND returns focus to trigger
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from 'react';
import { ChevronDown } from 'lucide-react';

const ICON = { size: 14, strokeWidth: 2 };
const ITEM_ICON = { size: 14, strokeWidth: 2 };

export default function ActionDropdown({
  label,
  icon: TriggerIcon,
  items = [],
  align = 'right',
  className = 'btn btn-secondary',
  title,
}) {
  const [open, setOpen] = useState(false);
  const rootRef   = useRef(null);
  const triggerRef = useRef(null);
  const menuRef    = useRef(null);

  const visibleItems  = items.filter((it) => !it.hidden);
  const enabledItems  = visibleItems.filter((it) => !it.disabled);
  const allDisabled   = visibleItems.length === 0 || enabledItems.length === 0;

  // ── Focus first enabled menuitem on open ────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      const first = menuRef.current?.querySelector('[role="menuitem"]:not([aria-disabled="true"])');
      first?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [open]);

  // ── Close on outside-click; Escape closes + restores trigger focus ───────
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // ── Arrow-key navigation within menu ────────────────────────────────────
  const handleMenuKeyDown = (e) => {
    if (!menuRef.current) return;
    const focusable = Array.from(
      menuRef.current.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')
    );
    if (!focusable.length) return;
    const idx = focusable.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusable[(idx + 1) % focusable.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusable[(idx - 1 + focusable.length) % focusable.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusable[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      focusable[focusable.length - 1]?.focus();
    }
  };

  const handleItemClick = (item) => {
    if (item.disabled) return;
    setOpen(false);
    triggerRef.current?.focus();
    item.onClick?.();
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        ref={triggerRef}
        type="button"
        className={className}
        onClick={() => !allDisabled && setOpen((o) => !o)}
        disabled={allDisabled}
        title={title || label}
        aria-haspopup="menu"
        aria-expanded={open}
        style={allDisabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
      >
        {TriggerIcon ? <TriggerIcon {...ICON} /> : null}
        {label}
        <ChevronDown size={12} strokeWidth={2} style={{ marginLeft: 2 }} />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={handleMenuKeyDown}
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            [align]: 0,
            zIndex: 20,
            minWidth: 220,
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
            boxShadow: '0 6px 20px rgba(0,0,0,0.12)',
            padding: '6px 0',
          }}
        >
          {visibleItems.map((item, idx) => {
            const ItemIcon = item.icon;
            return (
              <div
                key={item.label || idx}
                role="menuitem"
                tabIndex={item.disabled ? -1 : 0}
                onClick={() => handleItemClick(item)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleItemClick(item);
                  }
                }}
                title={item.title}
                aria-disabled={item.disabled || undefined}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 14px',
                  fontSize: 'var(--font-size-ui)',
                  cursor: item.disabled ? 'not-allowed' : 'pointer',
                  color: item.disabled ? 'var(--color-text-muted)' : 'var(--color-text)',
                  opacity: item.disabled ? 0.55 : 1,
                  transition: 'background 0.1s',
                  outline: 'none',
                }}
                onMouseEnter={(e) => {
                  if (!item.disabled) e.currentTarget.style.background = 'var(--color-bg)';
                }}
                onMouseLeave={(e) => { e.currentTarget.style.background = ''; }}
                onFocus={(e) => {
                  if (!item.disabled) e.currentTarget.style.background = 'var(--color-bg)';
                }}
                onBlur={(e) => { e.currentTarget.style.background = ''; }}
              >
                {ItemIcon ? <ItemIcon {...ITEM_ICON} /> : null}
                <span style={{ flex: 1 }}>{item.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
