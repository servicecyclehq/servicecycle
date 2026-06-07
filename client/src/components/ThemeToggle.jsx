/**
 * ThemeToggle — sun/moon button that flips the app between light and dark mode.
 *
 * Storage: `lapseiq_theme` in localStorage. Pre-React bootstrap in
 * `index.html` reads the same key and applies the attribute before the SPA
 * mounts so dark-mode users don't see a flash of light theme on reload.
 *
 * The dark palette lives in `index.css` under `[data-theme="dark"]`. The
 * sidebar is intentionally NOT re-tokenized — it was already dark in light
 * mode by design and continues to feel like "the chrome" in both themes.
 *
 * Shipped: v0.7.0.
 */

import { useEffect, useState } from 'react';
import { Sun, Moon } from 'lucide-react';

const STORAGE_KEY = 'lapseiq_theme';

function getInitialTheme() {
  if (typeof window === 'undefined') return 'light';
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
  } catch (_) { /* localStorage blocked */ }
  return 'light';
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState(getInitialTheme);

  // Apply the attribute to <html> whenever theme changes. Also covers the
  // first-mount case where pre-React script left the attribute matching the
  // stored value (no double-write, same value).
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.setAttribute('data-theme', 'dark');
    } else {
      root.removeAttribute('data-theme');
    }
    try { window.localStorage.setItem(STORAGE_KEY, theme); } catch (_) { /* ignore */ }
  }, [theme]);

  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  const isDark = theme === 'dark';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      style={{
        width: '100%', textAlign: 'left',
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '5px 10px', borderRadius: 'var(--radius)',
        background: 'none', border: 'none', cursor: 'pointer',
        fontSize: 'var(--font-size-sm)', color: 'var(--color-sidebar-text)',
        transition: 'background 0.1s, color 0.1s',
        lineHeight: 1.4,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-sidebar-hover)'; e.currentTarget.style.color = 'var(--color-sidebar-text-active)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--color-sidebar-text)'; }}
    >
      {isDark
        ? <Sun  size={14} strokeWidth={2} style={{ flexShrink: 0 }} aria-hidden="true" />
        : <Moon size={14} strokeWidth={2} style={{ flexShrink: 0 }} aria-hidden="true" />}
      {isDark ? 'Light theme' : 'Dark theme'}
    </button>
  );
}
