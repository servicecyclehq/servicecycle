// ─────────────────────────────────────────────────────────────────────────────
// ChunkErrorBoundary.jsx — self-heal a stale-bundle ChunkLoadError (Block 1 #6).
//
// After a deploy, the PWA service worker can keep serving an old index/bundle
// whose lazy-chunk filenames the freshly deployed server no longer has. When a
// route then code-splits to one of those chunks, React throws a ChunkLoadError
// and — with no boundary — the app white-screens. This boundary catches ONLY
// that class of error, unregisters the service worker, clears caches, and hard-
// reloads ONCE (guarded by a URL flag so it can never loop). Any non-chunk error
// is re-thrown so existing behavior/outer boundaries are unchanged.
//
// Report downloads are exactly where this used to bite (a returning tab mid-
// deploy), so the boundary wraps the whole routed app in App.jsx.
// ─────────────────────────────────────────────────────────────────────────────

import { Component } from 'react';

const RELOAD_FLAG = 'sc_chunk_reloaded';

function isChunkError(err) {
  if (!err) return false;
  const msg = err.message || String(err);
  const name = err.name || '';
  return (
    name === 'ChunkLoadError' ||
    /ChunkLoadError/i.test(msg) ||
    /Loading chunk [\w-]+ failed/i.test(msg) ||
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg)
  );
}

export default class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    if (!isChunkError(error)) return;
    // Only self-heal once per navigation — the URL flag survives the reload,
    // so a genuinely-missing chunk shows the fallback instead of looping.
    let tried = false;
    try { tried = new URLSearchParams(window.location.search).has(RELOAD_FLAG); } catch (_) { /* noop */ }
    if (tried) return;
    this.selfHeal();
  }

  async selfHeal() {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
      }
    } catch (_) { /* best effort */ }
    try {
      if (window.caches && caches.keys) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k).catch(() => {})));
      }
    } catch (_) { /* best effort */ }
    try {
      const url = new URL(window.location.href);
      url.searchParams.set(RELOAD_FLAG, '1');
      window.location.replace(url.toString());
    } catch (_) {
      window.location.reload();
    }
  }

  render() {
    const { error } = this.state;
    if (error) {
      // Not a chunk error — let it propagate to any outer boundary / default.
      if (!isChunkError(error)) throw error;
      let tried = false;
      try { tried = new URLSearchParams(window.location.search).has(RELOAD_FLAG); } catch (_) { /* noop */ }
      return (
        <div style={{
          minHeight: '60vh', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 12,
          padding: 24, textAlign: 'center',
        }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text)' }}>
            Updating to the latest version…
          </div>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', maxWidth: 440, lineHeight: 1.5 }}>
            {tried
              ? 'A new version of ServiceCycle was just deployed. If this message stays, refresh once more.'
              : 'A newer version just shipped and is loading — this will only take a moment.'}
          </div>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Refresh now
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
