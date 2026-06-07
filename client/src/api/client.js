import axios from 'axios';

// v0.36.9 (Pass-6 W3 ship cleanup): fallback default changed from
// 'http://localhost:3001' to '' (empty string). The localhost default baked into
// production bundles built without VITE_API_URL set (the GHA workflow
// passes it; manual `npm run build` on the droplet doesn't, and neither
// path was load-tested separately). The result was the v0.36.8 W3 deploy
// shipping a client that requested http://localhost:3001/api/* from the
// visitor's browser - 503 in production, registrationOpen state
// silently fell to the .catch() branch + the Register page showed
// "Registration is closed on this instance" instead of the demo form.
// '/api' resolves same-origin via the Caddy reverse proxy on demo
// (servicecycle.com -> Caddy -> server container) and on self-host (whatever
// reverse-proxy the operator uses). Operators who need a cross-origin
// API base can still set VITE_API_URL at build time to override.
// v0.36.10: the v0.36.9 fix used '/api' as the fallback which double-
// prefixed every request (`api.get('/api/setup/status')` -> `/api/api/setup/status`
// -> 404). The callers in this codebase all include `/api/` in their path
// already, so the baseURL must be empty for the relative request to land
// at the correct same-origin URL.
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? '',
  // META-OFF-007 (Round-6): 30s timeout so a hung server doesn't hang the UI
  // forever. The offline banner picks up when navigator.onLine flips; this
  // catches the 'server up but a single request stalls' case.
  timeout: 30000,
});

// ---------------------------------------------------------------------------
// Auth storage management — sandbox isolation policy
//
// EVERY localStorage key that carries session state MUST be in SESSION_KEYS
// (or covered by SESSION_KEY_PREFIXES). EVERY new key file-author wants to
// keep across sessions MUST be explicitly listed in KEEP_KEYS below.
//
// Default-deny: clearAuthStorage() wipes every `servicecycle_*` key that isn't on
// the KEEP_KEYS allowlist. This is the v0.7.3 hardening — before this, any
// new localStorage key had to be remembered by the author for both the
// SESSION_KEYS clear path AND the audit; missing one quietly leaked state
// across sandbox sessions on the demo droplet (2026-05-07 F022 was the
// company-name leak; 2026-05-13 was the welcome-tour-fires-immediately leak).
//
// SESSION_KEYS is documentation now — useful for grep + reading. The actual
// safety comes from the default-deny sweep at the end of clearAuthStorage().
// ---------------------------------------------------------------------------

const SESSION_KEYS = [
  'servicecycle_token',
  'servicecycle_refresh_token',
  'servicecycle_company',
  // OnboardingWizard saves the next-step index so navigation to a task page
  // doesn't lose the user's place. Must be wiped on logout/login or it
  // contaminates the next account in the same browser - first-time tenants
  // got the wrong starting step (e.g. landed on "Add an asset" because the
  // previous account had advanced past "Add a site"). Filed 2026-05-08.
  'servicecycle_onboarding_step',
  // 2026-05-13: WelcomeTourPanel celebrate-flag persisted across nightly
  // demo resets and surfaced the tour before OnboardingWizard could run.
  // v0.7.2 gated the panel on onboardingDone; v0.7.3 also clears the key.
  'servicecycle_welcome_pending',
  // Per-account AI-consent acknowledgement. Account-scoped, must clear on
  // session change so a new sandbox user re-confirms consent.
  'servicecycle_ai_consent_session',
  // Demo banner dismissal — per visit, not per persistent user.
  'servicecycle_demo_banner_dismissed',
  // Setup banner dismissal — lets sandbox visitors skip the onboarding
  // prompt without marking setup as done. Clears on logout so the next
  // visitor to the same browser gets the full guided flow.
  'servicecycle_setup_banner_dismissed',
  // Historical keys we no longer write but may still exist from earlier
  // versions; cleared so a logout from an upgraded client wipes them.
  'servicecycle_user',
];

// Prefix matches — for any key shaped `<prefix><uid>` or `<prefix>:<thing>`.
// On clearAuthStorage we sweep every localStorage key starting with one of
// these prefixes. Used for the per-user draft auto-save (NewAsset.jsx
// writes `servicecycle_draft_asset_new:<uid>`).
const SESSION_KEY_PREFIXES = [
  'servicecycle_draft_asset_new:',
];

