// ─────────────────────────────────────────────────────────────────────────────
// FailedSyncBanner.jsx — COMP-8-5 surface for offline mutations the server
// REJECTED on sync.
//
// The offline outbox replays queued field writes; a 4xx/5xx response means the
// server actively rejected the change (e.g. the asset was archived, or a
// validation rule fired) and it is moved to a "failed" store and NOT retried.
// Before this banner that store was rendered nowhere — the tech saw "Saved" and
// the compliance reading silently vanished. This banner makes those rejections
// visible on every field page with three actions: view the details, retry
// (re-queue + re-flush, for transient causes), and dismiss (after the tech has
// re-entered the data manually). Renders null when there is nothing to show.
//
// Global state via useOutboxStatus(); the list is pulled lazily on expand.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useOutboxStatus, getFailedMutations, retryFailedMutations, clearFailedMutations } from '../../lib/fieldApi';

export default function FailedSyncBanner() {
  const { failed } = useOutboxStatus();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  if (!failed || failed <= 0) {
    // Nothing rejected — but if a retry just cleared the list, briefly confirm.
    if (note) {
      return (
        <div role="status" aria-live="polite" style={okStyle}>{note}</div>
      );
    }
    return null;
  }

  async function expand() {
    setOpen((o) => !o);
    if (!open && items === null) {
      try { setItems(await getFailedMutations()); } catch (_e) { setItems([]); }
    }
  }

  async function onRetry() {
    setBusy(true); setNote(null);
    try {
      const res = await retryFailedMutations();
      setItems(null);
      setOpen(false);
      if (res && res.failed > 0) {
        setNote(`${res.sent || 0} synced, ${res.failed} still rejected — review and fix.`);
      } else if (res && res.sent > 0) {
        setNote(`Synced ${res.sent} previously-rejected change${res.sent === 1 ? '' : 's'}.`);
        setTimeout(() => setNote(null), 5000);
      } else {
        // Offline again, or nothing went through — leave the banner up.
        setNote(null);
      }
    } catch (_e) {
      setNote('Retry failed — check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function onDismiss() {
    setBusy(true);
    try {
      await clearFailedMutations();
      setItems(null);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="alert" style={wrapStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 800 }} aria-hidden="true">⚠</span>
        <span style={{ flex: 1, fontWeight: 700, fontSize: 13.5 }}>
          {failed} offline change{failed === 1 ? '' : 's'} {failed === 1 ? 'was' : 'were'} rejected on sync and not saved.
        </span>
      </div>
      <div style={{ fontSize: 12.5, marginTop: 4, color: '#7f1d1d' }}>
        These were NOT recorded. Review them, retry, or re-enter the data manually — don’t certify on data that wasn’t saved.
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button type="button" onClick={expand} disabled={busy} style={btnGhost}>
          {open ? 'Hide details' : 'View details'}
        </button>
        <button type="button" onClick={onRetry} disabled={busy} style={btnPrimary}>
          {busy ? 'Working…' : 'Retry now'}
        </button>
        <button type="button" onClick={onDismiss} disabled={busy} style={btnGhost}>
          Dismiss
        </button>
      </div>

      {open && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0' }}>
          {(items || []).map((it, i) => (
            <li key={it.id ?? i} style={itemStyle}>
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>
                {it.meta?.label || `${it.method} ${it.url}`}
              </div>
              <div style={{ fontSize: 11.5, color: '#7f1d1d' }}>
                Rejected{it.status ? ` (HTTP ${it.status})` : ''}
                {it.serverError ? ` — ${it.serverError}` : ''}
                {it.failedAt ? ` · ${new Date(it.failedAt).toLocaleString()}` : ''}
              </div>
            </li>
          ))}
          {items && items.length === 0 && (
            <li style={{ fontSize: 12, color: '#7f1d1d' }}>No details available.</li>
          )}
        </ul>
      )}
    </div>
  );
}

const wrapStyle = {
  border: '1px solid #fca5a5', background: '#fef2f2', borderRadius: 10,
  padding: '12px 14px', marginBottom: 14, color: '#991b1b',
};
const okStyle = {
  border: '1px solid #86efac', background: '#f0fdf4', borderRadius: 10,
  padding: '10px 14px', marginBottom: 14, color: '#166534', fontWeight: 700, fontSize: 13,
};
const itemStyle = {
  borderTop: '1px solid #fecaca', padding: '8px 0 0', marginTop: 8,
};
const btnPrimary = {
  padding: '8px 14px', borderRadius: 8, border: 'none', background: '#b91c1c',
  color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer', minHeight: 40,
};
const btnGhost = {
  padding: '8px 14px', borderRadius: 8, border: '1px solid #fca5a5', background: '#fff',
  color: '#991b1b', fontWeight: 700, fontSize: 13, cursor: 'pointer', minHeight: 40,
};
