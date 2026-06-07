import { useState } from 'react';

/**
 * PasswordInput - a drop-in replacement for <input type="password"> with a
 * reveal (eye) toggle on the right edge.
 *
 * Goals:
 *  - Accepts every standard <input> prop (value, onChange, id, name,
 *    placeholder, autoComplete, required, minLength, maxLength, disabled,
 *    autoFocus, ...) and forwards them verbatim.
 *  - Keeps the caller's `className` (so existing .form-control / .form-input
 *    styling is preserved) and merges any inline `style`.
 *  - Toggle button has an accessible label that flips between
 *    "Show password" / "Hide password".
 *  - No external icon library - inline SVG eye / eye-off.
 *
 * Layout: the wrapper is a block element; the input fills it and the toggle
 * is absolutely positioned at the right edge. We cap the wrapper at the
 * caller's inline style.maxWidth when present (e.g. cloud-connector secret
 * fields use 440px) so the eye always sits flush with the input's right edge.
 */
export default function PasswordInput({ className, style, wrapperStyle, ...rest }) {
  const [visible, setVisible] = useState(false);

  const maxWidth = style && style.maxWidth != null ? style.maxWidth : undefined;

  const inputStyle = {
    ...style,
    width: '100%',
    // Drop any max-width cap on the input itself so it fills the wrapper and
    // the toggle aligns to its true right edge; the wrapper carries the cap.
    maxWidth: 'none',
    paddingRight: '40px',
    boxSizing: 'border-box',
  };

  return (
    <span
      style={{
        position: 'relative',
        display: 'block',
        maxWidth,
        ...wrapperStyle,
      }}
    >
      <input
        {...rest}
        type={visible ? 'text' : 'password'}
        className={className}
        style={inputStyle}
      />
      <button
        type="button"
        onClick={() => setVisible(v => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        title={visible ? 'Hide password' : 'Show password'}
        tabIndex={0}
        style={{
          position: 'absolute',
          top: '50%',
          right: '8px',
          transform: 'translateY(-50%)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '26px',
          height: '26px',
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: 'var(--color-text-secondary, #5b6373)',
          cursor: 'pointer',
          borderRadius: '4px',
          lineHeight: 0,
        }}
      >
        {visible ? (
          // eye-off
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        ) : (
          // eye
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </span>
  );
}