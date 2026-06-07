// ─────────────────────────────────────────────────────────────────────────────
// ConfirmDialog.jsx — v0.41 in-app confirmation modal
//
// Drop-in replacement for `window.confirm()` that doesn't:
//   • block the browser thread (so MCP automation can still drive the page)
//   • use the OS-native chrome that looks foreign vs the rest of the app
//   • prevent the keyboard from working on the page underneath
//
// Usage pattern in a parent component:
//
//   const [pending, setPending] = useState(null);
//   // ...
//   <ConfirmDialog
//     open={!!pending}
//     title="Delete saved view"
//     message={pending ? `Delete "${pending.name}"?` : ''}
//     confirmLabel="Delete"
//     danger
//     onConfirm={() => { doDelete(pending); setPending(null); }}
//     onCancel={() => setPending(null)}
//   />
//
// Returning to window.confirm semantics — onConfirm = OK, onCancel = Cancel.
// Pressing Escape or clicking outside the dialog = cancel.
// Pressing Enter while the dialog is open = confirm.
//
// Why not import a library?
//   We've already declined radix/headlessui for ColumnPicker (and SavedViewsMenu)
//   on the grounds that a 50-line bespoke popover is cheaper than a 50KB
//   dependency. Same reasoning here. Total bundle add: ~3KB.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap'; // H7 (audit High): Tab cycles within + ESC closes
import { AlertTriangle } from 'lucide-react';

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}) {
  const confirmBtnRef = useRef(null);

  // Esc to cancel; Enter to confirm. Mounted only while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel?.();
      } else if (e.key === 'Enter') {
        // Only trigger confirm if focus isn't inside an input/textarea that
        // legitimately wants Enter (the dialog usually has no such input
        // but a future variant might).
        const tag = document.activeElement?.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          onConfirm?.();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onConfirm, onCancel]);

  // H7 (audit High, 2026-05-22): focus trap so Tab cycles within the
  // dialog and ESC closes. We disable the hook's autoFocus and keep the
  // explicit confirmBtnRef.focus() so Enter-to-confirm still works
  // on the primary action button (matches window.confirm semantics).
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, { onClose: onCancel, autoFocus: false });
  useEffect(() => {
    if (open && confirmBtnRef.current) confirmBtnRef.current.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onClick={(e) => {
        // Click on the backdrop (this very div) closes; clicks on the inner
        // card don't bubble here because the card stops propagation.
        if (e.target === e.currentTarget) onCancel?.();
      }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-surface)',
          color: 'var(--color-text)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
          maxWidth: 440, width: '100%',
          overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 12,
          padding: '18px 20px 12px',
        }}>
          {danger && (
            <AlertTriangle
              size={22}
              strokeWidth={2}
              style={{ color: 'var(--color-danger)', flexShrink: 0, marginTop: 2 }}
              aria-hidden="true"
            />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            {title && (
              <div
                id="confirm-dialog-title"
                style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, marginBottom: 4 }}
              >
                {title}
              </div>
            )}
            {message && (
              <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                {message}
              </div>
            )}
          </div>
        </div>
        <div style={{
          display: 'flex', gap: 8, justifyContent: 'flex-end',
          padding: '12px 20px 16px',
          background: 'var(--color-bg, transparent)',
        }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            className={danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={onConfirm}
            style={danger ? {
              // Fallback for environments missing .btn-danger — solid red.
              background: 'var(--color-danger, #dc2626)',
              color: '#fff',
              border: 'none',
            } : undefined}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
