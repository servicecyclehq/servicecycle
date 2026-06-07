// ─────────────────────────────────────────────────────────────────────────────
// ConfirmContext.jsx — v0.42 Promise-based app-wide confirmation
//
// Replaces window.confirm() at every call site with an awaitable hook:
//
//   const confirm = useConfirm();
//   const handleDelete = async () => {
//     if (!await confirm({
//       title: 'Delete this webhook?',
//       message: 'Any automation listening to it will stop receiving alerts.',
//       confirmLabel: 'Delete',
//       danger: true,
//     })) return;
//     // ...existing post-confirm logic, unchanged
//   };
//
// Why this shape (not per-site useState + <ConfirmDialog/> JSX):
//   - Each window.confirm migration becomes a near-drop-in 2-line change
//     instead of a 4-change state-machine refactor (state declaration,
//     handler split into "trigger" + "after-confirm", dialog JSX, import).
//   - For files with multiple confirms (ContractDetail has 4, SettingsPage
//     has 6) this is a 3-5x reduction in churn.
//   - One <ConfirmDialog/> instance lives at the App root next to
//     <AiConsentModal/>, mirroring the established provider pattern.
//
// Implementation: the provider holds an `options` state object (null when
// closed, populated when a confirm is pending). useConfirm() returns a
// function that:
//   1. Stores the options + a resolve callback in a ref-like state
//   2. Returns a Promise that resolves true/false when the user clicks
//      Confirm/Cancel (or hits Enter/Escape, or clicks the backdrop)
//
// Only one confirm can be pending at a time — if a second is fired while
// one's open, the first auto-resolves false (Cancel) and the second takes
// the stage. This matches window.confirm() semantics (browser also queues
// one-at-a-time).
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import ConfirmDialog from '../components/ConfirmDialog';

const ConfirmContext = createContext(null);

export function ConfirmProvider({ children }) {
  const [options, setOptions] = useState(null);
  const resolveRef = useRef(null);

  // The hook-exposed function. Caller passes the dialog options; we open
  // the dialog and return a Promise that resolves when the user picks.
  const confirm = useCallback((opts) => {
    return new Promise((resolve) => {
      // If a previous confirm is still open, auto-cancel it so we don't
      // leak its resolver. Matches window.confirm() one-at-a-time semantics.
      if (resolveRef.current) {
        resolveRef.current(false);
      }
      resolveRef.current = resolve;
      setOptions(opts || {});
    });
  }, []);

  const handleConfirm = useCallback(() => {
    const r = resolveRef.current;
    resolveRef.current = null;
    setOptions(null);
    r?.(true);
  }, []);

  const handleCancel = useCallback(() => {
    const r = resolveRef.current;
    resolveRef.current = null;
    setOptions(null);
    r?.(false);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmDialog
        open={!!options}
        title={options?.title}
        message={options?.message}
        confirmLabel={options?.confirmLabel || 'Confirm'}
        cancelLabel={options?.cancelLabel || 'Cancel'}
        danger={options?.danger || false}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </ConfirmContext.Provider>
  );
}

// Hook used at every call site. Throws if called outside the provider so
// regressions (someone strips the provider out of App.jsx) surface loudly.
export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error('useConfirm() must be used inside <ConfirmProvider>');
  }
  return ctx;
}
