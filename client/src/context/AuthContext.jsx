import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import api, { clearAuthStorage } from '../api/client';

const AuthContext = createContext(null);

// ── Role-based defaults (mirrors server/lib/featureFlags.ts) ──────────────────
// Used as fallback when featureFlags hasn't been set on older user records.
const ROLE_FEATURE_DEFAULTS = {
  admin: {
    assets_write: true,  contractors_write: true,  maintenance_brief: true,
    communications: true, export: true, alerts: true,
  },
  manager: {
    assets_write: true,  contractors_write: true,  maintenance_brief: true,
    communications: true, export: true, alerts: true,
  },
  viewer: {
    // Viewer tier is read-only by design (see server middleware roles header).
    assets_write: false, contractors_write: false, maintenance_brief: false,
    communications: false, export: false, alerts: true,
  },
  consultant: {
    // Maintenance-vendor account managers can read briefs but all write
    // affordances route through requireManager on the server; client-side
    // defaults must agree or we render buttons that 403 on submit.
    assets_write: false, contractors_write: false, maintenance_brief: true,
    communications: false, export: false, alerts: true,
  },
};

const ALL_FEATURE_KEYS = [
  'assets_write', 'contractors_write', 'maintenance_brief',
  'communications', 'export', 'alerts',
];

/**
 * Computes the effective feature visibility for a user.
 * - featureFlags: what the admin has enabled (null = role defaults)
 * - hiddenFeatures: what the user has personally hidden (only page-level features)
 * A feature is visible iff it is granted AND not personally hidden.
 */
function computeFeatures(user) {
  const off = Object.fromEntries(ALL_FEATURE_KEYS.map(k => [k, false]));
  if (!user) return off;
  const granted = user.featureFlags || ROLE_FEATURE_DEFAULTS[user.role] || ROLE_FEATURE_DEFAULTS.viewer;
  const hidden  = user.hiddenFeatures || {};
  return Object.fromEntries(
    ALL_FEATURE_KEYS.map(k => [k, granted[k] !== false && !hidden[k]])
  );
}

