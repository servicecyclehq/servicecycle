// -----------------------------------------------------------------------------
// globalErrorReporter.js  (v0.90.8)
//
// Catches the two classes of runtime errors that ErrorBoundary does NOT see:
//   - window 'error' event:           uncaught synchronous throws outside React
//                                     render (event handlers, setTimeout, etc.)
//   - window 'unhandledrejection':    rejected Promises that no .catch() awaits
//
// Both POST to the same /api/errors/render endpoint as ErrorBoundary, marked
// with kind='uncaught' or kind='promise' so we can slice the render_errors
// table by where the crash originated.
//
// Why DIY instead of GlitchTip / Sentry: ServiceCycle's product philosophy is
// strictly self-hosted (see project_lapseiq_philosophy memory). The hosted
// SaaS offerings violate that, and self-hosting GlitchTip on the demo
// droplet adds 5+ containers for a feature that's a 60-line client module +
// a kind discriminator on render_errors. This gives ~80% of GlitchTip's
// proactive ops value (knowing a crash happened in prod the moment it does)
// at near-zero infra cost.
//
// Design constraints mirrored from ErrorBoundary:
//   - fire-and-forget (.catch noop) -- a broken telemetry path never cascades
//   - sessionStorage dedup per errorCode so a hot loop doesn't 1000x the POST
//   - keepalive fetch survives page unload (capture errors during navigation)
//   - bearer token optional (server endpoint accepts anonymous)
//   - per-kind cap (MAX_PER_KIND) so a true storm gets rate-limited at the
//     client before even hitting the server's 30/min IP cap
// -----------------------------------------------------------------------------

const MAX_PER_KIND = 20; // hard cap per page-session; sliding storm protection
const sentCounts = { uncaught: 0, promise: 0 };
let installed = false;

function getBundleVersion() {
  try {
    const el = document.querySelector('meta[name="servicecycle-build-id"]');
    if (!el) return null;
    const v = el.getAttribute('content');
    if (!v || v.startsWith('%')) return null;
    return v;
  } catch (_) { return null; }
}

function getBearerToken() {
  try {
    return (window.localStorage && window.localStorage.getItem('servicecycle_token')) || null;
  } catch (_) { return null; }
}

function makeErrorCode() {
  // base36 timestamp + 3 random chars -- matches ErrorBoundary format
  const ts = Date.now().toString(36).toUpperCase();
  const rnd = Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0');
  return ts + '-' + rnd;
}

function isAlreadyPosted(errorCode) {
  try {
    const k = 'servicecycle_runtime_posted_' + errorCode;
    if (window.sessionStorage && window.sessionStorage.getItem(k)) return true;
    if (window.sessionStorage) window.sessionStorage.setItem(k, '1');
  } catch (_) { /* private mode */ }
  return false;
}

function postRuntimeError(kind, payload) {
  if (sentCounts[kind] >= MAX_PER_KIND) return;
  sentCounts[kind] += 1;

  const token = getBearerToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  try {
    fetch('/api/errors/render', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload),
      credentials: 'same-origin',
      keepalive: true,
    }).catch(function () { /* swallow */ });
  } catch (_) { /* swallow */ }
}

function handleErrorEvent(ev) {
  try {
    const err = ev && ev.error;
    const errorCode = makeErrorCode();
    // Dedup on message+source+line, not on errorCode (which is fresh each
    // time). Use a stable hash so the same uncaught throw firing 50 times
    // from one bad handler only posts once.
    const stableKey =
      'uncaught:' +
      String((err && err.message) || ev.message || 'unknown') + ':' +
      String(ev.filename || '?') + ':' +
      String(ev.lineno || 0);
    if (isAlreadyPosted(stableKey)) return;

    const payload = {
      errorCode:      errorCode,
      kind:           'uncaught',
      name:           (err && err.name) || 'Error',
      message:        (err && err.message) || ev.message || 'unknown uncaught error',
      stack:          (err && err.stack) || null,
      path:           (window.location && window.location.pathname) || null,
      appVersion: getBundleVersion(),
      // line + column + filename go into the message for now since the
      // server schema doesn't carry them as columns. Cheap context.
      at:             new Date().toISOString(),
      source:         (ev.filename || null) + ':' + (ev.lineno || 0) + ':' + (ev.colno || 0),
    };
    postRuntimeError('uncaught', payload);
  } catch (_) { /* never throw from a global error handler */ }
}

function handleRejection(ev) {
  try {
    const reason = ev && ev.reason;
    const errorCode = makeErrorCode();
    const isErr = reason instanceof Error;
    const msg = isErr
      ? reason.message
      : (typeof reason === 'string' ? reason : (function () {
          try { return JSON.stringify(reason); } catch (_) { return String(reason); }
        })());

    const stableKey = 'promise:' + String(msg || 'unknown');
    if (isAlreadyPosted(stableKey)) return;

    const payload = {
      errorCode:      errorCode,
      kind:           'promise',
      name:           isErr ? (reason.name || 'Error') : 'UnhandledRejection',
      message:        msg || 'unknown rejection',
      stack:          isErr ? reason.stack : null,
      path:           (window.location && window.location.pathname) || null,
      appVersion: getBundleVersion(),
      at:             new Date().toISOString(),
    };
    postRuntimeError('promise', payload);
  } catch (_) { /* never throw from a global handler */ }
}

/**
 * Idempotent install. Safe to call multiple times (e.g. during HMR);
 * second + call is a no-op. Call from main.jsx before ReactDOM.createRoot
 * so handlers are live before any user code runs.
 */
export function installGlobalErrorHandlers() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', handleErrorEvent);
  window.addEventListener('unhandledrejection', handleRejection);
}