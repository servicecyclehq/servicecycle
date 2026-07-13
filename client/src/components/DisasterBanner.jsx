// ─────────────────────────────────────────────────────────────────────────────
// DisasterBanner.jsx — sticky top banner for active disaster events.
//
// Shown in the Layout when GET /api/disaster-events returns at least one
// active (unresolved) event affecting this account's sites. Dismissible for
// the current session (not persisted — reappears on next load if still active).
//
// The banner links to /disaster-response where the customer can read event
// details and click "Declare Emergency" to join the priority service queue.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, X } from 'lucide-react';
import api from '../api/client';

const SEV_STYLES = {
  emergency: { bg: 'var(--chip-red-bg)', border: '#ef4444', color: 'var(--chip-red-fg)', label: 'EMERGENCY' },
  warning:   { bg: 'var(--chip-amber-bg)', border: '#f59e0b', color: 'var(--chip-amber-fg)', label: 'WARNING' },
  watch:     { bg: 'var(--chip-orange-bg)', border: '#f97316', color: 'var(--chip-orange-fg)', label: 'WATCH' },
};

export default function DisasterBanner() {
  const navigate = useNavigate();
  const [events, setEvents]       = useState([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get('/api/disaster-events')
      .then(r => {
        if (cancelled) return;
        setEvents(r.data?.data?.events || []);
      })
      .catch(() => {}); // silent — banner is non-critical
    return () => { cancelled = true; };
  }, []);

  if (!events.length || dismissed) return null;

  // Show the most severe active event in the banner.
  const top = events[0];
  const sty = SEV_STYLES[top.severity] || SEV_STYLES.warning;

  return (
    <div
      role="alert"
      style={{
        position: 'sticky', top: 0, zIndex: 200,
        background: sty.bg,
        borderBottom: `2px solid ${sty.border}`,
        padding: '10px 20px',
        display: 'flex', alignItems: 'center', gap: 10,
        fontSize: 'var(--font-size-sm)',
      }}
    >
      <AlertTriangle
        size={16} strokeWidth={2}
        style={{ color: sty.color, flexShrink: 0 }}
      />
      <span style={{ color: sty.color, fontWeight: 700, whiteSpace: 'nowrap' }}>
        {sty.label}:
      </span>
      <span style={{ color: 'var(--color-text)', flex: 1 }}>
        {top.title}
        {events.length > 1 && (
          <span style={{ color: 'var(--color-text-secondary)', marginLeft: 8 }}>
            (+{events.length - 1} more {events.length === 2 ? 'event' : 'events'})
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={() => navigate('/disaster-response')}
        style={{
          /* v0.95 alarm budget: outline treatment -- the banner already carries
             the severity color; a solid block here outranked page content. */
          padding: '4px 14px', borderRadius: 6, cursor: 'pointer',
          background: 'transparent', color: sty.color,
          border: `1px solid ${sty.color}`, fontWeight: 600,
          fontSize: 'var(--font-size-xs)', whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        View &amp; Declare Emergency
      </button>
      <button
        type="button"
        aria-label="Dismiss weather banner"
        onClick={() => setDismissed(true)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: sty.color, padding: 2, lineHeight: 1, flexShrink: 0,
        }}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
