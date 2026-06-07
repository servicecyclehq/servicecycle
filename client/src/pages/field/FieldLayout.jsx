// ─────────────────────────────────────────────────────────────────────────────
// FieldLayout.jsx — minimal chrome wrapper for /field/* (Field Mode).
//
// Phone-first: NO sidebar, just a slim sticky top bar (wordmark, user initial,
// exit-to-full-site link), the routed page in a single centered column, and
// bottom safe-area padding so action buttons clear iOS home indicators.
// OfflineBanner is mounted here (Layout.jsx mounts it for the desktop shell;
// field pages live outside Layout so they need their own).
// ─────────────────────────────────────────────────────────────────────────────

import { Link, Outlet } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import OfflineBanner from '../../components/OfflineBanner';

function getInitial(name = '') {
  const t = String(name).trim();
  return t ? t[0].toUpperCase() : '?';
}

export default function FieldLayout() {
  const { user } = useAuth();

  return (
    <div style={{ minHeight: '100vh', background: 'var(--color-bg)', display: 'flex', flexDirection: 'column' }}>
      <OfflineBanner />

      <header
        style={{
          position: 'sticky', top: 0, zIndex: 30,
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px',
          background: 'var(--color-surface)',
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <Link
          to="/field"
          style={{ textDecoration: 'none', display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}
          aria-label="Field Mode home"
        >
          <span style={{ fontWeight: 800, fontSize: 16, color: 'var(--color-text)', letterSpacing: '-0.01em' }}>
            servicecycle
          </span>
          <span
            style={{
              fontSize: 10, fontWeight: 800, letterSpacing: '0.08em',
              color: 'var(--color-primary)', border: '1px solid var(--color-primary)',
              borderRadius: 4, padding: '1px 5px',
            }}
          >
            FIELD
          </span>
        </Link>

        <div style={{ flex: 1 }} />

        <Link
          to="/dashboard"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            minHeight: 40, padding: '0 12px',
            fontSize: 'var(--font-size-ui)', fontWeight: 600,
            color: 'var(--color-primary)', textDecoration: 'none',
            border: '1px solid var(--color-border)', borderRadius: 'var(--radius)',
            background: 'var(--color-bg)',
          }}
        >
          Full site →
        </Link>

        <div
          aria-hidden="true"
          title={user?.name || ''}
          style={{
            width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--color-primary-light, var(--color-bg))',
            color: 'var(--color-primary)', fontWeight: 800, fontSize: 14,
            border: '1px solid var(--color-border)',
          }}
        >
          {getInitial(user?.name)}
        </div>
      </header>

      <main
        style={{
          flex: 1, width: '100%', maxWidth: 560, margin: '0 auto', boxSizing: 'border-box',
          padding: '14px 14px calc(32px + env(safe-area-inset-bottom, 0px))',
        }}
      >
        <Outlet />
      </main>
    </div>
  );
}
