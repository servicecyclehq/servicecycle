/**
 * DemoModeBanner.jsx
 * ------------------
 * Sprint 5 (A1): a thin top-of-app strip warning visitors that this is a
 * shared demo instance whose data resets nightly at 3:30 AM. Dismissible
 * per session via localStorage so a heavy user isn't nagged on every
 * page load — the banner re-appears in a fresh browser session.
 *
 * T6-N2 (Pass-6 audit): ?demoBanner=show query param forces the banner
 * visible regardless of localStorage. Useful for sales reps mid-tour who
 * already dismissed the banner. A small "Show demo banner again" link is
 * rendered below the main content when the banner is dismissed so reps can
 * re-enable without manually editing the URL.
 *
 * Renders only when AuthContext.demoMode === true. Sits above Sidebar
 * inside Layout.jsx so it's visible in every authenticated view.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';

const DISMISS_KEY = 'lapseiq_demo_banner_dismissed';

export default function DemoModeBanner() {
  const { demoMode } = useAuth();

  const [dismissed, setDismissed] = useState(() => {
    try {
      // T6-N2 (Pass-6): ?demoBanner=show overrides localStorage so a
      // sales rep can restore the banner mid-tour without clearing storage.
      if (
        typeof window !== 'undefined' &&
        new URLSearchParams(window.location.search).get('demoBanner') === 'show'
      ) {
        // Clear the flag so subsequent page loads also show it.
        window.localStorage?.removeItem(DISMISS_KEY);
        return false;
      }
      return (
        typeof window !== 'undefined' &&
        window.localStorage?.getItem(DISMISS_KEY) === '1'
      );
    } catch {
      return false;
    }
  });

  const dismiss = useCallback(() => {
    try {
      window.localStorage?.setItem(DISMISS_KEY, '1');
    } catch {
      // Private-mode Safari etc. — best-effort only.
    }
    setDismissed(true);
  }, []);

  // T6-N2: "Show demo banner again" — clears the flag and reloads the page.
  const showAgain = useCallback(() => {
    try {
      window.localStorage?.removeItem(DISMISS_KEY);
    } catch { /* ignore */ }
    const url = new URL(window.location.href);
    url.searchParams.set('demoBanner', 'show');
    window.location.href = url.toString();
  }, []);

  // (A1) The sidebar is `position: fixed; top: 0`, so without compensation it
  // would overlap the banner. Publish the banner's measured height as a CSS
  // custom property on the documentElement so any fixed-position chrome can
  // shift down by var(--demo-banner-height, 0).
  const bannerRef = useRef(null);
  const visible   = demoMode && !dismissed;

  useEffect(() => {
    if (!visible) {
      document.documentElement.style.setProperty('--demo-banner-height', '0px');
      return;
    }
    const apply = () => {
      const h = bannerRef.current?.getBoundingClientRect().height || 0;
      document.documentElement.style.setProperty('--demo-banner-height', `${Math.round(h)}px`);
    };
    apply();
    let ro;
    if (typeof ResizeObserver !== 'undefined' && bannerRef.current) {
      ro = new ResizeObserver(apply);
      ro.observe(bannerRef.current);
    }
    window.addEventListener('resize', apply);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', apply);
    };
  }, [visible]);

  // When banner is dismissed in demo mode, render a tiny sticky "restore" link
  // so sales reps can bring it back without editing the URL manually.
  if (!visible) {
    if (!demoMode) return null;
    return (
      <div
        style={{
          position: 'fixed',
          bottom: 8,
          right: 12,
          zIndex: 190,
          fontSize: '0.7rem',
          color: 'var(--color-text-tertiary, #9ca3af)',
        }}
      >
        <button
          type="button"
          onClick={showAgain}
          aria-label="Show demo mode banner again"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            fontSize: 'inherit',
            cursor: 'pointer',
            textDecoration: 'underline',
            padding: '2px 4px',
          }}
        >
          Show demo banner
        </button>
      </div>
    );
  }

  return (
    <div
      ref={bannerRef}
      role="status"
      aria-live="polite"
      style={{
        background:    'var(--color-warning-bg, #fffbeb)',
        color:         'var(--color-warning, #b45309)',
        borderBottom:  '1px solid var(--color-warning, #b45309)',
        padding:       '0.35rem 1rem',
        fontSize:      '0.8rem',
        fontWeight:    500,
        display:       'flex',
        alignItems:    'center',
        justifyContent:'center',
        gap:           '0.5rem',
        textAlign:     'center',
        position:      'sticky',
        top:           0,
        zIndex:        200,
      }}
    >
      <span aria-hidden="true">⚠️</span>
      <span>
        Demo sandbox — entire sandbox is deleted after 5 days of inactivity.
        Don&apos;t enter real customer data; the demo&apos;s TOS forbids it.
      </span>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss demo notice for this session"
        style={{
          marginLeft:  '0.5rem',
          background:  'transparent',
          border:      '1px solid var(--color-warning, #b45309)',
          color:       'var(--color-warning, #b45309)',
          padding:     '0.4rem 0.6rem',
          minHeight:   24,
          borderRadius: 4,
          fontSize:    '0.75rem',
          cursor:      'pointer',
          fontWeight:  500,
        }}
      >
        Dismiss
      </button>
    </div>
  );
}