// ─────────────────────────────────────────────────────────────────────────────
// Toast.jsx — v0.41 inline transient notification (v0.95: internal stack)
//
// Replaces window.alert() for non-blocking informational messages — the
// Phase 5 "your file is downloading, click Show in folder…" UX hint
// shouldn't block the browser thread or disrupt the user's focus.
//
// Stacking model (v0.95, UX-8-14): callers still drive this with a single
// `toast` prop (backward-compatible). Internally, each time the `toast`
// prop changes to a new non-null value it is PUSHED onto a short-lived
// stack and rendered above the previous one, bottom-right, instead of
// instantly replacing/destroying it. Each entry runs its own auto-dismiss
// timer. `onClose` fires when the newest toast is dismissed, preserving the
// existing parent pattern (`onClose={() => setToast(null)}`).
//
// Usage (unchanged):
//
//   const [toast, setToast] = useState(null);
//   // ...
//   setToast({ message: 'Your file is downloading…', variant: 'info' });
//   // ...
//   <Toast toast={toast} onClose={() => setToast(null)} />
//
// Toast shape: { message: string, title?: string, variant?: 'info' | 'success' | 'warn' | 'error', duration?: ms }
// duration defaults to 8000ms; pass 0 for "sticky until manually dismissed".
//
// Positions bottom-right. Slide-in via CSS transform; auto-dismiss via
// setTimeout. role/aria-live announce to assistive tech (no focus stealing).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import { X as XIcon, Info, CheckCircle, AlertTriangle, AlertCircle } from 'lucide-react';

const VARIANT_STYLES = {
  info: {
    bg: 'var(--color-surface)',
    border: 'var(--color-info, #3b82f6)',
    color: 'var(--color-text)',
    Icon: Info,
    iconColor: 'var(--color-info, #3b82f6)',
  },
  success: {
    bg: 'var(--color-surface)',
    border: 'var(--color-success, #22c55e)',
    color: 'var(--color-text)',
    Icon: CheckCircle,
    iconColor: 'var(--color-success, #22c55e)',
  },
  warn: {
    bg: 'var(--color-surface)',
    border: 'var(--color-warning, #f59e0b)',
    color: 'var(--color-text)',
    Icon: AlertTriangle,
    iconColor: 'var(--color-warning, #f59e0b)',
  },
  error: {
    bg: 'var(--color-surface)',
    border: 'var(--color-danger, #dc2626)',
    color: 'var(--color-text)',
    Icon: AlertCircle,
    iconColor: 'var(--color-danger, #dc2626)',
  },
};

// One rendered toast in the stack.
function ToastItem({ entry, onDismiss }) {
  useEffect(() => {
    const duration = entry.toast.duration ?? 8000;
    if (duration <= 0) return;
    const t = setTimeout(() => onDismiss(entry.id), duration);
    return () => clearTimeout(t);
    // entry.id is stable for the lifetime of this item.
  }, [entry.id, entry.toast.duration, onDismiss]);

  const variant = VARIANT_STYLES[entry.toast.variant || 'info'] || VARIANT_STYLES.info;
  const { Icon } = variant;

  return (
    <div
      role={entry.toast.variant === 'error' ? 'alert' : 'status'}
      aria-live={entry.toast.variant === 'error' ? 'assertive' : 'polite'}
      style={{
        maxWidth: 380,
        minWidth: 260,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '12px 14px',
        background: variant.bg,
        color: variant.color,
        border: `1px solid ${variant.border}`,
        borderLeftWidth: 4,
        borderRadius: 'var(--radius)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.14)',
        fontSize: 'var(--font-size-ui)',
        lineHeight: 1.45,
        pointerEvents: 'auto',
        // Slide-up affordance — no Tailwind dependency, just inline.
        animation: 'servicecycle-toast-in 180ms ease-out',
      }}
    >
      <Icon
        size={18}
        strokeWidth={2}
        style={{ color: variant.iconColor, flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        {entry.toast.title && (
          <div style={{ fontWeight: 700, marginBottom: 2 }}>{entry.toast.title}</div>
        )}
        <div>{entry.toast.message}</div>
      </div>
      <button
        type="button"
        onClick={() => onDismiss(entry.id)}
        aria-label="Dismiss"
        style={{
          all: 'unset',
          cursor: 'pointer',
          padding: 2,
          color: 'var(--color-text-secondary)',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-text)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-secondary)'; }}
      >
        <XIcon size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

export default function Toast({ toast, onClose }) {
  // Internal stack of currently-visible toasts. Each gets a stable id so a
  // second notification stacks above the first instead of replacing it.
  const [stack, setStack] = useState([]);
  const seenRef = useRef(null); // identity of the last `toast` object we pushed
  const idRef = useRef(0);
  const newestIdRef = useRef(null);

  // Push a new entry whenever the `toast` prop changes to a fresh non-null value.
  useEffect(() => {
    if (!toast) { seenRef.current = null; return; }
    // Guard against re-pushing the same object on unrelated re-renders.
    if (seenRef.current === toast) return;
    seenRef.current = toast;
    const id = ++idRef.current;
    newestIdRef.current = id;
    setStack((s) => [...s, { id, toast }]);
  }, [toast]);

  const dismiss = (id) => {
    setStack((s) => s.filter((e) => e.id !== id));
    // Mirror the legacy contract: when the newest toast is dismissed, tell the
    // parent so it can clear its single `toast` state.
    if (id === newestIdRef.current) onClose?.();
  };

  if (stack.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        right: 20,
        bottom: 20,
        zIndex: 1050,
        display: 'flex',
        flexDirection: 'column-reverse', // newest nearest the bottom edge
        gap: 10,
        pointerEvents: 'none', // wrapper transparent to clicks; items re-enable
      }}
    >
      {stack.map((entry) => (
        <ToastItem key={entry.id} entry={entry} onDismiss={dismiss} />
      ))}
      {/* Inline keyframes — avoids touching the global stylesheet for one animation. */}
      <style>{`
        @keyframes servicecycle-toast-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