// KEEP_KEYS — explicit allowlist of `servicecycle_*` keys that survive a
// session change. ONLY user-facing preferences with no account-coupling go
// here. If you need to add one, the bar is: would two prospects sharing a
// browser at a kiosk both want this value? If no, it's session-scoped and
// doesn't belong here.
const KEEP_KEYS = [
  // User's preferred light/dark theme. UX preference, no data coupling.
  'servicecycle_theme',
];

export function clearAuthStorage() {
  // Explicit clear of the documented session keys (cheap; idempotent).
  for (const k of SESSION_KEYS) localStorage.removeItem(k);

  // Default-deny sweep: any `servicecycle_*` key not on the KEEP allowlist
  // gets wiped. Catches future-author-forgot-to-register-the-key bugs and any
  // prefix-shaped per-user keys. This is the load-bearing line of defense.
  // Legacy `lapseiq_*` keys (pre-rebrand clients) are swept unconditionally
  // so an upgraded client leaves no residue behind.
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith('lapseiq_')) { localStorage.removeItem(key); continue; }
      if (!key.startsWith('servicecycle_')) continue;
      if (KEEP_KEYS.includes(key)) continue;
      // Already-removed explicit keys re-removing is a no-op; prefix-keys
      // get caught here. Belt and suspenders.
      localStorage.removeItem(key);
    }
  } catch (_) {
    // localStorage blocked (private window, quota, etc.) — explicit clear
    // above is the best we could do.
  }

  // Prefix sweep is now redundant with the default-deny pass, but kept for
  // documentation of the per-user-key pattern we use elsewhere.
  void SESSION_KEY_PREFIXES;
}

// ---------------------------------------------------------------------------
// Public-route allowlist for the 401 redirect suppression.
//
// v0.36.2 added a guard against the AiConsentModal/useAiUsage 401 loop on
// /login (see the long comment in the response interceptor below). That fix
// only checked for /login, but AiConsentModal is mounted at App root and
// fires its usage probe on EVERY public route — so unauthenticated visitors
// to /register, /forgot-password, /privacy, /terms, etc. were getting
// redirected to /login on first load by the same 401 -> location.href chain.
//
// Audit Pass 6 Lens 1 P0-B2 / REG-B32 — this allowlist broadens the guard to
// every route mounted outside <ProtectedRoute> in App.jsx. If you add a new
// public route, add it here too or anonymous visitors will get bounced.
// ---------------------------------------------------------------------------

const PUBLIC_PATH_EXACT = new Set([
  '/',
  '/login',
  '/register',
  '/forgot-password',
  '/setup',
  '/privacy',
  '/terms',
  '/eula',
  '/sub-processors',
  '/demo-sandbox-notice',
]);

const PUBLIC_PATH_PREFIXES = [
  '/reset-password/',   // /reset-password/:token
  '/accept-invite/',    // /accept-invite/:token
  '/legal/',            // /legal/privacy, /legal/terms, /legal/eula, /legal/sub-processors, /legal/demo-sandbox-notice
];

function isPublicPath(pathname) {
  if (!pathname) return false;
  if (PUBLIC_PATH_EXACT.has(pathname)) return true;
  return PUBLIC_PATH_PREFIXES.some((p) => pathname.startsWith(p));
}

// v0.37.2 W6 MT-116: signal to the next page (typically /login) that the
// reason we're here is a session expiry, not a deliberate navigation. The
// Login page reads + clears this on mount and renders a toast so the user
// gets the "your session expired, please sign in again" feedback instead
// of a silent re-paint of the login form.
//
// sessionStorage (not localStorage) so it dies with the tab — a stale flag
// across browser restarts would mis-announce a fresh visit as an expiry.
function markSessionExpired() {
  if (typeof window === 'undefined') return;
  try { sessionStorage.setItem('servicecycle_session_expired', 'true'); } catch (_) { /* ignore */ }
}

function redirectToLoginIfProtected() {
  if (typeof window === 'undefined') return;
  if (isPublicPath(window.location.pathname)) return;
  markSessionExpired();
  window.location.href = '/login';
}

// Attach access token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('servicecycle_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Track whether a refresh is already in flight so concurrent 401s don't each
// trigger a separate refresh attempt.
let _refreshPromise = null;

