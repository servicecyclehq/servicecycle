// ─────────────────────────────────────────────────────────────────────────────
// useUserPreference.js — v0.42 cross-device per-user preference hook
//
// API mirror of React.useState — but instead of in-memory only, the value
// round-trips to /api/preferences/:key on the server. localStorage is used
// as a transient cache so the first paint shows the cached value instead of
// the default while the server fetch is in flight.
//
// Usage:
//
//   const [visibility, setVisibility] = useUserPreference(
//     'contracts.columnVisibility',
//     DEFAULT_VISIBILITY
//   );
//
//   <ColumnPicker visibility={visibility} onChange={setVisibility} />
//
// Semantics:
//   - On mount: read from localStorage (immediate, sync) then fire a fetch
//     to the server. If the server's value differs, update state and cache.
//   - On setValue: update state immediately + cache + fire a debounced PUT
//     to the server (250 ms). If multiple setValue() calls fire in quick
//     succession, only the last one is sent.
//   - On unmount: pending writes are flushed before tearing down.
//   - If a fetch / put fails (network, 401, etc.) the hook falls back to
//     localStorage-only — the value is still functional, just not synced.
//
// Not used outside an AuthContext-authenticated session. The first server
// call will 401 if the user isn't logged in; the hook treats that the same
// as a non-OK response and stays in localStorage-only mode.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import { getPreference, setPreference } from '../api/preferences';

const CACHE_PREFIX = 'lapseiq_pref_';
const DEBOUNCE_MS  = 250;

function readCache(key, fallback) {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(CACHE_PREFIX + key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    // v0.89.12: a cached null is a poisoned value from the v0.89.2-11 era
    // (preferences endpoint started returning {value:null} for missing rows
    // and the old hook wrote that null into the cache). Treat as missing.
    if (parsed === null || parsed === undefined) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

function writeCache(key, value) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value));
  } catch {
    /* quota exceeded, private window, etc. — silent */
  }
}

export function useUserPreference(key, defaultValue) {
  const [value, setValueState] = useState(() => readCache(key, defaultValue));
  const valueRef     = useRef(value);
  const pendingTimer = useRef(null);
  const mountedRef   = useRef(true);

  // Track the latest value in a ref so the flush logic always sends the
  // most-recent value even after the React state has lagged behind a fast
  // sequence of setValue() calls.
  useEffect(() => { valueRef.current = value; }, [value]);

  // Initial server fetch — single shot, reconciles cached value with server.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await getPreference(key);
      if (cancelled || !mountedRef.current) return;
      if (!r.ok) return; // network / 401 — stay in cache-only mode
      // Server says "no value yet" → keep whatever we already have
      // (could be the cached value, could be the default).
      if (r.value === undefined || r.value === null) return; // v0.89.12: null = no-override (matches updated /api/preferences contract)
      // Only update if the server value actually differs from what we have,
      // so we don't trigger a re-render for an identical value.
      try {
        const serverStr = JSON.stringify(r.value);
        const localStr  = JSON.stringify(valueRef.current);
        if (serverStr !== localStr) {
          setValueState(r.value);
          writeCache(key, r.value);
        }
      } catch {
        // Fallback if either side isn't JSON-serializable (shouldn't happen
        // for this hook's intended use, but defensive against the unknown).
        setValueState(r.value);
        writeCache(key, r.value);
      }
    })();
    return () => { cancelled = true; };
    // Intentionally only re-run when the key changes — defaultValue churn
    // (caller passes a fresh object literal on every render) would otherwise
    // re-fetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Cleanup on unmount: flush any pending write so we don't drop the
  // user's last change to the floor.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (pendingTimer.current) {
        clearTimeout(pendingTimer.current);
        // Fire-and-forget — component is unmounting, can't observe result.
        setPreference(key, valueRef.current);
      }
    };
  }, [key]);

  const setValue = useCallback((next) => {
    // Allow either a value or a (prev) => next updater, matching useState.
    setValueState((prev) => {
      const resolved = (typeof next === 'function') ? next(prev) : next;
      valueRef.current = resolved;
      writeCache(key, resolved);

      // Debounced PUT: replace any pending timer with a fresh one. The
      // ref-based valueRef.current is read at fire time so the most recent
      // value goes to the server even after rapid successive setValue calls.
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
      pendingTimer.current = setTimeout(() => {
        pendingTimer.current = null;
        setPreference(key, valueRef.current);
      }, DEBOUNCE_MS);

      return resolved;
    });
  }, [key]);

  return [value, setValue];
}
