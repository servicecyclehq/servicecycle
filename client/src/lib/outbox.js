// outbox.js — IndexedDB-backed offline mutation queue for the Field pages.
//
// Why IndexedDB (raw, no deps): localStorage can't hold Blobs (photo uploads)
// and the queue must survive page reloads / app restarts on a phone in a
// plant basement. The API surface is intentionally tiny:
//
//   enqueue({ method, url, body, meta })  -> Promise<id>
//   pendingCount()                        -> Promise<number>
//   failedCount()                         -> Promise<number>
//   failedEntries()                       -> Promise<Array>
//   retryFailed(api)                      -> Promise<flush result>  (re-queues failed, re-flushes)
//   clearFailed(ids?)                     -> Promise<void>          (dismiss after the tech has acted)
//   subscribe(cb)                         -> unsubscribe fn; cb({ pending, failed, flushing, lastFlush })
//   flush(api)                            -> Promise<{ sent, failed, remaining }>
//
// Replay semantics (flush):
//   FIFO. Per entry: 2xx -> remove; network error (no response) -> KEEP the
//   entry and STOP the flush (we're offline/flaky — order must be preserved);
//   4xx/5xx response -> server actively rejected it: DROP from the queue and
//   record to the 'failed' store. COMP-8-5: the failed store is now SURFACED
//   (failedCount in the subscribe snapshot + a needs-attention banner in the
//   field UI with view/retry/dismiss) so a rejected compliance write is never
//   silently lost — the tech who saw "Saved" gets told it didn't stick.
//   (Retrying forever would wedge the queue behind a permanently-bad request,
//   so we still don't auto-retry — a human decides.)
//
// Photos: pass `body: { _formData: [...] }`? No — callers pass a plain object
// OR a FormData. FormData can't be structured-cloned into IndexedDB, so we
// decompose it into [{ name, value }] pairs (File/Blob values clone fine) and
// rebuild a fresh FormData at replay time.

const DB_NAME = 'servicecycle-outbox';
const DB_VERSION = 1;
const QUEUE = 'queue';   // pending mutations, keyPath 'id' (autoIncrement = FIFO order)
const FAILED = 'failed'; // server-rejected mutations kept for surfacing/debugging

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(QUEUE)) {
        db.createObjectStore(QUEUE, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(FAILED)) {
        db.createObjectStore(FAILED, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { _dbPromise = null; reject(req.error); };
  });
  return _dbPromise;
}

// Small promise wrapper around an IDB request.
function idb(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// --- subscriptions ----------------------------------------------------------

const _subscribers = new Set();
let _flushing = false;
let _lastFlush = null; // { sent, failed, at } of the most recent completed flush

async function _notify() {
  let pending = 0;
  let failed = 0;
  try { pending = await pendingCount(); } catch (_) { /* IDB unavailable */ }
  // COMP-8-5: failed-store size rides the snapshot so subscribers can show a
  // persistent "needs attention" state for server-rejected mutations.
  try { failed = await failedCount(); } catch (_) { /* IDB unavailable */ }
  const snapshot = { pending, failed, flushing: _flushing, lastFlush: _lastFlush };
  for (const cb of _subscribers) {
    try { cb(snapshot); } catch (_) { /* subscriber error must not break the queue */ }
  }
}

/**
 * Subscribe to outbox state. cb is called immediately with the current state
 * and again on every change: { pending: number, failed: number,
 * flushing: boolean, lastFlush: { sent, failed, at } | null }. Returns an
 * unsubscribe function.
 */
export function subscribe(cb) {
  _subscribers.add(cb);
  _notify(); // fire-and-forget initial snapshot
  return () => _subscribers.delete(cb);
}

// --- core API ----------------------------------------------------------------

/**
 * Queue a mutation for later replay.
 * @param {{ method: string, url: string, body?: object|FormData, meta?: { label?: string, assetId?: string|number } }} req
 * @returns {Promise<number>} the queue entry id
 */
export async function enqueue({ method, url, body, meta }) {
  const entry = {
    method: String(method || 'POST').toUpperCase(),
    url,
    meta: meta || {},
    queuedAt: Date.now(),
  };
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    // FormData isn't structured-cloneable; store the parts. File/Blob values
    // ARE cloneable, so photos persist intact across reloads.
    entry.bodyKind = 'formdata';
    entry.formParts = [];
    for (const [name, value] of body.entries()) entry.formParts.push({ name, value });
  } else {
    entry.bodyKind = 'json';
    entry.body = body ?? null;
  }
  const db = await openDb();
  const id = await idb(db.transaction(QUEUE, 'readwrite').objectStore(QUEUE).add(entry));
  _notify();
  return id;
}

/** Number of mutations waiting to be replayed. */
export async function pendingCount() {
  const db = await openDb();
  return idb(db.transaction(QUEUE, 'readonly').objectStore(QUEUE).count());
}

