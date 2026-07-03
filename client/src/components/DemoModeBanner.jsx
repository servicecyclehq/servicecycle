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
import api from '../api/client';

const DISMISS_KEY = 'servicecycle_demo_banner_dismissed';

// ── Demo "View as" role switcher (2026-07-03) ────────────────────────────────
// Pinned ids from server/scripts/seed-demo.js + seedContractorBook.js. The
// switcher only renders for sessions already inside the shared demo tenant
// (or the Apex partner home account) — per-visitor sandbox accounts never see
// it, and the server re-enforces the same gates on POST /api/demo/switch-role.
const DEMO_ACCOUNT_ID         = '11111111-1111-4111-8111-111111111111';
const PARTNER_HOME_ACCOUNT_ID = '22222222-0000-4000-8000-000000000000';

const VIEW_AS_OPTIONS = [
  { value: 'admin',      label: 'Admin' },
  { value: 'manager',    label: 'Manager' },
  { value: 'viewer',     label: 'Viewer' },
  { value: 'consultant', label: 'Consultant' },
  { value: 'field_tech', label: 'Field Tech' },
  { value: 'partner',    label: 'Partner (Apex)' },
];

// Map the signed-in seed user back to its switcher option so the select shows
// the current identity. Unknown emails (shouldn't happen behind the account
// gate) fall back to the disabled placeholder.
const EMAIL_TO_OPTION = {
  'admin@demo.local':          'admin',
  'manager@demo.local':        'manager',
  'viewer@demo.local':         'viewer',
  'consultant@demo.local':     'consultant',
  'tech@demo.local':           'field_tech',
  'sam.carter@apexpower.demo': 'partner',
};

export default function DemoModeBanner() {
  const { demoMode, user, setAuthData } = useAuth();
  const [switching, setSwitching] = useState(false);

  // Only the shared demo tenant + the Apex partner home account get the
  // switcher. The server 403s everyone else anyway; this just avoids
  // rendering a control that would error for sandbox visitors.
  const canSwitchRoles =
    !!user &&
    (user.accountId === DEMO_ACCOUNT_ID || user.accountId === PARTNER_HOME_ACCOUNT_ID);

  const handleSwitchRole = useCallback(async (e) => {
    const role = e.target.value;
    if (!role || switching) return;
    setSwitching(true);
    try {
      const res = await api.post('/api/demo/switch-role', { role });
      const { token, refreshToken, user: newUser } = res.data.data;
      // Swap the session exactly the way login does (clear-then-write via
      // AuthContext.setAuthData), then hard-navigate to the app root so every
      // role-scoped surface (routes, feature flags, account settings)
      // rebuilds from the new identity.
      setAuthData(token, refreshToken, newUser);
      window.location.assign('/');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Demo role switch failed:', err?.response?.data?.error || err.message);
      setSwitching(false);
    }
  }, [switching, setAuthData]);

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
          // --color-text-tertiary was never defined in the token set, so this
          // silently fell back to a hardcoded light-mode gray. Use the real
          // muted-text token, which is theme-aware (redefined under
          // [data-theme="dark"] in index.css).
          color: 'var(--color-text-muted, var(--color-text-secondary))',
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
      {canSwitchRoles && (
        <label
          style={{
            display:    'flex',
            alignItems: 'center',
            gap:        '0.35rem',
            marginLeft: '0.5rem',
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          View as:
          <select
            value={EMAIL_TO_OPTION[user?.email] || ''}
            onChange={handleSwitchRole}
            disabled={switching}
            aria-label="View the demo as a different role"
            style={{
              background:   'transparent',
              border:       '1px solid var(--color-warning, #b45309)',
              color:        'var(--color-warning, #b45309)',
              borderRadius: 4,
              padding:      '0.25rem 0.35rem',
              fontSize:     '0.75rem',
              fontWeight:   500,
              cursor:       switching ? 'wait' : 'pointer',
            }}
          >
            <option value="" disabled hidden>Switch role</option>
            {VIEW_AS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      )}
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