// Handle 401 globally. (H4)
// On 401 from a non-auth endpoint: attempt one silent refresh using the stored
// refresh token, retry the original request with the new access token, and only
// redirect to /login if the refresh also fails.
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const isAuthEndpoint = originalRequest?.url?.includes('/api/auth/');
    const isSetupEndpoint = originalRequest?.url?.includes('/api/setup/');

    // (S8) Setup-gate handling. Server returns 503 with needsSetup:true on
    // every /api/* request when the first-run wizard hasn't completed. Route
    // the user to /setup unless they're already there or talking to /api/setup.
    if (
      error.response?.status === 503 &&
      error.response?.data?.needsSetup === true &&
      !isSetupEndpoint &&
      typeof window !== 'undefined' &&
      window.location.pathname !== '/setup'
    ) {
      window.location.href = '/setup';
      return Promise.reject(error);
    }

    // Don't intercept errors from auth endpoints (e.g. bad password on /login)
    // or retried requests (prevents infinite retry loop)
    if (error.response?.status === 401 && !isAuthEndpoint && !originalRequest._retried) {
      originalRequest._retried = true;

      const refreshToken = localStorage.getItem('servicecycle_refresh_token');
      if (refreshToken) {
        try {
          // Coalesce concurrent refresh attempts into one request
          if (!_refreshPromise) {
            _refreshPromise = axios
              .post(
                `${import.meta.env.VITE_API_URL ?? ''}/api/auth/refresh`,
                { refreshToken }
              )
              .finally(() => { _refreshPromise = null; });
          }

          const refreshRes = await _refreshPromise;
          const { token: newAccessToken, refreshToken: newRefreshToken } = refreshRes.data.data;

          localStorage.setItem('servicecycle_token', newAccessToken);
          if (newRefreshToken) localStorage.setItem('servicecycle_refresh_token', newRefreshToken);

          // Retry original request with the new access token
          originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
          return api(originalRequest);
        } catch {
          // Refresh failed — clear all auth state and force re-login,
          // BUT only if we're on a protected route. v0.36.2 fix (the
          // original /login-only guard): without this, a tab whose refresh
          // token expired AND that has AiConsentModal at App root (which
          // calls useAiUsage on every mount, including /login) would fall
          // into a tight loop: /api/ai/usage/me 401 -> refresh fails ->
          // location.href='/login' -> page reload -> AiConsentModal mounts
          // -> useAiUsage fires -> /api/ai/usage/me 401 -> ...
          //
          // Pass 6 broadening (P0-B2/REG-B32): the same loop fires on
          // every OTHER public route too (/register, /forgot-password,
          // /privacy, ...) because AiConsentModal is mounted at App root,
          // not under ProtectedRoute. Without the broader check, an
          // unauthenticated visitor to /register gets a 401 from the
          // background usage probe and is redirected to /login before they
          // can finish typing their email. The PUBLIC_PATH allowlist above
          // covers every route mounted outside <ProtectedRoute> in
          // App.jsx — refresh-failure on those routes clears state but
          // does NOT redirect.
          clearAuthStorage();
          redirectToLoginIfProtected();
          return Promise.reject(error);
        }
      }

      // No refresh token available — go straight to login, but only
      // if we're on a protected route (see comment above for the loop
      // pattern + public-route regression this guards against).
      clearAuthStorage();
      redirectToLoginIfProtected();
    }

    // Demo-mode 403 — server returns { demoMode: true } when a write is
    // blocked because this is a demo instance. Surface a user-friendly
    // toast instead of letting the calling component show a raw error.
    if (
      error.response?.status === 403 &&
      error.response?.data?.demoMode === true
    ) {
      // Fire a custom DOM event so any component can listen without coupling
      // to a global store. Layout.jsx picks this up and renders the banner.
      window.dispatchEvent(new CustomEvent('servicecycle:demo-blocked', {
        detail: { message: 'This action is disabled on the ServiceCycle demo.' },
      }));
      // Still reject so the calling component's catch runs, but tag the
      // error so components can opt-out of showing their own error message.
      error.demoBlocked = true;
      return Promise.reject(error);
    }

    // H8 (audit High, 2026-05-22): capture the server's x-request-id on
    // error responses and append it to error.message so support can
    // look the failure up in Better Stack / Healthchecks. The header
    // is set by middleware/requestId.js on every response. Components
    // that show error.message in a toast automatically get the (ref: ...)
    // suffix; components that show raw error.response.data.error are
    // unaffected.
    const requestId = error.response?.headers?.['x-request-id'];
    if (requestId && error.message && !error.message.includes('(ref:')) {
      try { error.message = `${error.message} (ref: ${requestId.slice(0, 8)})`; } catch (_) { /* noop */ }
    }

    return Promise.reject(error);
  }
);

export default api;
