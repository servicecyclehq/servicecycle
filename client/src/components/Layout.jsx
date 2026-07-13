import { useState, useEffect, useRef } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap'; // H7: mobile sidebar drawer focus trap + ESC close
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import DemoModeBanner from './DemoModeBanner';
import OfflineBanner from './OfflineBanner';
import DisasterBanner from './DisasterBanner';
import { useAuth } from '../context/AuthContext';
import { useBranding } from '../hooks/useBranding';

// v0.37.1 W5 MT-023: <HelpDrawer /> used to mount HERE inside the
// authenticated <Layout /> shell. That made the JSDoc claim "works on
// the login screen so a prospect on the demo can read help without
// signing up" untrue — the drawer never rendered for unauthenticated
// routes (Login, Register, Forgot, Legal pages). Moved to App.jsx
// (next to <AiConsentModal />) so it sits at the BrowserRouter root and
// every route — auth-gated or not — can listen to servicecycle:open-help.

// ContinueSetupBanner — non-blocking pill at the top of every authenticated
// page (other than /dashboard, where the OnboardingWizard takes over) that
// gives the user a single click back to where they left off in setup.
//
// Without this, a user who clicked "Add a site" lands on /sites, does
// the task, and then has no visible signal that setup is still in progress.
// The wizard intentionally renders only on /dashboard so it doesn't overlay
// the task pages, but that left a UX gap before this banner.
//
// Reads the same localStorage key (servicecycle_onboarding_step) that the
// wizard persists to. Steps 1-4 are 0-indexed in the wizard, so saved step
// value equals the count of steps already advanced past.
//
// "Skip setup" dismiss: sets servicecycle_setup_banner_dismissed in localStorage
// (session-scoped — cleared on logout via SESSION_KEYS in api/client.js) so
// sandbox visitors who just want to explore the pre-seeded data aren't
// nagged on every page. Dismissing does NOT mark onboarding done; the
// wizard stays accessible from the dashboard.
function ContinueSetupBanner() {
  const { user, onboardingDone } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem('servicecycle_setup_banner_dismissed') === 'true') {
        setDismissed(true);
      }
    } catch (_) { /* ignore */ }
  }, []);

  if (!user || onboardingDone || dismissed) return null;
  if (location.pathname === '/dashboard') return null;

  let savedStep = 0;
  try {
    const raw = parseInt(localStorage.getItem('servicecycle_onboarding_step') ?? '0', 10);
    if (!Number.isNaN(raw)) savedStep = Math.max(0, Math.min(4, raw));
  } catch (_) { /* ignore */ }

  function handleDismiss(e) {
    e.stopPropagation();
    try { localStorage.setItem('servicecycle_setup_banner_dismissed', 'true'); } catch (_) { /* ignore */ }
    setDismissed(true);
  }

  const TOTAL = 4;
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
        width: '100%', padding: '8px 16px',
        background: 'var(--color-primary, #0d4f6e)', color: 'var(--color-surface)',
        borderTop: '1px solid rgba(255,255,255,0.15)',
        fontSize: 'var(--font-size-ui)', fontWeight: 500, textAlign: 'center',
        // Sticky so the banner stays in view while scrolling long forms.
        // Z-index sits above page content but below modal overlays.
        position: 'sticky', top: 0, zIndex: 50,
      }}
    >
      {/* Clickable centre area navigates to the dashboard wizard */}
      <button
        type="button"
        onClick={() => navigate('/dashboard')}
        style={{
          display: 'flex', alignItems: 'center', gap: 12,
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'inherit', fontSize: 'inherit', fontWeight: 'inherit', padding: 0,
        }}
        title="Return to the setup wizard on the dashboard"
      >
        <span>Optional setup available — {savedStep} of {TOTAL} steps complete</span>
        <span style={{ fontWeight: 600, textDecoration: 'underline' }}>Continue setup →</span>
      </button>

      {/* Dismiss — hides for this session without marking onboarding done */}
      <button
        type="button"
        onClick={handleDismiss}
        title="Skip setup for this session — you can still run the wizard from the dashboard"
        style={{
          position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'rgba(255,255,255,0.7)', fontSize: 18, lineHeight: 1,
          padding: '2px 6px', borderRadius: 3,
        }}
        aria-label="Dismiss setup banner"
      >
        {'×'}
      </button>
    </div>
  );
}

