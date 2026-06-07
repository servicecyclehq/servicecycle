// ─────────────────────────────────────────────────────────────────────────────
// VersionSkewDetector.jsx  (v0.90.4)
//
// Mounted once at the App root. Reads the <meta name="lapseiq-build-id">
// stamped at build time, then polls /api/config every 60 seconds. When the
// server's reported lapseiqVersion moves ahead of the loaded bundle, render
// a non-dismissable banner asking the user to reload.
//
// Closes the residual stale-chunk window that `lazyWithReload` (v0.89.10)
// doesn't catch — namely, users mid-form-fill whose currently-loaded
// chunks haven't been invalidated by a navigation attempt yet. Without
// this, those users would silently run a stale bundle indefinitely until
// they reloaded for an unrelated reason.
//
// The poll only fires for authenticated users (no token = no fetch =
// no surface). Authenticated users are the ones whose mid-session
// freshness actually matters.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useCallback } from 'react';

const POLL_MS = 60 * 1000;
const RELOAD_KEY = 'lapseiq_skew_reload_attempted_at';

function getBundleVersion() {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector('meta[name="lapseiq-build-id"]');
  if (!el) return null;
  const v = el.getAttribute('content');
  // Build-time substitution may have failed (dev server with no Vite plugin run).
  // If we see the literal placeholder, treat as "unknown" -> no skew detection.
  if (!v || v.startsWith('%')) return null;
  return v;
}

export default function VersionSkewDetector() {
  const [serverVersion, setServerVersion] = useState(null);
  const bundleVersion = getBundleVersion();

  const checkOnce = useCallback(async () => {
    try {
      const token = (typeof window !== 'undefined' && window.localStorage)
        ? window.localStorage.getItem('lapseiq_token')
        : null;
      if (!token) return; // unauthenticated -> nothing to compare
      const res = await fetch('/api/config', {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!res.ok) return;
      const json = await res.json();
      const v = json && json.data && json.data.lapseiqVersion;
      if (v) setServerVersion(v);
    } catch (_) {
      // Network errors are non-fatal — try again next interval.
    }
  }, []);

  useEffect(() => {
    if (!bundleVersion) return; // no meta -> nothing to detect
    checkOnce();
    const id = setInterval(checkOnce, POLL_MS);
    return () => clearInterval(id);
  }, [bundleVersion, checkOnce]);

  // Don't render if we couldn't detect skew yet, OR if versions match.
  if (!bundleVersion || !serverVersion) return null;
  if (serverVersion === bundleVersion) return null;

  // Don't render if we already reloaded recently (sessionStorage). Prevents
  // an immediate re-prompt if the browser hadn't yet invalidated the meta
  // tag at reload time (rare but defensive).
  let recentlyReloaded = false;
  try {
    const ts = parseInt(window.sessionStorage.getItem(RELOAD_KEY) || '0', 10);
    if (ts && Date.now() - ts < 5 * 60 * 1000) recentlyReloaded = true;
  } catch (_) { /* private mode */ }
  if (recentlyReloaded) return null;

  const handleReload = () => {
    try { window.sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch (_) {}
    window.location.reload();
  };

  // Non-dismissable. Closes the user's path-of-least-resistance to keep
  // running stale code. Style mirrors the existing DemoModeBanner so the
  // visual language is familiar.
  return (
    <div
      role="alert"
      aria-live="polite"
      style={{
        position:      'sticky',
        top:           'var(--demo-banner-height, 0)',
        zIndex:        195,
        background:    '#0d4f6e',
        color:         '#ffffff',
        padding:       '0.5rem 1rem',
        fontSize:      '0.85rem',
        fontWeight:    500,
        display:       'flex',
        alignItems:    'center',
        justifyContent:'center',
        gap:           '0.75rem',
        textAlign:     'center',
      }}
    >
      <span aria-hidden="true">⬆️</span>
      <span>
        A new version of LapseIQ is available ({serverVersion}). Reload to update.
      </span>
      <button
        type="button"
        onClick={handleReload}
        style={{
          background:  '#ffffff',
          color:       '#0d4f6e',
          border:      'none',
          padding:     '0.25rem 0.85rem',
          borderRadius: 4,
          fontSize:    '0.8rem',
          fontWeight:  600,
          cursor:      'pointer',
        }}
      >
        Reload now
      </button>
    </div>
  );
}
