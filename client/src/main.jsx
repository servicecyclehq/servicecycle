import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { installGlobalErrorHandlers } from './lib/globalErrorReporter.js';
// PWA service worker registration (vite-plugin-pwa virtual module).
// registerType 'autoUpdate' + devOptions.enabled:false in vite.config.js —
// in `vite dev` this resolves to a no-op stub so HMR/dev-proxy are untouched;
// in production builds it registers the workbox SW and self-updates.
import { registerSW } from 'virtual:pwa-register';

// Brand typography:
// Inter + JetBrains Mono are self-hosted via @font-face in index.css,
// served same-origin from /fonts/*.woff2. The previous attempt at importing
// here turned out to silently break the production build on Linux runners
// (Vite/Rollup tree-shook the entire app tree downstream of those 5 imports,
// producing a 185KB stub bundle missing all app code). See v0.5.4 incident
// notes. No third-party font CDN is used (telemetry-free brand); the woff2
// files live in client/public/fonts.

import './index.css';

// v0.90.8: install window.onerror + unhandledrejection handlers BEFORE any
// React or user code runs. Closes the proactive-ops gap that ErrorBoundary
// can't cover (event-handler throws, async errors, rejected promises). Both
// classes auto-POST to /api/errors/render with kind='uncaught' or 'promise'.
installGlobalErrorHandlers();

// Stale-chunk auto-recovery. With PWA registerType:'autoUpdate', deploying a
// new build purges the old hashed lazy chunks; a tab left open on the previous
// build then 404s when it lazy-loads a route ("Failed to fetch dynamically
// imported module") and the app shell crashes into the ErrorBoundary (header
// and footer vanish with it). Vite fires `vite:preloadError` for exactly this —
// reload ONCE (guarded against loops) to pick up the fresh build.
(function installChunkReloadGuard() {
  const KEY = 'sc_chunk_reload_at';
  const CHUNK_RE = /(failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module|chunkloaderror|loading chunk [\w-]+ failed)/i;
  function recover() {
    try {
      const last = Number(sessionStorage.getItem(KEY) || 0);
      if (Date.now() - last < 15000) return; // already reloaded recently — don't loop
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch (_e) { /* storage blocked — accept the small loop risk over a dead shell */ }
    window.location.reload();
  }
  window.addEventListener('vite:preloadError', (e) => { try { e.preventDefault(); } catch (_e) {} recover(); });
  window.addEventListener('error', (e) => { if (e && CHUNK_RE.test(e.message)) recover(); });
  window.addEventListener('unhandledrejection', (e) => { if (e && e.reason && CHUNK_RE.test(e.reason.message)) recover(); });
})();

// ── PWA update lifecycle -> "new version" toast (2026-07-03 stale-cache fix) ──
// The SW precache is version-stamped per build (vite.config.js SW_BUILD_STAMP),
// so EVERY deploy yields a new sw.js. workbox runs skipWaiting + clientsClaim:
// the new SW installs, activates, and takes over this tab as soon as an update
// check finds it (immediate check on load, then every 60s + on tab focus below).
//
// What we deliberately do NOT do anymore is force a mid-session reload (this
// used to window.location.reload() on controllerchange -- lethal to a demo
// presenter mid-flow or a tech mid-form). Instead both update signals feed one
// idempotent toast -- "A new version is available - Reload" -- and a single
// click fetches the fresh bundle:
//   - registration 'updatefound' -> new worker hits 'installed' while a
//     controller exists = an update finished downloading (fires even if
//     activation stalls);
//   - 'controllerchange' with a pre-existing controller = the new SW took
//     over and the JS currently running is the stale side.
// First-install controllerchange (controller null -> SW via clientsClaim) is
// NOT an update, hence the hadController guard. Stale lazy-chunk 404s are
// still auto-recovered by the vite:preloadError guard above -- that reload is
// crash recovery, not an update push.
const SW_TOAST_ID = 'sc-sw-update-toast';
function showSwUpdateToast() {
  try {
    if (document.getElementById(SW_TOAST_ID)) return; // already showing
    const bar = document.createElement('div');
    bar.id = SW_TOAST_ID;
    bar.setAttribute('role', 'alert');
    bar.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:16px', 'transform:translateX(-50%)',
      'z-index:2147483000', 'display:flex', 'align-items:center', 'gap:12px',
      'background:#0d4f6e', 'color:#ffffff', 'padding:10px 16px',
      'border-radius:8px', 'box-shadow:0 4px 16px rgba(0,0,0,0.35)',
      'font-family:Inter,system-ui,sans-serif', 'font-size:14px',
      'font-weight:500', 'max-width:92vw',
    ].join(';');
    const msg = document.createElement('span');
    msg.textContent = 'A new version is available';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Reload';
    btn.style.cssText =
      'background:#ffffff;color:#0d4f6e;border:none;padding:6px 14px;' +
      'border-radius:6px;font-size:13px;font-weight:600;cursor:pointer';
    btn.addEventListener('click', () => { window.location.reload(); });
    bar.appendChild(msg);
    bar.appendChild(btn);
    if (document.body) document.body.appendChild(bar);
    else document.addEventListener('DOMContentLoaded', () => { document.body.appendChild(bar); });
  } catch (_e) { /* toast is best-effort -- never break the app over it */ }
}

if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // first install — not an update, no toast
    showSwUpdateToast();
  });
}

registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    // Belt: surface the update as soon as it finishes installing, in addition
    // to the controllerchange signal (braces). Same idempotent toast.
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          showSwUpdateToast();
        }
      });
    });
    const check = () => {
      registration.update().catch((err) => {
        // Do NOT swallow: a failing sw.js fetch (e.g. /sw.js re-gated behind the
        // reverse-proxy auth -> 401, or a transient network error) silently pins
        // the old worker so no update toast ever fires. Make it detectable.
        try {
          console.warn('[sw] update check failed:', err && err.message);
          const t = window.localStorage && window.localStorage.getItem('servicecycle_token');
          if (t) fetch('/api/errors/render', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
            body: JSON.stringify({ kind: 'sw-update-failed', message: String((err && err.message) || err) }),
          }).catch(() => {});
        } catch (_e) {}
      });
    };
    setInterval(check, 60 * 1000);
    window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  },
});

// v0.92.19: take manual control of scroll restoration so the browser does not
// restore a stale offset on reload/redirect (e.g. landing mid-dashboard after
// the signup redirect). The app restores scroll itself where it wants to.
if (typeof window !== 'undefined' && 'scrollRestoration' in window.history) {
  window.history.scrollRestoration = 'manual';
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
