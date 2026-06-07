// fieldApi.js — offline-tolerant request wrapper for the Field pages.
//
// Mutations (POST/PUT/PATCH/DELETE) go through fieldMutate(): try the network
// when we believe we're online; on network failure (or known-offline) the
// request is persisted to the IndexedDB outbox (src/lib/outbox.js) and
// replayed automatically when connectivity returns. GETs are NOT handled
// here — the service worker's NetworkFirst runtime cache covers reads.

import { useEffect, useState } from 'react';
import api from '../api/client';
import { enqueue, flush, subscribe, installAutoFlush } from './outbox';

// Wire auto-flush exactly once at module load: replay on 'online' + app start.
installAutoFlush(api);

/**
 * Run a field mutation with offline fallback.
 * @param {{ method: string, url: string, body?: object|FormData, meta?: { label?: string, assetId?: string|number } }} req
 * @returns {Promise<{ queued: true } | import('axios').AxiosResponse>}
 *   - online + server reached: the axios response (caller handles errors via throw)
 *   - offline / network failure: `{ queued: true }` after the mutation is
 *     safely persisted to the outbox. Callers should treat this as a
 *     provisional success ("saved, will sync").
 * @throws axios error when the server responds with 4xx/5xx while online —
 *   a server rejection is a real error the form should show, not queue.
 */
export async function fieldMutate({ method, url, body, meta }) {
  const m = String(method || 'POST').toUpperCase();
  if (m === 'GET') {
    // GETs pass straight through (SW runtime cache handles offline reads).
    return api.request({ method: m, url });
  }
  if (navigator.onLine) {
    try {
      return await api.request({ method: m, url, data: body });
    } catch (err) {
      // Only queue on NETWORK failure (no response). A 4xx/5xx means the
      // server saw and rejected the request — rethrow so the form surfaces it.
      if (err.response) throw err;
    }
  }
  await enqueue({ method: m, url, body, meta });
  return { queued: true };
}

/** Manually trigger an outbox replay (e.g. a "Sync now" button). */
export function flushOutbox() {
  return flush(api);
}

/**
 * React hook: live outbox status.
 * @returns {{ pending: number, flushing: boolean, lastFlush: { sent, failed, at } | null }}
 */
export function useOutboxStatus() {
  const [status, setStatus] = useState({ pending: 0, flushing: false, lastFlush: null });
  useEffect(() => subscribe(setStatus), []);
  return status;
}
