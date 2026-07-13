// ─────────────────────────────────────────────────────────────────────────────
// useDisasterEvents.js — shared fetch + severity-label mapping for active
// disaster events (GET /api/disaster-events).
//
// Dashboard cleanup pass (2026-07-13): DisasterBanner.jsx (global sticky
// banner, mounted in Layout.jsx) and InstrumentBand.jsx (dashboard-only
// docked line that replaces the banner on /dashboard) each independently
// fetched this endpoint and duplicated the "most severe event first" pick
// plus the severity -> display-label mapping. This hook is now the single
// source for the fetch and those two derived bits.
//
// Dismiss state is intentionally NOT included here — each surface dismisses
// independently (dismissing the dashboard's docked instrument-band line
// must not also hide the global sticky banner on other pages, and vice
// versa), so callers keep their own local `dismissed` useState exactly as
// they did before this hook existed.
//
// Usage:
//   const { topEvent, events, loading, error } = useDisasterEvents();
//   const label = severityLabel(topEvent?.severity); // 'EMERGENCY' | 'WARNING' | 'WATCH'
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import api from '../api/client';

// Shared severity -> display-label mapping (previously duplicated as
// SEV_LABEL in InstrumentBand.jsx and folded into SEV_STYLES.label in
// DisasterBanner.jsx). Unknown/missing severity defaults to 'WARNING' —
// the same fallback both components used before this hook existed.
const SEVERITY_LABELS = { emergency: 'EMERGENCY', warning: 'WARNING', watch: 'WATCH' };

export function severityLabel(severity) {
  return SEVERITY_LABELS[severity] || 'WARNING';
}

export function useDisasterEvents() {
  const [events, setEvents]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let on = true;
    api.get('/api/disaster-events')
      .then(r => {
        if (!on) return;
        setEvents(r.data?.data?.events || []);
        setError(null);
      })
      .catch(() => {
        if (on) setError('Could not load disaster events');
      })
      .finally(() => {
        if (on) setLoading(false);
      });
    return () => { on = false; };
  }, []);

  return { events, topEvent: events[0] || null, loading, error };
}

export default useDisasterEvents;
