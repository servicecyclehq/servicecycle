/* v0.92.3: /api/bootstrap prefetch (externalized from index.html for CSP).
   Fires the /api/bootstrap request while the page is still parsing HTML, BEFORE
   React mounts. ContractsList then awaits this promise instead of issuing the
   fetch from its useEffect. Moves the request from ~227ms into the load to
   ~30-50ms (JS parse + token read). Same-origin classic script -> allowed by the
   demo CSP (script-src 'self') without an inline-script hash.
   Fails open: if the token is missing or the fetch 4xx/5xx's, the promise
   resolves to null and ContractsList falls back to its normal mount-fetch path
   (which handles 401 via the existing axios interceptor + redirect-to-login). */
(function () {
  try {
    if (location.pathname !== '/contracts') return;
    var token = localStorage.getItem('lapseiq_token');
    if (!token) return;
    var __bp = new URLSearchParams(location.search);
    // Mirror ContractsList default (hideExpired = no status param): exclude
    // expired so the first painted list matches the filtered default view
    // instead of flashing the full expired-led set.
    if (!__bp.get('status') && !__bp.has('excludeExpired')) { __bp.set('excludeExpired', 'true'); }
    var __bq = __bp.toString();
    window.__lapseiqBootstrap = fetch('/api/bootstrap' + (__bq ? '?' + __bq : ''), {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
      credentials: 'same-origin',
    }).then(function (r) {
      return r.ok ? r.json() : null;
    }).catch(function () { return null; });
  } catch (e) { /* fall through to React's normal flow */ }
})();
