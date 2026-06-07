// ─────────────────────────────────────────────────────────────────────────────
// SavedViewsMenu.jsx — v0.40 Phase 3 + v0.41 ConfirmDialog swap
//
// Bookmark-icon button + dropdown popover listing saved views for a list
// page. Each view is a named snapshot of {columnVisibility + filter state
// + sort}. Click a view to apply; click ✕ to delete.
//
// Props:
//   • storageKey     — e.g. 'servicecycle:assets-list:saved-views'
//   • currentState   — opaque object captured when user clicks "Save current
//                      view as…". The page owns this — the menu just hands
//                      it back when applying.
//   • onApply        — (state) => void; called when user picks a saved view
//   • label          — optional button label, default "Views"
//
// Internal state:
//   • views          — array loaded from localStorage on mount + after
//                      every add/delete/rename
//   • open           — popover open/close
//   • adding         — when true, shows the name input + Save/Cancel inline
//   • pendingDelete  — v0.41: view marked for deletion, awaiting confirm
//
// The popover closes on click-outside + Escape. Same affordance pattern as
// ColumnPicker so the toolbar feels consistent.
//
// v0.41 change: delete confirmation now uses in-app <ConfirmDialog/> instead
// of window.confirm(). The browser-native dialog blocked MCP automation
// during smoke-testing and looked foreign vs the rest of the app. The
// popover closes when the dialog opens so the user has a clean focus path.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from 'react';
import { Star, X as XIcon, Plus } from 'lucide-react';
import ConfirmDialog from './ConfirmDialog';
import { useConfirm } from '../context/ConfirmContext';
import { useUserPreference } from '../hooks/useUserPreference';

