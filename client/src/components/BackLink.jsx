// ─────────────────────────────────────────────────────────────────────────────
// BackLink.jsx — platform-wide "go back to where I actually came from" (C1,
// 2026-06-11 punch list). Detail/leaf pages render <BackLink> instead of a
// hardcoded <Link to="/parent">; origin pages opt in by passing
// state={useFromState()} (or navigate(to, { state: useFromState() })) on the
// links that lead INTO a detail page.
//
// Resolution order:
//   1. location.state.from — the origin page recorded its own pathname+search.
//      Renders a real <Link> (href, ctrl/middle-click work) and survives
//      refresh, because react-router persists location.state in history.state.
//   2. In-app history — location.key !== 'default' means this entry was pushed
//      during this SPA session, so navigate(-1) is guaranteed to stay in-app.
//      Renders a button labeled "Back".
//   3. Fallback — deep links / new tabs land on the page's natural parent.
//
// The arrow is a lucide icon, never a raw glyph byte (encoding rule — see
// ReportBackLink).
// ─────────────────────────────────────────────────────────────────────────────

import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

// Friendly names for in-app origins so case 1 can say where it goes. Order
// matters: more specific prefixes first.
const PATH_LABELS = [
  ['/dashboard',           'Dashboard'],
  ['/assets/archived',     'Archived assets'],
  ['/assets',              'Assets'],
  ['/sites',               'Sites'],
  ['/contractors',         'Contractors'],
  ['/work-orders',         'Work orders'],
  ['/deficiencies',        'Deficiencies'],
  ['/calendar',            'Calendar'],
  ['/outage-planner',      'Outage planner'],
  ['/audits',              'Audits'],
  ['/reports/compliance',  'Compliance by Standard'],
  ['/reports',             'Reports'],
  ['/fleet',               'Fleet'],
  ['/alerts',              'Alerts'],
  ['/disaster-response',   'Disaster response'],
  ['/equipment-templates', 'Templates'],
  ['/activity',            'Activity log'],
  ['/settings',            'Settings'],
];

export function labelForPath(path) {
  if (typeof path !== 'string') return null;
  const clean = (path.split('?')[0] || '').replace(/\/+$/, '') || '/';
  const hit = PATH_LABELS.find(([p]) => clean === p || clean.startsWith(`${p}/`));
  return hit ? hit[1] : null;
}

// Spread into <Link state={...}> (or navigate(to, { state: ... })) when
// linking into a detail page — the detail page's BackLink then returns here,
// including any active query-string filters.
export function useFromState(label) {
  const location = useLocation();
  const from = location.pathname + location.search;
  return label ? { from, fromLabel: label } : { from };
}

export function useBackLink(fallbackPath = '/dashboard', fallbackLabel = 'Dashboard') {
  const location = useLocation();
  const navigate = useNavigate();

  const here = location.pathname + location.search;
  const from = typeof location.state?.from === 'string' ? location.state.from : null;
  if (from && from !== here) {
    return {
      to: from,
      label: (typeof location.state?.fromLabel === 'string' && location.state.fromLabel)
        || labelForPath(from) || 'Back',
      isHistory: false,
    };
  }

  // No recorded origin, but this entry was pushed in-session → real history.
  if (location.key && location.key !== 'default') {
    return { to: null, label: 'Back', isHistory: true, goBack: () => navigate(-1) };
  }

  return { to: fallbackPath, label: fallbackLabel, isHistory: false };
}

export default function BackLink({
  fallback = '/dashboard',
  fallbackLabel = 'Dashboard',
  className = 'back-link',
  style,
}) {
  const { to, label, isHistory, goBack } = useBackLink(fallback, fallbackLabel);
  const content = (
    <>
      <ArrowLeft size={13} strokeWidth={2.25} aria-hidden="true" /> {label}
    </>
  );
  if (isHistory) {
    // Plain (.back-link) usages need the UA button chrome stripped; `btn`
    // class usages keep their own button styling.
    const isPlain = !className || className.includes('back-link');
    return (
      <button
        type="button"
        onClick={goBack}
        className={className}
        style={{
          ...(isPlain
            ? { background: 'none', border: 'none', padding: 0, font: 'inherit' }
            : null),
          cursor: 'pointer',
          ...style,
        }}
      >
        {content}
      </button>
    );
  }
  return <Link to={to} className={className} style={style}>{content}</Link>;
}
