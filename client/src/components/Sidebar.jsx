import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect, useRef, useLayoutEffect, Suspense, lazy } from 'react';
import { useAuth } from '../context/AuthContext';
import api from '../api/client';
import { assetLabel } from '../lib/equipment';
// v0.37.2 W6 MT-135: lazy-load FeedbackModal — on-demand UI never visible
// on first paint. Lazy lets Vite split it into its own chunk so the
// sidebar's initial bundle stays small. Same pattern HelpDrawer used in
// W5 MT-023. (AskModal was removed in the ServiceCycle conversion — the
// in-product AI assistant feature did not carry over.)
const FeedbackModal = lazy(() => import('./FeedbackModal'));
import ThemeToggle from './ThemeToggle';
// v0.7.0: Lucide icon system. Named imports so Vite tree-shakes everything
// we don't reference.
import {
  LayoutGrid, Zap, Briefcase, Calendar, Bell, Users, Settings, PieChart,
  Archive, MapPin, ClipboardList, ClipboardCheck,
} from 'lucide-react';

// v0.37.1 W5 MT-117: per-NavLink HelpButton icons were dropped — the
// standalone Help button + the Resources & Feedback footer menu are the
// two help entry points.

// All sidebar icons share the same size + stroke for visual consistency.
const ICON_PROPS = { size: 16, strokeWidth: 1.75, className: 'nav-icon' };
const Icons = {
  dashboard:   <LayoutGrid    {...ICON_PROPS} />,
  assets:      <Zap           {...ICON_PROPS} />,
  archive:     <Archive       {...ICON_PROPS} />,
  sites:       <MapPin        {...ICON_PROPS} />,
  workOrders:  <ClipboardList {...ICON_PROPS} />,
  calendar:    <Calendar      {...ICON_PROPS} />,
  audits:      <ClipboardCheck {...ICON_PROPS} />,
  contractors: <Briefcase     {...ICON_PROPS} />,
  alerts:      <Bell          {...ICON_PROPS} />,
  users:       <Users         {...ICON_PROPS} />,
  settings:    <Settings      {...ICON_PROPS} />,
  reports:     <PieChart      {...ICON_PROPS} />,
};

function GlobalSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef();
  const timerRef = useRef();

  // Close on outside click
  useEffect(() => {
    function handler(e) { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (!query.trim() || query.length < 2) { setResults([]); setOpen(false); return; }
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await api.get('/api/assets', { params: { search: query.trim(), limit: 6 } });
        setResults(res.data.data?.assets || []);
        setOpen(true);
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 280);
    return () => clearTimeout(timerRef.current);
  }, [query]);

  function go(e) {
    e.preventDefault();
    if (!query.trim()) return;
    setOpen(false);
    setQuery('');
    navigate(`/assets?search=${encodeURIComponent(query.trim())}`);
  }

  function pick(id) {
    setOpen(false);
    setQuery('');
    navigate(`/assets/${id}`);
  }

  return (
    <div ref={wrapRef} style={{ padding: '0 12px 10px', position: 'relative' }}>
      <form onSubmit={go}>
        <div style={{ position: 'relative' }}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"
            style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', width: 13, height: 13, color: 'var(--color-text-secondary)', pointerEvents: 'none' }}>
            <circle cx="6.5" cy="6.5" r="4.5"/>
            <line x1="10" y1="10" x2="14" y2="14"/>
          </svg>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && (setOpen(false), setQuery(''))}
            placeholder="Search assets…"
            aria-label="Search assets"
            style={{ width: '100%', boxSizing: 'border-box', paddingLeft: 26, paddingRight: 8, paddingTop: 5, paddingBottom: 5, fontSize: 'var(--font-size-sm)', border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius)', background: 'var(--color-surface)', color: 'var(--color-text)', outline: 'none' }}
          />
        </div>
      </form>
      {open && (
        // Pass-3 audit LOW #6: results have role="option" — needs a
        // parent role="listbox" so SR users hear "listbox, 3 options"
        // when the dropdown opens. aria-label gives the listbox a name.
        <div
          role="listbox"
          aria-label="Asset search results"
          style={{ position: 'absolute', top: '100%', left: 12, right: 12, background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', boxShadow: '0 6px 20px rgba(0,0,0,0.12)', zIndex: 600, overflow: 'hidden' }}
        >
          {loading && <div style={{ padding: '10px 12px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>Searching…</div>}
          {!loading && results.length === 0 && (
            <div style={{ padding: '10px 12px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>No matches</div>
          )}
          {!loading && results.map(a => (
            // Audit Cluster B P0 (WCAG 2.1.1 + 4.1.2): div+onClick is not
            // keyboard-reachable. <button type="button"> activates natively
            // on Enter/Space and ships into the tab order. role="option"
            // (paired with role="listbox" on the parent) lets screen readers
            // announce the result list shape correctly.
            <button
              type="button"
              key={a.id}
              role="option"
              onClick={() => pick(a.id)}
              className="search-result-row"
              style={{ all: 'unset', display: 'block', padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--color-border)', width: '100%', textAlign: 'left' }}
            >
              <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{assetLabel(a)}</div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{a.site?.name}</div>
            </button>
          ))}
          {!loading && results.length > 0 && (
            <button
              type="button"
              onClick={go}
              style={{ all: 'unset', display: 'block', width: '100%', padding: '7px 12px', fontSize: 'var(--font-size-xs)', color: 'var(--color-primary)', cursor: 'pointer', fontWeight: 600, background: 'var(--color-surface)', textAlign: 'left' }}
            >
              See all results for "{query}" →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function getInitials(name = '') {
  return name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
}

function NotificationBell() {
  const [count, setCount] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    function fetchCount() {
      api.get('/api/alerts')
        .then(r => setCount(r.data.data?.count || 0))
        .catch(() => {});
    }
    fetchCount();
    const id = setInterval(fetchCount, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // Audit Cluster B P1 (WCAG 4.1.3 Status Messages): the count was only
  // surfaced via `title` (unreliable for SR) and a visual badge. Adding an
  // aria-label + aria-live="polite" so screen readers announce changes
  // without stealing focus.
  const alertCountText = count > 0
    ? `${count} alert${count !== 1 ? 's' : ''} pending`
    : 'No alerts';
  return (
    <button
      type="button"
      onClick={() => navigate('/alerts')}
      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: 6, color: count > 0 ? 'var(--color-warning)' : 'var(--color-text-secondary)', position: 'relative', display: 'flex', alignItems: 'center' }}
      title={alertCountText}
      aria-label={alertCountText + ' — open alerts page'}
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ width: 18, height: 18 }} aria-hidden="true">
        <path d="M8 1a5 5 0 0 1 5 5v2.5l1 2H2l1-2V6a5 5 0 0 1 5-5z"/>
        <path d="M6.5 13a1.5 1.5 0 0 0 3 0"/>
      </svg>
      {count > 0 && (
        <span
          role="status"
          aria-live="polite"
          aria-atomic="true"
          style={{ position: 'absolute', top: -1, right: -1, background: 'var(--color-warning-bg)', color: 'var(--color-warning)', borderRadius: 10, fontSize: 'var(--font-size-xs)', fontWeight: 700, minWidth: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px', fontVariantNumeric: 'tabular-nums' }}
        >
          {count > 9 ? '9+' : count}
        </span>
      )}
    </button>
  );
}

function ConsultantBanner() {
  return (
    <div style={{
      margin: '0 10px 8px',
      padding: '7px 10px',
      background: 'rgba(234, 179, 8, 0.12)',
      border: '1px solid rgba(234, 179, 8, 0.35)',
      borderRadius: 6,
      fontSize: 'var(--font-size-xs)',
      color: 'rgb(234, 179, 8)',
      lineHeight: 1.4,
    }}>
      <strong>Vendor Access</strong><br />
      You are viewing this account as a maintenance vendor account manager. Changes are logged.
    </div>
  );
}

// 2026-05-10 v0.2.30 (role-tier walk N5): viewer is fully read-only but had
// no in-app indication of that — empty action-button areas on asset detail
// just looked broken. Mirrors ConsultantBanner styling but in slate so it
// reads as a status note rather than a "logged" warning.
function ViewerBanner() {
  return (
    <div style={{
      margin: '0 10px 8px',
      padding: '7px 10px',
      background: 'rgba(100, 116, 139, 0.12)',
      border: '1px solid rgba(100, 116, 139, 0.35)',
      borderRadius: 6,
      fontSize: 'var(--font-size-xs)',
      color: 'rgb(148, 163, 184)',
      lineHeight: 1.4,
    }}>
      <strong>View-Only Access</strong><br />
      You can view equipment and reports but can't make changes. Ask an admin to edit.
    </div>
  );
}

// L9: Help / Share menu — collapsible footer block above the user chip.
// Items:
//   - Docs                            external link
//   - Get ServiceCycle for your team  external link to the L7 marketing form
//   - Share ServiceCycle              prefilled mailto, lets visitors forward to a colleague
//   - Send feedback                   opens existing FeedbackModal
//   - Contact support                 mailto:support@servicecycle.com
//
// Visible to all roles in DEMO_MODE (the whole demo crowd is the audience for
// "share / get this for your team" prompts). On non-demo installs we show only
// the in-app actions (feedback + support) — the marketing prompts there would
// be either redundant ("get this for your team" — they already have it) or
// inappropriate (asking the customer to share their proprietary install).
function HelpShareMenu({ demoMode, onSendFeedback }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const navigate = useNavigate();

  // Cap the menu height to the space actually available above the button so
  // items are never hidden above the viewport (e.g. when the demo banner is
  // present or on shorter laptop screens). Recalculates whenever the menu opens.
  useLayoutEffect(() => {
    if (open && btnRef.current && menuRef.current) {
      const btnTop = btnRef.current.getBoundingClientRect().top;
      const available = btnTop - 12; // 12px margin from viewport top
      menuRef.current.style.maxHeight = `${Math.max(available, 120)}px`;
    }
  }, [open]);

  // Close on outside click + Escape — keeps the menu out of the way once
  // the visitor moves on.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    function onKey(e)      { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown',   onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown',   onKey);
    };
  }, [open]);

  const SHARE_BODY = encodeURIComponent(
    'Hey — thought you might find this useful for maintenance compliance.\n' +
    'It’s called ServiceCycle — self-hosted electrical equipment maintenance ' +
    'compliance tracker built for facilities teams that need NFPA 70B ' +
    'schedules without an enterprise CMMS.\n\n' +
    'Public demo: https://demo.servicecycle.com\n' +
    'Install guide: https://servicecycle.com/install.sh\n\n' +
    'Worth a look if your maintenance calendar still lives in a spreadsheet.\n'
  );
  const SHARE_SUBJECT = encodeURIComponent('ServiceCycle — maintenance compliance worth a look');
  const SHARE_MAILTO  = `mailto:?subject=${SHARE_SUBJECT}&body=${SHARE_BODY}`;

  // Items array drives both render + screen-reader order.
  const items = [
    {
      key: 'docs',
      label: 'Documentation',
      sub:   'Setup guide, API reference, runbooks',
      href:  'https://servicecycle.com/docs',
      target: '_blank',
      showIn: 'all',
    },
    // Re-launchable welcome tour. Sets the same servicecycle_welcome_pending
    // key the OnboardingWizard sets on completion, then sends the user
    // to /dashboard where WelcomeTourPanel reads the flag and renders.
    // Useful for: visitors who dismissed the celebration and want it
    // back; users who want a refresher on where the main features live;
    // demo prospects walking a colleague through the product.
    {
      key: 'tour',
      label: 'Show welcome tour',
      sub:   'Re-open the quick-start panel with feature shortcuts',
      onClick: () => {
        setOpen(false);
        try { localStorage.setItem('servicecycle_welcome_pending', '1'); } catch (_) { /* ignore */ }
        navigate('/dashboard');
        // v0.7.0: covers the "user is already on /dashboard" case where the
        // navigate() is a no-op and WelcomeTourPanel wouldn't otherwise see
        // the localStorage change. Safe to fire either way.
        try { window.dispatchEvent(new Event('servicecycle:welcome-trigger')); }
        catch (_) { /* ignore */ }
      },
      showIn: 'all',
    },
    {
      key: 'team',
      label: 'Get ServiceCycle for your team →',
      sub:   'Self-hosted on your own infrastructure',
      href:  'https://servicecycle.com/#early-access',
      target: '_blank',
      showIn: 'demo',  // only meaningful for visitors who don't already have an install
    },
    {
      key: 'share',
      label: 'Share ServiceCycle',
      sub:   'Send a colleague a quick intro',
      href:  SHARE_MAILTO,
      showIn: 'demo',
    },
    {
      key: 'feedback',
      label: 'Send feedback',
      sub:   'Bugs, ideas, anything — Dustin reads every one',
      onClick: () => { setOpen(false); onSendFeedback(); },
      showIn: 'all',
    },
    {
      key: 'support',
      label: 'Contact support',
      sub:   'support@servicecycle.com',
      href:  'mailto:support@servicecycle.com',
      showIn: 'all',
    },
    // ── Legal links — always visible ───────────────────────────────────────
    {
      key: 'terms',
      label: 'Terms of Service',
      sub:   'Use of the service / sandbox',
      href:  '/terms',
      target: '_blank',
      showIn: 'all',
    },
    {
      key: 'privacy',
      label: 'Privacy Policy',
      sub:   'What we collect; what we don’t',
      href:  '/privacy',
      target: '_blank',
      showIn: 'all',
    },
    {
      key: 'eula',
      label: 'EULA',
      sub:   'Self-hosted software licence',
      href:  '/eula',
      target: '_blank',
      showIn: 'all',
    },
    {
      key: 'subp',
      label: 'Sub-processors',
      sub:   'Third parties that may process your data',
      href:  '/sub-processors',
      target: '_blank',
      showIn: 'all',
    },
  ];

  const visibleItems = items.filter(i => i.showIn === 'all' || (i.showIn === 'demo' && demoMode));

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        style={{
          width: '100%', textAlign: 'left',
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '5px 10px', borderRadius: 'var(--radius)',
          background: open ? 'var(--color-sidebar-hover)' : 'none',
          border: 'none', cursor: 'pointer',
          fontSize: 'var(--font-size-sm)', color: open ? 'var(--color-sidebar-label)' : 'var(--color-sidebar-text)',
          transition: 'background 0.1s, color 0.1s',
          lineHeight: 1.4,
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-sidebar-hover)'; e.currentTarget.style.color = 'var(--color-sidebar-label)'; }}
        onMouseLeave={e => { if (!open) { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--color-sidebar-text)'; } }}
        title="Resources and feedback"
      >
        {/* Explicit width/height — the .nav-icon CSS rule only applies inside
            a .nav-item parent, so without these the SVG renders at its default
            (much larger) intrinsic size and visually overpowers the headings
            above. (sized 2026-05-08) */}
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"
             style={{ width: 14, height: 14, flexShrink: 0 }}>
          <circle cx="8" cy="8" r="6.5"/>
          <path d="M6 6a2 2 0 0 1 4 0c0 1.2-2 1.6-2 3"/>
          <circle cx="8" cy="11.5" r="0.5" fill="currentColor"/>
        </svg>
        Resources &amp; Feedback
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
             style={{ marginLeft: 'auto', width: 9, height: 9, transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)', flexShrink: 0 }}>
          <path d="M3 6l5 4 5-4"/>
        </svg>
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Resources and feedback"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 4px)', left: 0, right: 0,
            background: 'var(--color-bg, #fff)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-lg, 8px)',
            boxShadow: '0 4px 18px rgba(0,0,0,0.12)',
            padding: 4,
            zIndex: 50,
            // maxHeight is set dynamically via useLayoutEffect to the actual
            // space available above the button, preventing items from being
            // clipped above the viewport (e.g. when the demo banner is visible).
            overflowY: 'auto',
          }}
        >
          {visibleItems.map(item => {
            const inner = (
              <div style={{ padding: '8px 10px' }}>
                <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text)', fontWeight: 500 }}>{item.label}</div>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>{item.sub}</div>
              </div>
            );
            const commonStyle = {
              display: 'block', borderRadius: 'var(--radius, 4px)',
              textDecoration: 'none', color: 'inherit', cursor: 'pointer',
            };
            if (item.onClick) {
              return (
                <button
                  key={item.key} role="menuitem" type="button"
                  onClick={item.onClick}
                  style={{ ...commonStyle, width: '100%', textAlign: 'left', background: 'none', border: 'none' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--color-surface)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  {inner}
                </button>
              );
            }
            return (
              <a
                key={item.key} role="menuitem"
                href={item.href}
                target={item.target} rel={item.target === '_blank' ? 'noopener noreferrer' : undefined}
                onClick={() => setOpen(false)}
                style={commonStyle}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--color-surface)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                {inner}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function Sidebar() {
  const { user, logout, features, demoMode } = useAuth();
  const navigate = useNavigate();
  const sidebarLocation = useLocation();
  const [showFeedback, setShowFeedback] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-logo" style={{ textAlign: 'center' }}>
        <div className="sidebar-logo-mark" style={{ justifyContent: 'center' }}>
          <svg width="36" height="20" viewBox="0 0 44 24" aria-hidden="true" style={{ flexShrink: 0 }}>
            <rect x="2" y="9" width="36" height="6" rx="3" fill="#0d4f6e"/>
            <rect x="26" y="3" width="3" height="18" rx="1.5" fill="#10b981" className="lapseiq-tick"/>
          </svg>
          <span className="sidebar-logo-text">servicecycle</span>
        </div>
        <div className="sidebar-logo-sub">{user?.account?.companyName || localStorage.getItem('servicecycle_company') || 'Maintenance Compliance'}</div>
      </div>

      {user?.role === 'consultant' && <ConsultantBanner />}
      {user?.role === 'viewer' && <ViewerBanner />}
      <GlobalSearch />

      <nav className="sidebar-nav">
        <div className="nav-section-label">Workspace</div>
        {/* v0.37.1 W5 MT-117: no .nav-item-row wrappers except the quick-add
            row — restores the full-width active background paint that
            Pass-3 MUST-FIX D1 flagged. */}
        <NavLink
          to="/dashboard"
          className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
        >
          {Icons.dashboard}
          Dashboard
        </NavLink>

        {/* Assets + quick-add button. This row keeps the .nav-item-row
            wrapper because of the inline `+` quick-add button — without
            the wrapper the button would be a sibling of the NavLink, not
            visually grouped with it. */}
        <div className="nav-item-row" style={{ display: 'flex', alignItems: 'center' }}>
          <NavLink
            to="/assets"
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            style={{ flex: 1 }}
            onClick={(e) => {
              e.preventDefault();
              // v0.53.1: if user is already on /assets and there are any
              // filters in the URL, signal AssetsList to clear them. Using
              // Date.now() as the state value guarantees a fresh reference on
              // every click so the consuming effect re-fires.
              const onAssets = sidebarLocation.pathname === '/assets';
              const hasQuery = (sidebarLocation.search || '').length > 1;
              if (onAssets && hasQuery) {
                navigate('/assets', { replace: true, state: { clearFilters: Date.now() } });
              } else {
                navigate('/assets');
              }
            }}
          >
            {Icons.assets}
            Assets
          </NavLink>
          {features.assets_write && (
            <button
              onClick={() => navigate('/assets/new')}
              title="Add asset"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '4px 8px 4px 2px', color: 'var(--color-text-secondary)',
                display: 'flex', alignItems: 'center', flexShrink: 0, borderRadius: 4,
                transition: 'color 0.1s',
              }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--color-primary)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--color-text-secondary)'}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"
                style={{ width: 14, height: 14 }}>
                <line x1="8" y1="2" x2="8" y2="14"/>
                <line x1="2" y1="8" x2="14" y2="8"/>
              </svg>
            </button>
          )}
        </div>

        <NavLink
          to="/assets/archived"
          className={({ isActive }) => `nav-item nav-item-sub${isActive ? ' active' : ''}`}
          style={{ fontSize: '0.82rem', paddingLeft: 28 }}
        >
          {Icons.archive}
          Archive
        </NavLink>

        <NavLink
          to="/sites"
          className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
        >
          {Icons.sites}
          Sites
        </NavLink>

        <NavLink
          to="/work-orders"
          className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
        >
          {Icons.workOrders}
          Work Orders
        </NavLink>

        <NavLink
          to="/calendar"
          className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
        >
          {Icons.calendar}
          Compliance Calendar
        </NavLink>

        {/* Audit visits + REC tracking — admin/manager only, matching the
            /audits RequireRole gate in App.jsx. */}
        {(user?.role === 'admin' || user?.role === 'manager') && (
          <NavLink
            to="/audits"
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            {Icons.audits}
            Audits
          </NavLink>
        )}

        <NavLink
          to="/contractors"
          className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
        >
          {Icons.contractors}
          Contractors
        </NavLink>

        {features.alerts && (
          <NavLink
            to="/alerts"
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            {Icons.alerts}
            Alerts
          </NavLink>
        )}

        {/* Reports hub — manager / admin only. Top-level nav item; links to
            /reports which shows the hub card grid. */}
        {(user?.role === 'admin' || user?.role === 'manager') && (
          <NavLink
            to="/reports"
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            {Icons.reports}
            Reports
          </NavLink>
        )}

        <button
          type="button"
          onClick={() => {
            try {
              window.dispatchEvent(new CustomEvent('servicecycle:open-help', { detail: { moduleSlug: null } }));
            } catch (_) { /* ignore */ }
          }}
          className="nav-item"
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            textAlign: 'left', font: 'inherit',
            width: '100%', padding: undefined,
          }}
          title="Help for this screen"
        >
          <svg className="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="6.5"/>
            <path d="M6 6.2a2 2 0 0 1 4 0c0 1.2-2 1.5-2 3"/>
            <circle cx="8" cy="11.6" r="0.7" fill="currentColor"/>
          </svg>
          Help
        </button>

        {(user?.role === 'admin' || user?.role === 'manager') && (
          <>
            {/* 2026-05-10 v0.2.30 (role-tier walk N2): label this section
                contextually. Admin sees Activity Log + Settings (+ Early-
                access leads on non-demo) → "Admin" reads right. Manager only
                sees Activity Log under here, so calling it "Admin" was a
                mislabel; "Audit" matches the actual content (Activity Log is
                an audit/observability trail, not an admin-config item). */}
            <div className="nav-section-label" style={{ marginTop: 16 }}>
              {user?.role === 'admin' ? 'Admin' : 'Audit'}
            </div>
            {/* Team Members and Permissions used to live here; per UX review
                2026-05-01 they were folded under Settings → Users & Roles
                so role management has one canonical home. The /users and
                /permissions routes still work for bookmarks. */}
            <NavLink
              to="/activity"
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <svg className="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M1 8h3l2-5 3 10 2-5h4"/>
              </svg>
              Activity Log
            </NavLink>
            {user?.role === 'admin' && (
              <>
                {/* L7: lead-form submissions inbox.
                    2026-05-10 review B1 fix: hide on DEMO_MODE. Every sandbox
                    user is auto-provisioned with role='admin', so showing
                    this link on demo would expose real production leads to
                    anyone who registered. Real ops admins see leads on the
                    non-DEMO_MODE deployment (the same one that fronts the
                    marketing form). */}
                {!demoMode && (
                  <NavLink
                    to="/admin/early-access"
                    className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                  >
                    <svg className="nav-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M2 4l6 4 6-4"/>
                      <rect x="2" y="3" width="12" height="10" rx="1.5"/>
                    </svg>
                    Early-access leads
                  </NavLink>
                )}
                <NavLink
                  to="/settings"
                  className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                >
                  {Icons.settings}
                  Settings
                </NavLink>
              </>
            )}
          </>
        )}
      </nav>

      {/* L9: Help & Share menu — contains all the outbound + meta actions
          (docs, share, feedback, support, "get this for your team") so
          visitors aren't hunting across the chrome for the right outlet. */}
      <div style={{ padding: '8px 10px 4px', borderTop: '1px solid var(--color-border)', marginTop: 'auto' }}>
        <HelpShareMenu
          demoMode={demoMode}
          onSendFeedback={() => setShowFeedback(true)}
        />
        {/* v0.7.0: dark/light theme toggle. Sits right under Help & Share so
            the chrome's two "meta" actions live together in the footer. */}
        <ThemeToggle />
      </div>

      {/* v0.37.2 W6 MT-135: Suspense fallback is null because the modal is
          an on-demand surface — the user clicked something to open it, so a
          brief blank during the chunk fetch (typically <100ms warm) is fine.
          The conditional `&&` guard means we don't even mount the Suspense
          boundary until the user has triggered the modal. */}
      {showFeedback && (
        <Suspense fallback={null}>
          <FeedbackModal onClose={() => setShowFeedback(false)} />
        </Suspense>
      )}

      <div className="sidebar-footer">
        {/* Audit Cluster B P0: pre-fix this was a <div onClick> — no
            keyboard reach, no role, only mouse-clickable. The user chip
            is split: the profile portion is a <button>, NotificationBell
            sits outside it as its own focusable. */}
        <div className="sidebar-user" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            onClick={() => navigate('/profile')}
            className="sidebar-user-button"
            title="Edit profile"
            style={{ all: 'unset', display: 'flex', flex: 1, minWidth: 0, alignItems: 'center', gap: 8, cursor: 'pointer' }}
          >
            <div className="sidebar-user-avatar">{getInitials(user?.name)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="sidebar-user-name">{user?.name}</div>
              <div className="sidebar-user-role">{user?.role}</div>
            </div>
          </button>
          <NotificationBell />
        </div>
        <button className="logout-btn" onClick={handleLogout}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
