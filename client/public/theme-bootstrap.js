/* v0.92.3: Pre-React theme bootstrap (externalized from index.html for CSP).
   Reads lapseiq_theme from localStorage (set by the ThemeToggle in the sidebar
   footer) and applies it before the SPA mounts so there's no flash-of-unstyled-
   theme on dark-mode users. Default = light when no preference is stored.
   Loaded as a classic, render-blocking <script src> in <head> so it still runs
   before first paint. Same-origin -> allowed by the demo CSP (script-src 'self')
   without needing an inline-script sha256 hash. */
(function () {
  try {
    // UX-THEME-001: public routes always render in light mode - never inherit
    // a stale dark-mode preference from a previous authenticated session.
    // Authenticated app routes still read and apply lapseiq_theme normally.
    var p = location.pathname;
    var pub = ['/', '/login', '/register', '/forgot-password', '/reset-password', '/accept-invite'];
    if (pub.indexOf(p) !== -1 || p.indexOf('/legal/') === 0) return;
    var t = localStorage.getItem('lapseiq_theme');
    if (t === 'dark' || t === 'light') {
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch (e) { /* localStorage blocked - silently fall through to default light */ }
})();
