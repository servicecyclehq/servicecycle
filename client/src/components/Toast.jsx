// ─────────────────────────────────────────────────────────────────────────────
// Toast.jsx — v0.41 inline transient notification
//
// Replaces window.alert() for non-blocking informational messages — the
// Phase 5 "your file is downloading, click Show in folder…" UX hint
// shouldn't block the browser thread or disrupt the user's focus.
//
// Single-toast model (NOT a stack) — calling setToast(...) again replaces
// whatever's currently showing. For the email-handoff case this is fine:
// the user just clicked Email view; they're not going to click again
// before reading the first message.
//
// Usage:
//
//   const [toast, setToast] = useState(null);
//   // ...
//   setToast({ message: 'Your file is downloading…', variant: 'info' });
//   // ...
//   <Toast toast={toast} onClose={() => setToast(null)} />
//
// Toast shape: { message: string, variant?: 'info' | 'success' | 'warn' | 'error', duration?: ms }
// duration defaults to 8000ms; pass 0 for "sticky until manually dismissed".
//
// Positions bottom-right. Slide-in via CSS transform; auto-dismiss via
// setTimeout. Keyboard: focus the close button on appear so Enter dismisses.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';
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

export default function Toast({ toast, onClose }) {
  const closeBtnRef = useRef(null);

  useEffect(() => {
    if (!toast) return;
    const duration = toast.duration ?? 8000;
    if (duration <= 0) return;
    const t = setTimeout(() => onClose?.(), duration);
    return () => clearTimeout(t);
  }, [toast, onClose]);

  // H7 (audit High, 2026-05-22): the previous useEffect auto-focused the
  // close button on every toast mount, yanking focus mid-typing for users
  // who triggered a background "Draft saved" toast while filling out a
  // form. The role/aria-live pair below handles SR announcement; users
  // who want to dismiss can Tab to the close button.

  if (!toast) return null;

  const variant = VARIANT_STYLES[toast.variant || 'info'] || VARIANT_STYLES.info;
  const { Icon } = variant;

  return (
    <div
      role={toast.variant === 'error' ? 'alert' : 'status'}
      aria-live={toast.variant === 'error' ? 'assertive' : 'polite'}
      style={{
        position: 'fixed',
        right: 20,
        bottom: 20,
        zIndex: 1050,
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
        // Slide-up affordance — no Tailwind dependency, just inline.
        animation: 'lapseiq-toast-in 180ms ease-out',
      }}
    >
      <Icon
        size={18}
        strokeWidth={2}
        style={{ color: variant.iconColor, flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        {toast.title && (
          <div style={{ fontWeight: 700, marginBottom: 2 }}>{toast.title}</div>
        )}
        <div>{toast.message}</div>
      </div>
      <button
        ref={closeBtnRef}
        type="button"
        onClick={() => onClose?.()}
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
      {/* Inline keyframes — avoids touching the global stylesheet for one animation. */}
      <style>{`
        @keyframes lapseiq-toast-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
