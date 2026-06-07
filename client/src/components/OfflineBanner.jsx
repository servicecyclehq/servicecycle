import { useEffect, useRef, useState } from 'react';
import { useOutboxStatus } from '../lib/fieldApi';

// OfflineBanner — slim fixed banner for the PWA offline mutation outbox.
//
// Two states:
//   1. Offline: persistent banner "Working offline — N changes queued"
//      (count from src/lib/outbox.js via useOutboxStatus).
//   2. Just-synced: when a flush completes with sent > 0, a transient
//      "Synced N queued changes" confirmation that auto-hides after 4s.
//
// Mounted once in Layout.jsx so every authenticated page gets it. Field
// pages don't need to wire anything — they just call fieldMutate().
export default function OfflineBanner() {
  const { pending, lastFlush } = useOutboxStatus();
  const [offline, setOffline] = useState(typeof navigator !== 'undefined' ? !navigator.onLine : false);
  const [syncedMsg, setSyncedMsg] = useState(null);
  const lastFlushAtRef = useRef(null);

  // Track connectivity via the browser events (same signal outbox auto-flush
  // uses, so banner state and replay behavior stay in step).
  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  // Surface a transient confirmation when a flush completes with successes.
  useEffect(() => {
    if (!lastFlush || lastFlush.at === lastFlushAtRef.current) return;
    lastFlushAtRef.current = lastFlush.at;
    if (lastFlush.sent > 0) {
      setSyncedMsg(`Synced ${lastFlush.sent} queued change${lastFlush.sent === 1 ? '' : 's'}`);
      const t = setTimeout(() => setSyncedMsg(null), 4000);
      return () => clearTimeout(t);
    }
  }, [lastFlush]);

  if (!offline && !syncedMsg) return null;

  const barStyle = {
    position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000,
    padding: '6px 16px', textAlign: 'center',
    fontSize: 'var(--font-size-ui, 13px)', fontWeight: 600,
    color: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.25)',
  };

  if (offline) {
    return (
      <div role="status" aria-live="polite" aria-atomic="true"
        style={{ ...barStyle, background: '#92400e' }}>
        Working offline
        {pending > 0 ? ` — ${pending} change${pending === 1 ? '' : 's'} queued` : ''}
      </div>
    );
  }

  return (
    <div role="status" aria-live="polite" aria-atomic="true"
      style={{ ...barStyle, background: '#166534' }}>
      {syncedMsg}
    </div>
  );
}
