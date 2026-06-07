/**
 * useAiUsage — small hook for the demo AI quota helper line.
 *
 * v0.32.4. Reads GET /api/ai/usage/me on mount and exposes:
 *   - usage: { demoMode, actions: { ingest_extract, ask, maintenance_brief, narrate } }
 *   - loading, error
 *   - refresh() — manual re-fetch (e.g. after a successful AI call so the
 *     helper line ticks down without a page reload)
 *
 * v0.36.7 (Pass-6 W2 MT-020): optional `{ enabled }` param.
 *
 *   Pre-fix, the hook always fetched on mount. AiConsentModal calls this
 *   hook but only renders when `isOpen` — so the hook fired the request on
 *   every public-route mount (login screen, marketing-side embedded
 *   pages), generating an "unauth probe storm" against /api/ai/usage/me
 *   that produced 401s and tripped the 401-loop redirect heuristics.
 *
 *   The new `enabled` param defaults to true (backward-compatible for
 *   AiCapHelper, which is rendered conditionally inside AI input boxes
 *   and SHOULD fetch immediately). When `enabled=false`, the effect
 *   does not run — the hook returns { usage: null, loading: false,
 *   error: null, refresh } so consumers see a clean idle state.
 *
 * The endpoint is cheap to call (no AI work, just a Prisma read of the
 * AiUsage row). Self-host returns cap=null/INF and the renderer suppresses
 * the helper line in that case.
 */

import { useEffect, useState, useCallback } from 'react';
import api from '../api/client';

export function useAiUsage({ enabled = true } = {}) {
  const [usage,   setUsage]   = useState(null);
  // v0.36.7: when disabled, loading starts false (idle), not true.
  // Consumers (AiCapHelper) gate on `loading` to avoid flashing wrong
  // numbers; idle should not look like in-flight.
  const [loading, setLoading] = useState(enabled);
  const [error,   setError]   = useState(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get('/api/ai/usage/me');
      setUsage(res.data?.data || null);
      setError(null);
    } catch (e) {
      setError(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
  }, [enabled, refresh]);

  return { usage, loading, error, refresh };
}