export function AuthProvider({ children }) {
  const [user, setUser]                     = useState(null);
  const [loading, setLoading]               = useState(true);
  const [aiEnabled, setAiEnabled]           = useState(true);
  const [aiConfigured, setAiConfigured]     = useState(false);
  const [onboardingDone, setOnboardingDone] = useState(true);
  // (A1) demoMode is read once from /api/setup/status (public endpoint) so the
  // banner renders for unauthenticated visitors too. We don't refresh on every
  // mount — the value flips only on operator action (env change + restart).
  const [demoMode, setDemoMode]             = useState(false);
  // Phase 4: AI provider name (env-set, server-exposed) for the consent modal.
  const [aiProvider, setAiProvider]         = useState('anthropic');
  // Pass-4 audit L3-07: current AI consent text version, surfaced by
  // /api/auth/me. The AiConsentContext echoes it back to /auth/ai-consent
  // on acknowledgment so the server can drift-check.
  const [aiConsentVersion, setAiConsentVersion] = useState('ai-consent-2026-05-17');

  // Derived: effective feature visibility
  const features = useMemo(() => computeFeatures(user), [user]);

  // ── Fetch per-account settings once we know the user is logged in ────────────
  // Also fetches /api/config here (now auth-gated) so we only call it post-login.
  const fetchAccountSettings = useCallback(async (userArg = null) => {
    // Audit-7 follow-up: gate /api/settings on admin role. Endpoint is admin-only
    // server-side (returns 403 otherwise), and the values it reads
    // (_aiConfigured, ONBOARDING_COMPLETE) are admin-only context anyway.
    // Pre-fix, every non-admin login fired this and produced a 403-storm
    // captured in the v0.89.1 audit.
    const isAdmin = userArg?.role === 'admin';
    try {
      const tasks = [];
      if (isAdmin) tasks.push({ key: 'settings', p: api.get('/api/settings') });
      tasks.push({ key: 'config', p: api.get('/api/config') });
      const results = await Promise.allSettled(tasks.map(t => t.p));
      results.forEach((res, i) => {
        if (res.status !== 'fulfilled') return;
        const key = tasks[i].key;
        const d = res.value.data.data;
        if (key === 'settings') {
          if (d?._aiConfigured !== undefined) setAiConfigured(d._aiConfigured);
          setOnboardingDone(d?.ONBOARDING_COMPLETE === true);
        } else if (key === 'config') {
          setAiEnabled(d?.aiEnabled !== false);
          if (d?.aiConfigured) setAiConfigured(true);
        }
      });
    } catch {
      // Fail open
    }
  }, []);

  // ── Dismiss onboarding ───────────────────────────────────────────────────────
  const dismissOnboarding = useCallback(async () => {
    setOnboardingDone(true);
    try {
      await api.put('/api/settings', { ONBOARDING_COMPLETE: 'true' });
    } catch {
      // Best-effort
    }
  }, []);

  // (A1) On mount, fetch /api/setup/status once. It's the only public-and-cheap
  // signal of demo mode, so we read it independently of the auth state. Any
  // failure leaves demoMode=false (fail-closed against false-positive banners).
  useEffect(() => {
    let cancelled = false;
    api
      .get('/api/setup/status')
      .then((res) => {
        if (cancelled) return;
        setDemoMode(!!res?.data?.data?.demoMode);
      })
      .catch(() => { /* fail-closed: leave demoMode=false */ });
    return () => { cancelled = true; };
  }, []);

  // On mount: verify stored access token; if valid, restore session + fetch settings.
  // /api/config is now auth-gated so it's fetched inside fetchAccountSettings (post-login only).
  useEffect(() => {
    const token = localStorage.getItem('servicecycle_token');
    if (!token) {
      setLoading(false);
      return;
    }

    api
      .get('/api/auth/me')
      .then((res) => {
        const u = res.data.data.user;
        setUser(u);
        // Phase 4: aiProvider comes from /api/auth/me alongside user.
        // Used by the AI consent modal to show the configured provider
        // name. Falls back to 'anthropic' if /me ever stops returning it.
        setAiProvider(res.data.data.aiProvider || 'anthropic');
        // Pass-4 audit L3-07: surface the current consent text version.
        if (res.data.data.aiConsentVersion) setAiConsentVersion(res.data.data.aiConsentVersion);
        if (u?.account?.companyName) localStorage.setItem('servicecycle_company', u.account.companyName);
        fetchAccountSettings(u);
      })
      .catch(() => {
        // Token rejected (expired, revoked, or wrong signing key after a
        // server JWT_SECRET rotation). Wipe ALL session state, including
        // servicecycle_company — otherwise the prior tenant's company name
        // bleeds into the sidebar of the next tenant that registers in
        // this same browser session (F022 audit observation, 2026-05-07).
        clearAuthStorage();
      })
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const login = async (email, password) => {
    const res = await api.post('/api/auth/login', { email, password });
    const data = res.data.data;

    // 2FA gate — caller must handle this case and call verify2fa()
    if (data.requires2fa) return data;

    const { token, refreshToken, user: userData, aiProvider: provider } = data;
    // Clear any residue from a prior session before writing the new one —
    // otherwise the "if companyName present" guards below leave stale
    // values in place when the new payload is partial. (F022 fix.)
    clearAuthStorage();
    localStorage.setItem('servicecycle_token', token);
    if (refreshToken) localStorage.setItem('servicecycle_refresh_token', refreshToken);
    if (userData?.account?.companyName) localStorage.setItem('servicecycle_company', userData.account.companyName);
    setUser(userData);
    if (provider) setAiProvider(provider);
    await fetchAccountSettings(userData);
    return userData;
  };

  const verify2fa = async (twoFactorToken, code) => {
    const res = await api.post('/api/auth/2fa/verify-login', { twoFactorToken, code });
    const { token, refreshToken, user: userData, aiProvider: provider } = res.data.data;
    clearAuthStorage();
    localStorage.setItem('servicecycle_token', token);
    if (refreshToken) localStorage.setItem('servicecycle_refresh_token', refreshToken);
    if (provider) setAiProvider(provider);
    if (userData?.account?.companyName) localStorage.setItem('servicecycle_company', userData.account.companyName);
    setUser(userData);
    await fetchAccountSettings(userData);
    return res.data.data; // caller can check for warning about low backup codes
  };

  // Used by AcceptInvite to log user in after account creation.
  // refreshToken is optional for backwards compatibility with callers that only pass two args.
  const setAuthData = (token, refreshTokenOrUser, maybeUser) => {
    // Support both: setAuthData(token, userData) and setAuthData(token, refreshToken, userData)
    let refreshToken = null;
    let userData;
    if (maybeUser !== undefined) {
      refreshToken = refreshTokenOrUser;
      userData = maybeUser;
    } else {
      userData = refreshTokenOrUser;
    }
    // Same clear-then-write pattern as login()/verify2fa() so register and
    // accept-invite flows don't inherit stale servicecycle_company /
    // servicecycle_user from a prior session in this browser. (F022 fix.)
    clearAuthStorage();
    localStorage.setItem('servicecycle_token', token);
    if (refreshToken) localStorage.setItem('servicecycle_refresh_token', refreshToken);
    if (userData?.account?.companyName) localStorage.setItem('servicecycle_company', userData.account.companyName);
    setUser(userData);
    fetchAccountSettings(userData);
  };

  // Update local user state (e.g. after profile save, hidden features change)
  const updateUser = useCallback((patch) => {
    setUser(prev => prev ? { ...prev, ...patch } : prev);
  }, []);

  // Called from ProfilePage after saving hidden-features preferences
  const updateHiddenFeatures = useCallback(async (hiddenFeatures) => {
    try {
      const res = await api.put('/api/users/me/hidden-features', { hiddenFeatures });
      if (res.data.data?.user) updateUser({ hiddenFeatures: res.data.data.user.hiddenFeatures });
    } catch (err) {
      throw err;
    }
  }, [updateUser]);

  const logout = async () => {
    // Best-effort server-side refresh token revocation
    const rt = localStorage.getItem('servicecycle_refresh_token');
    if (rt) {
      try { await api.post('/api/auth/logout', { refreshToken: rt }); } catch { /* ignore */ }
    }
    clearAuthStorage();
    setUser(null);
    setOnboardingDone(true);
    setAiConfigured(false);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        login,
        verify2fa,
        logout,
        setAuthData,
        updateUser,
        updateHiddenFeatures,
        features,
        aiEnabled,
        aiConfigured,
        onboardingDone,
        dismissOnboarding,
        fetchAccountSettings,
        demoMode,
        aiProvider, // Phase 4: drives the consent modal's "<provider>" label
        aiConsentVersion, // Pass-4 audit L3-07: posted back on acknowledgment
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
