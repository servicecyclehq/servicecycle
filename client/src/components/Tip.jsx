// ─────────────────────────────────────────────────────────────────────────────
// Tip.jsx — the InfoTips primitive: a click-to-open circled-i marker that
// reveals a short, plain-language explanation of a coined / computed term.
//
// Design decisions (locked 2026-06-22):
//   • ONE consistent interaction = CLICK. Not hover — hover tips are unreliable
//     on touch and inconsistent with the rest of the app. (The older inline
//     <InfoTip "(?)"> hover component stays where it is; this is the new,
//     glossary-driven, preference-gated pattern.)
//   • Per-user toggle: tips show by default. A user turns them off in
//     Profile → My View, which sets hiddenFeatures.infoTips = true. When off,
//     <Tip> renders NOTHING — the marker disappears entirely.
//   • Content comes from the central glossary (lib/glossary.js) by `term`, or
//     ad-hoc via `title` + `body`.
//   • Every tip ends with the same reminder that they can be switched off.
//
// Usage:
//   <Tip term="maturityScore" />                     (glossary lookup)
//   <Tip title="X" body="…" />                       (ad-hoc)
//   <Tip term="conditionRating" label="What do C1–C3 mean?" />  (pill legend)
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useId } from 'react';
import { useAuth } from '../context/AuthContext';
import GLOSSARY from '../lib/glossary';

const DISABLE_FOOTER = 'You can disable tips in settings.';

/**
 * Whether the InfoTips are switched on for the current user.
 * Default ON: tips show unless the user explicitly hid them
 * (hiddenFeatures.infoTips === true).
 */
export function useTipsEnabled() {
  const { user } = useAuth();
  return user?.hiddenFeatures?.infoTips !== true;
}

export function Tip({ term, title, body, items, label, size = 14, style }) {
  const enabled = useTipsEnabled();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const popId = useId();

  // Close on outside click + Escape (mirrors the sidebar menu pattern).
  useEffect(() => {
    if (!open) return;
    function onDocClick(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Tips off → render nothing at all.
  if (!enabled) return null;

  const g = term ? GLOSSARY[term] : null;
  const resolvedTitle = title || g?.title || '';
  const resolvedBody = body || g?.body || '';
  const resolvedItems = items || g?.items || null;

  // A term key with no glossary entry is a no-op rather than a broken marker —
  // keeps callers safe if a key is renamed.
  if (term && !g && !title && !body) return null;

  const triggerLabel = `What is ${resolvedTitle || 'this'}?`;

  return (
    <span ref={wrapRef} className="tip" style={{ position: 'relative', display: 'inline-flex', verticalAlign: 'middle', ...style }}>
      <button
        type="button"
        className="tip-trigger"
        aria-label={triggerLabel}
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(v => !v); }}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: label ? 4 : 0,
          color: 'var(--color-text-secondary)',
          lineHeight: 1,
          borderRadius: 4,
        }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-primary)'; }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-text-secondary)'; }}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"
          style={{ width: size, height: size, flexShrink: 0 }}>
          <circle cx="8" cy="8" r="6.5" />
          <line x1="8" y1="7" x2="8" y2="11.5" />
          <circle cx="8" cy="4.6" r="0.7" fill="currentColor" stroke="none" />
        </svg>
        {label && <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 500 }}>{label}</span>}
      </button>

      {open && (
        <span
          id={popId}
          role="tooltip"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            zIndex: 9999,
            width: 270,
            maxWidth: '78vw',
            background: 'var(--color-bg-elevated, var(--color-bg, #fff))',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg, 8px)',
            boxShadow: '0 6px 22px rgba(0,0,0,0.16)',
            padding: '12px 14px',
            fontSize: 'var(--font-size-sm)',
            lineHeight: 1.5,
            color: 'var(--color-text)',
            textAlign: 'left',
            whiteSpace: 'normal',
            cursor: 'auto',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {resolvedTitle && (
            <div style={{ fontWeight: 700, marginBottom: 5 }}>{resolvedTitle}</div>
          )}
          {resolvedBody && (
            <div style={{ color: 'var(--color-text-secondary)' }}>{resolvedBody}</div>
          )}
          {resolvedItems && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: resolvedBody ? 9 : 0 }}>
              {resolvedItems.map((it, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ flexShrink: 0, fontWeight: 700, fontSize: 'var(--font-size-xs)', minWidth: 52 }}>{it.label}</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{it.meaning}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--color-border)', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
            {DISABLE_FOOTER}
          </div>
        </span>
      )}
    </span>
  );
}

export default Tip;
