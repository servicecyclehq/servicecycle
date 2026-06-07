/**
 * AiConsentContext — Phase 4 (v0.4.0).
 *
 * Per-session AI consent modal infrastructure. Renders a single modal at
 * App level; any component triggering an AI action calls
 * `useAiConsent().requestConsent(actionFn)` and the provider either runs
 * the action immediately (if already consented this session) or shows
 * the modal first.
 *
 * Two storage layers:
 *   - `sessionStorage` flag — per-tab "consented this session" gate. Reset
 *     when the user closes the tab or browser. Drives the modal re-prompt.
 *   - Server-side `User.aiConsentDismissedAt` — bumped via POST
 *     /api/auth/ai-consent. Server stays happy permanently once set; this
 *     is what lets the brief / ingest / signature / ask endpoints succeed.
 *
 * Persistent opt-out (`User.aiConsentSilenced`) lives in /api/auth/me and
 * is consulted client-side: when true, the modal never appears and the
 * `requestConsent` path runs the action straight through.
 *
 * Wire-up:
 *   - <AiConsentProvider> wraps the app in App.jsx (inside AuthProvider).
 *   - <AiConsentModal /> renders inline; the provider keeps the modal
 *     state in context and the modal subscribes.
 *   - Components: const { requestConsent } = useAiConsent();
 *                 requestConsent(() => doActualAiCall());
 */

import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useAuth } from './AuthContext';

const API = import.meta.env.VITE_API_URL || '/api';
const SESSION_KEY = 'lapseiq_ai_consent_session';

const AiConsentContext = createContext(null);

export function AiConsentProvider({ children }) {
  const { user, aiProvider, aiConsentVersion } = useAuth();

  // pendingAction: { run: () => void } | null
  // When non-null, the modal is open and waiting for the user's acknowledgment.
  const [pendingAction, setPendingAction] = useState(null);

  // sessionAcknowledged: tracks whether THIS browser tab has already
  // seen the modal this session. Read once from sessionStorage on mount;
  // toggled via the modal acknowledgment handler.
  const [sessionAcknowledged, setSessionAcknowledged] = useState(() => {
    try { return sessionStorage.getItem(SESSION_KEY) === 'true'; }
    catch { return false; }
  });

  // The server is permanently happy once aiConsentDismissedAt is set on
  // the user row. We trust /api/auth/me's response on this.
  const serverHasConsent  = !!user?.aiConsentDismissedAt;
  const persistentlySilenced = !!user?.aiConsentSilenced;

  // requestConsent(action) — the public API every AI-triggering button
  // calls. If consent is satisfied (silenced OR this-session-ack'd),
  // runs action immediately. Else opens the modal; action runs after
  // acknowledgment.
  const requestConsent = useCallback((action) => {
    if (typeof action !== 'function') return;
    if (persistentlySilenced || sessionAcknowledged) {
      // Belt-and-suspenders: if the server doesn't yet know about consent
      // (first-ever AI use after silencing) we still POST so the server
      // gate is satisfied next time. Best-effort; don't block on it.
      if (!serverHasConsent) {
        // Pass-4 audit L3-07/L3-08: send the version+provider we last
        // saw via /api/auth/me so the server can drift-check next call.
        fetch(`${API}/auth/ai-consent`, {
          method:  'POST',
          headers: {
            Authorization: `Bearer ${localStorage.getItem('lapseiq_token')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ version: aiConsentVersion, provider: aiProvider }),
        }).catch(() => {});
      }
      action();
      return;
    }
    setPendingAction({ run: action });
  }, [sessionAcknowledged, persistentlySilenced, serverHasConsent, aiConsentVersion, aiProvider]);

  // acknowledge() — called by the modal's primary button. Sets the
  // session flag, posts to the server (idempotent timestamp bump), and
  // runs the deferred action.
  const acknowledge = useCallback(async () => {
    try { sessionStorage.setItem(SESSION_KEY, 'true'); } catch { /* sandboxed iframes etc. */ }
    setSessionAcknowledged(true);
    // Fire-and-forget the server record. If it fails, the user has still
    // ack'd locally for this session — the next AI call will surface the
    // server-side 403 ai_consent_required and trigger re-prompt.
    try {
      await fetch(`${API}/auth/ai-consent`, {
        method:  'POST',
        headers: {
          Authorization: `Bearer ${localStorage.getItem('lapseiq_token')}`,
          'Content-Type': 'application/json',
        },
        // Pass-4 audit L3-07/L3-08: send the version+provider we showed
        // the user so the server can drift-check next call.
        body: JSON.stringify({ version: aiConsentVersion, provider: aiProvider }),
      });
    } catch { /* swallow; see comment above */ }
    const action = pendingAction?.run;
    setPendingAction(null);
    if (typeof action === 'function') action();
  }, [pendingAction, aiConsentVersion, aiProvider]);

  // cancel() — closes the modal without acknowledging. Does not run
  // the deferred action.
  const cancel = useCallback(() => {
    setPendingAction(null);
  }, []);

  // If the user logs out / changes account, clear local session
  // acknowledgment so the next user starts fresh.
  //
  // H7 fix (2026-05-12): only clear on a REAL logout transition —
  // i.e. we'd previously seen a logged-in user and now user is null.
  // Without the ref guard, this effect fired on every initial mount
  // (because <AuthProvider> renders with user=null while /api/auth/me
  // is in flight), wiping sessionStorage every page load and forcing
  // the consent modal to re-prompt — defeating the once-per-session
  // promise the modal copy makes to the user.
  const sawAuthedUserRef = useRef(false);
  useEffect(() => {
    if (user) {
      sawAuthedUserRef.current = true;
      return;
    }
    if (!sawAuthedUserRef.current) {
      // Initial null while auth is hydrating. Don't touch session state.
      return;
    }
    // Real logout transition: had a user, now don't.
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    setSessionAcknowledged(false);
    setPendingAction(null);
    sawAuthedUserRef.current = false;
  }, [user?.id]);

  const value = useMemo(() => ({
    requestConsent,
    acknowledge,
    cancel,
    isOpen:                 !!pendingAction,
    sessionAcknowledged,
    persistentlySilenced,
  }), [requestConsent, acknowledge, cancel, pendingAction, sessionAcknowledged, persistentlySilenced]);

  return (
    <AiConsentContext.Provider value={value}>
      {children}
    </AiConsentContext.Provider>
  );
}

export function useAiConsent() {
  const ctx = useContext(AiConsentContext);
  if (!ctx) throw new Error('useAiConsent must be used within AiConsentProvider');
  return ctx;
}