// DemoBlockedToast — temporary banner shown when the demo 403 interceptor
// fires. Auto-dismisses after 4s. Listens to the custom DOM event emitted
// by api/client.js so it doesn't need to be threaded through component props.
function DemoBlockedToast() {
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    function handler(e) {
      setMessage(e.detail?.message || 'This action is disabled on the ServiceCycle demo.');
      setVisible(true);
      setTimeout(() => setVisible(false), 4000);
    }
    window.addEventListener('servicecycle:demo-blocked', handler);
    return () => window.removeEventListener('servicecycle:demo-blocked', handler);
  }, []);
  if (!visible) return null;
  return (
    // Pass-3 audit HIGH #5: this toast carried important error feedback
    // (write was blocked in demo mode) but was invisible to screen readers
    // — no role, no aria-live. SR users would see no acknowledgment that
    // their submit failed. role="status" + aria-live="polite" + aria-atomic
    // announces the full message exactly once when it appears.
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={{
      position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
      zIndex: 9999, padding: '10px 20px', borderRadius: 8,
      background: 'rgba(13,79,110,0.95)', color: '#fff',
      fontSize: 'var(--font-size-ui)', fontWeight: 500, boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
      display: 'flex', alignItems: 'center', gap: 10, whiteSpace: 'nowrap',
    }}>
      <span style={{ fontSize: 16 }} aria-hidden="true">{'🔒'}</span>
      {message}
      <button
        onClick={() => setVisible(false)}
        aria-label="Dismiss"
        style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', opacity: 0.7, fontSize: 16, lineHeight: 1, padding: 0 }}
      >
        {'×'}
      </button>
    </div>
  );
}

export default function Layout() {
  // Pass-3 audit MUST #5 (2026-05-17): mobile sidebar drawer state.
  // The CSS .app-shell.sidebar-open rule slides the sidebar in;
  // .mobile-menu-btn is hidden on desktop via the @media (max-width:900px)
  // gate in index.css. Toggling state is cheap state; persisting it is
  // intentionally NOT done (drawer is ephemeral per page-view).
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useBranding(); // Load white-label CSS vars on every authenticated page
  // H7 (audit High, 2026-05-22): focus trap on the mobile sidebar drawer.
  // useFocusTrap inside a conditional component is the standard pattern --
  // we mount the trap wrapper only when sidebarOpen so the hook only runs
  // during the drawer's lifecycle. ESC close + first-link autofocus come
  // for free from the hook.
  const sidebarRef = useRef(null);
  useFocusTrap(sidebarOpen ? sidebarRef : { current: null }, {
    onClose: () => setSidebarOpen(false),
    autoFocus: sidebarOpen,
  });
  // Close the drawer on navigation so the user doesn't have to manually
  // dismiss it after tapping a nav item.
  useEffect(() => { setSidebarOpen(false); }, [location.pathname]);

  // (A1) `.app-shell` is `display: flex` (row). The banner needs to span the
  // full viewport width above the sidebar + main split, so we wrap the whole
  // shell in a column container and put the banner outside it. Layout below
  // is unchanged for the no-banner case (the wrapper collapses to a single
  // child when DemoModeBanner returns null).
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      {/* Skip-link — first focusable element so keyboard users can jump past
          the sidebar nav (~15 links) straight to the page content.
          WCAG 2.4.1 Bypass Blocks. Visually hidden until focused (see CSS
          .skip-link rule). Audit Cluster B P1. */}
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      {/* Mobile hamburger — only visible at narrow viewports per the CSS rule.
          Toggles the sidebar-open class on .app-shell. */}
      <button
        type="button"
        className="mobile-menu-btn"
        aria-label={sidebarOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={sidebarOpen}
        aria-controls="sidebar-nav"  /* H7: hamburger controls the sidebar drawer, not the main content region */
        onClick={() => setSidebarOpen(o => !o)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          {sidebarOpen
            ? <><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></>
            : <><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></>}
        </svg>
      </button>
      {/* PWA offline outbox status — fixed overlay, renders null when online
          with nothing to announce. See src/components/OfflineBanner.jsx. */}
      <OfflineBanner />
      <DemoModeBanner />
      {/* B1 (2026-07-13): dashboard shows its own docked disaster line inside
          InstrumentBand -- suppress the global full-width banner there so
          an active event isn't shown twice. */}
      {location.pathname !== '/dashboard' && <DisasterBanner />}
      <ContinueSetupBanner />
      <div
        ref={sidebarRef}
        className={`app-shell${sidebarOpen ? ' sidebar-open' : ''}`}
        // Tap-to-close on the backdrop pseudo-element. Clicking anywhere on
        // .app-shell when sidebar is open closes the drawer; we let the
        // sidebar itself stop propagation via its own click handler at the
        // root level (no per-link wiring needed because location-change
        // already closes the drawer via the useEffect above).
        onClick={(e) => {
          if (!sidebarOpen) return;
          // Only close if the click is the backdrop, not a click inside the
          // sidebar or main-content. ::before backdrop has no DOM node we
          // can reference, so check that the target isn't inside the sidebar.
          const sidebar = e.currentTarget.querySelector('.sidebar');
          if (sidebar && !sidebar.contains(e.target)) setSidebarOpen(false);
        }}
      >
        <Sidebar />
        {/* <main> landmark — audit Cluster B P0 / WCAG 1.3.1 / 4.1.2.
            id="main-content" is the target of the skip-link above. tabIndex
            on a landmark allows the skip-link to move focus into the region
            (without it, focus stays on the skip-link itself in some browsers). */}
        <main id="main-content" tabIndex={-1} className="main-content">
          <Outlet />
        </main>
      </div>
      <DemoBlockedToast />
    </div>
  );
}