// Best-effort UUID — crypto.randomUUID is on every browser we support;
// the fallback keeps us safe in test/JSDOM contexts that lack crypto.
function viewUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export default function SavedViewsMenu({ storageKey, currentState, onApply, label = 'My Views' }) {
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  // H4-5 (v0.76.7): one-time onboarding tip when no views exist yet
  const [onboardingSeen, setOnboardingSeen] = useState(
    () => !!localStorage.getItem('liq:svmenu-onboarded')
  );
  // v0.42: cross-device persistence via UserPreference. The hook handles
  // initial cache → server fetch reconciliation. Defensive normalize on read:
  // if the server stored something other than an array (legacy / corrupt),
  // start fresh rather than blow up the menu.
  const [rawViews, setViews] = useUserPreference(storageKey, []);
  const views = Array.isArray(rawViews) ? rawViews : [];
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);
  const rootRef = useRef(null);
  const inputRef = useRef(null);

  // Close handlers — Escape closes whatever's open (with adding mode taking
  // priority); click-outside closes the popover. The ConfirmDialog has its
  // own Escape handler that takes priority while it's mounted.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setOpen(false);
        setAdding(false);
        setDraftName('');
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (adding) {
          setAdding(false);
          setDraftName('');
        } else if (!pendingDelete) {
          // ConfirmDialog handles its own Escape when open; don't double-fire.
          setOpen(false);
        }
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, adding, pendingDelete]);

  // Auto-focus the name input when entering "adding" mode
  useEffect(() => {
    if (adding && inputRef.current) inputRef.current.focus();
  }, [adding]);

  const handleApply = (view) => {
    setOpen(false);
    onApply(view.state);
  };

  // v0.41: was window.confirm — now opens an in-app ConfirmDialog and
  // closes the popover so the dialog isn't visually competing with the
  // dropdown.
  const handleDelete = (view, e) => {
    e.stopPropagation();
    setOpen(false);
    setPendingDelete(view);
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    setViews(views.filter(v => v.id !== pendingDelete.id));
    setPendingDelete(null);
  };

  // v0.42: async so useConfirm() can await the in-app dialog.
  // Previously sync + window.confirm — now Promise-based, no browser dialog.
  const handleSaveCurrent = async () => {
    const name = draftName.trim();
    if (!name) return;
    // If a view with the same name already exists, overwrite its state
    // instead of duplicating — matches the prior addSavedView() semantics.
    const existing = views.find(v => v.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      // Pass-6 T8-N1: Ask before overwriting an existing view.
      const overwrite = await confirm({
        title:        'Overwrite saved view?',
        message:      `A saved view named "${existing.name}" already exists. Overwrite it, or save a copy named "${name} (2)"?`,
        confirmLabel: 'Overwrite',
        cancelLabel:  `Save as "${name} (2)"`,
        danger:       false,
      });
      if (overwrite) {
        setViews(views.map(v => v.id === existing.id
          ? { ...v, state: currentState, updatedAt: new Date().toISOString() }
          : v));
      } else {
        // Save as new with a numeric suffix.
        const newName = `${name} (2)`;
        setViews([
          ...views,
          { id: `view_${viewUuid()}`, name: newName, createdAt: new Date().toISOString(), state: currentState },
        ]);
      }
      setAdding(false);
      setDraftName('');
      return;
    } else {
      setViews([
        ...views,
        { id: `view_${viewUuid()}`, name, createdAt: new Date().toISOString(), state: currentState },
      ]);
    }
    setAdding(false);
    setDraftName('');
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Saved views — named bundles of filters + column visibility"
        style={{ whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <Star size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px' }} />
        {label}
        {views.length > 0 && (
          <span style={{
            fontSize: 'var(--font-size-2xs)', fontWeight: 700, padding: '1px 6px', borderRadius: 10,
            background: 'var(--color-primary-light)', color: 'var(--color-primary)',
            marginLeft: 2,
          }}>
            {views.length}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            zIndex: 20,
            minWidth: 260,
            maxWidth: 360,
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
            Saved Views
          </div>

          {views.length === 0 && !onboardingSeen && (
            <div
              style={{
                margin: '4px 10px 2px',
                padding: '8px 12px',
                background: 'var(--color-primary-light, #e0f0f8)',
                border: '1px solid var(--color-primary, #0d4f6e)',
                borderRadius: 6,
                fontSize: 'var(--font-size-sm)',
                lineHeight: 1.45,
                color: 'var(--color-primary, #0d4f6e)',
                cursor: 'pointer',
              }}
              onClick={() => { localStorage.setItem('liq:svmenu-onboarded', '1'); setOnboardingSeen(true); }}
              title="Click to dismiss"
            >
              <strong>Save your first view</strong> — set up the table the way you like it, then click
              {' '}<em>Save current view as&hellip;</em> below. One click restores any saved view.
              <span style={{ float: 'right', opacity: 0.6, marginLeft: 8 }}>&times;</span>
            </div>
          )}
          {views.length === 0 ? (
            <div style={{ padding: '8px 14px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
              No saved views yet. Configure the table the way you like it, then save the view below.
            </div>
          ) : (
            views.map(v => (
              <div
                key={v.id}
                role="menuitem"
                tabIndex={0}
                onClick={() => handleApply(v)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleApply(v);
                  }
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 14px', fontSize: 'var(--font-size-ui)', cursor: 'pointer',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--color-bg)'}
                onMouseLeave={e => e.currentTarget.style.background = ''}
              >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {v.name}
                </span>
                <button
                  type="button"
                  onClick={(e) => handleDelete(v, e)}
                  title={`Delete "${v.name}"`}
                  aria-label={`Delete view ${v.name}`}
                  style={{
                    all: 'unset', cursor: 'pointer', display: 'inline-flex',
                    alignItems: 'center', padding: 2, borderRadius: 3,
                    color: 'var(--color-text-secondary)', opacity: 0.6,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.opacity = 1; e.currentTarget.style.color = 'var(--color-danger)'; }}
                  onMouseLeave={e => { e.currentTarget.style.opacity = 0.6; e.currentTarget.style.color = 'var(--color-text-secondary)'; }}
                >
                  <XIcon size={12} strokeWidth={2} />
                </button>
              </div>
            ))
          )}

          <div style={{ borderTop: '1px solid var(--color-border)', marginTop: 6, padding: '6px 14px' }}>
            {adding ? (
              <div style={{ display: 'flex', gap: 4 }}>
                <input
                  ref={inputRef}
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); handleSaveCurrent(); }
                  }}
                  placeholder="View name…"
                  aria-label="View name"
                  style={{
                    flex: 1, padding: '4px 8px', fontSize: 'var(--font-size-sm)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 3, background: 'var(--color-surface)',
                    color: 'var(--color-text)',
                  }}
                />
                <button
                  type="button"
                  onClick={handleSaveCurrent}
                  disabled={!draftName.trim()}
                  className="btn btn-primary btn-sm"
                  style={{ padding: '3px 10px', fontSize: 'var(--font-size-xs)' }}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => { setAdding(false); setDraftName(''); }}
                  className="btn btn-secondary btn-sm"
                  style={{ padding: '3px 10px', fontSize: 'var(--font-size-xs)' }}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                style={{
                  all: 'unset', cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-primary)',
                }}
              >
                <Plus size={12} strokeWidth={2} />
                Save current view as…
              </button>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete saved view"
        message={pendingDelete ? `Delete the saved view "${pendingDelete.name}"? This can't be undone — the column + filter snapshot is removed permanently.` : ''}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