/** Server-rejected (4xx/5xx) entries kept for surfacing. */
export async function failedEntries() {
  const db = await openDb();
  return idb(db.transaction(FAILED, 'readonly').objectStore(FAILED).getAll());
}

/** Number of server-rejected mutations awaiting the tech's attention. */
export async function failedCount() {
  const db = await openDb();
  return idb(db.transaction(FAILED, 'readonly').objectStore(FAILED).count());
}

/**
 * Move every failed entry back onto the live queue and re-flush — for when the
 * cause was transient (asset un-archived, a fixed server bug, etc.). The
 * re-queued entries lose their original FIFO position (they go to the tail),
 * which is fine: a rejected entry was already removed from the ordered stream.
 * @returns {Promise<{ sent, failed, remaining }>} the resulting flush summary
 */
export async function retryFailed(api) {
  const db = await openDb();
  const failures = await idb(db.transaction(FAILED, 'readonly').objectStore(FAILED).getAll());
  for (const f of failures) {
    // Strip the failure metadata; restore the original mutation shape.
    const { id, status, serverError, failedAt, ...orig } = f;
    orig.queuedAt = Date.now();
    await idb(db.transaction(QUEUE, 'readwrite').objectStore(QUEUE).add(orig));
    await idb(db.transaction(FAILED, 'readwrite').objectStore(FAILED).delete(id));
  }
  _notify();
  return flush(api);
}

/**
 * Dismiss failed entries the tech has acknowledged / re-entered manually.
 * Pass specific ids, or omit to clear all.
 */
export async function clearFailed(ids) {
  const db = await openDb();
  if (Array.isArray(ids) && ids.length) {
    for (const id of ids) {
      await idb(db.transaction(FAILED, 'readwrite').objectStore(FAILED).delete(id));
    }
  } else {
    await idb(db.transaction(FAILED, 'readwrite').objectStore(FAILED).clear());
  }
  _notify();
}

// Rebuild the request payload for the axios client from a stored entry.
function rebuildBody(entry) {
  if (entry.bodyKind !== 'formdata') return entry.body;
  const fd = new FormData();
  for (const { name, value } of entry.formParts) fd.append(name, value);
  return fd;
}

/**
 * Replay the queue FIFO through the provided axios client.
 * - 2xx: entry removed.
 * - Network error (no response object): entry kept, flush STOPS (offline).
 * - 4xx/5xx: entry DROPPED from queue, copied to the 'failed' store with the
 *   server's status/message — surfaced via failedEntries(), never retried.
 * Concurrent calls coalesce (second call is a no-op while one runs).
 * @returns {Promise<{ sent: number, failed: number, remaining: number }>}
 */
export async function flush(api) {
  if (_flushing) return { sent: 0, failed: 0, remaining: await pendingCount() };
  _flushing = true;
  _notify();
  let sent = 0;
  let failed = 0;
  try {
    const db = await openDb();
    // Snapshot ids first; we re-read each entry inside the loop so a long
    // photo upload doesn't hold an IDB transaction open (they auto-close).
    const entries = await idb(db.transaction(QUEUE, 'readonly').objectStore(QUEUE).getAll());
    for (const entry of entries) {
      try {
        await api.request({ method: entry.method, url: entry.url, data: rebuildBody(entry) });
        // 2xx (axios throws on everything else) — remove from queue.
        await idb(db.transaction(QUEUE, 'readwrite').objectStore(QUEUE).delete(entry.id));
        sent++;
      } catch (err) {
        if (!err.response) {
          // No response = network failure. Keep this and everything after it,
          // preserve FIFO order, try again on the next 'online' event.
          break;
        }
        // Server replied with an error — retrying will not help. Drop it and
        // record it so the UI can tell the tech their change was rejected.
        const { id, ...rest } = entry;
        await idb(db.transaction(FAILED, 'readwrite').objectStore(FAILED).add({
          ...rest,
          status: err.response.status,
          serverError: err.response.data?.error || err.response.data?.message || null,
          failedAt: Date.now(),
        }));
        await idb(db.transaction(QUEUE, 'readwrite').objectStore(QUEUE).delete(entry.id));
        failed++;
      }
    }
  } finally {
    _flushing = false;
    if (sent > 0 || failed > 0) _lastFlush = { sent, failed, at: Date.now() };
    _notify();
  }
  return { sent, failed, remaining: await pendingCount() };
}

/**
 * Wire auto-flush: replays on window 'online' and once at app start (if
 * anything is pending). Call once from fieldApi.js with the axios client.
 */
export function installAutoFlush(api) {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', () => { flush(api); });
  // App start: drain anything left over from a previous offline session.
  if (navigator.onLine) {
    pendingCount().then((n) => { if (n > 0) flush(api); }).catch(() => {});
  }
}
