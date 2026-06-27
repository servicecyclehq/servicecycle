import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// SECURITY NOTE — see docs/security/findings.csv (F002 / F003)
//   Vite 5.x dev-server has CVE-2026-39365 (.map path traversal) and the
//   esbuild dev-server has GHSA-67mh-4wv8-2f99 (CORS wildcard). BOTH are
//   dev-server-only — `vite preview` (used by docker-compose.yml in prod)
//   is unaffected because it skips the transform middleware. We accept
//   the dev-only risk because:
//     - production deployments use `vite build && vite preview` or the
//       nginx-served `client/Dockerfile.prod` static stage,
//     - the major-version bump to vite 7 is a separate piece of work
//       gated on the React 18 -> 19 / dependency refresh pass.
//   IF you run `vite dev` (i.e. `npm run dev`) on an untrusted network,
//   set `host: '127.0.0.1'` here or pass `--host=127.0.0.1` on the CLI
//   to take the dev server off the LAN.

// v0.47 perf — route-aware modulepreload
//
// Why: every route in App.jsx is React.lazy() so its chunk only starts
// downloading AFTER the React shell parses + executes + hits the lazy()
// import. On /contracts that's one full RTT of latency we don't need —
// the browser could be fetching the ContractsList chunk in parallel with
// the entry JS.
//
// What this plugin does: after the production build, it reads the emitted
// asset filenames and injects a tiny inline script into index.html. On
// page load, the script reads location.pathname and synchronously injects
// a <link rel="modulepreload"> tag for the chunk matching that route,
// BEFORE React even mounts. The chunk download now races with the entry
// JS parse instead of waiting behind it.
//
// Scope: priority routes only — /contracts (the one v0.47 perf work
// targets) and /dashboard (the most-frequent landing route). Adding more
// is cheap; over-preloading is fine because HTTP/2 multiplexes the
// streams and the gzip-tiny route chunks are well under 30 KB.
//
// Risk: if a chunk isn't found in the bundle (e.g. tree-shaken out, file
// renamed), the script no-ops. modulepreload misses are warnings in
// devtools, not errors — never a failure mode.
function routeModulePreloadPlugin() {
  // Map of pathname (exact match) -> page module name prefix to look up in the
  // build bundle. Vite emits e.g. `ContractsList-<hash>.js` for the lazy-
  // imported pages/ContractsList.jsx.
  const ROUTE_TO_CHUNK_PREFIX = {
    '/contracts': 'ContractsList',
    '/dashboard': 'Dashboard',
  };
  const PRELOAD_FILE = 'route-preload.js';

  // v0.92.3: EXTERNALIZED (was an inline <script> in index.html). The demo
  // CSP is `script-src 'self'` with no hashes; an inline script whose body
  // embeds per-build hashed chunk filenames cannot get a stable sha256, so we
  // emit the preload logic as a same-origin /route-preload.js asset instead.
  // 'self' covers it, and there is zero hash to keep in sync. See
  // reference_servicecycle_csp_topology in memory + the v0.5.4 "no CSS @import in
  // the JS entry" lesson (this is a static asset, not a module import).
  return {
    name: 'route-module-preload',
    apply: 'build',
    // Compute the route->chunk map and emit the external file during
    // generateBundle, where the Rollup plugin context + this.emitFile exist.
    generateBundle(_options, bundle) {
      const map = {};
      for (const [routePath, prefix] of Object.entries(ROUTE_TO_CHUNK_PREFIX)) {
        const fileKey = Object.keys(bundle).find((k) =>
          new RegExp(`(^|/)${prefix}-[\\w-]+\\.js$`).test(k)
        );
        if (fileKey) map[routePath] = '/' + fileKey;
      }
      const source =
        '(function(){try{' +
        'var routes=' + JSON.stringify(map) + ';' +
        'var path=window.location.pathname;' +
        "if(path.length>1&&path.charAt(path.length-1)==='/'){path=path.slice(0,-1);}" +
        'var chunk=routes[path];' +
        'if(chunk){var link=document.createElement("link");link.rel="modulepreload";link.href=chunk;document.head.appendChild(link);}' +
        '}catch(e){}})();\n';
      this.emitFile({ type: 'asset', fileName: PRELOAD_FILE, source });
    },
    // Inject a static same-origin <script src> tag (no inline body -> CSP ok).
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const tag = `    <script src="/${PRELOAD_FILE}"></script>`;
        if (html.includes('</head>')) {
          return html.replace('</head>', tag + '\n  </head>');
        }
        return html + tag;
      },
    },
  };
}

// v0.90.4: stamp the client's build version into a <meta> tag so the running
// app can detect version skew (server SERVICECYCLE_VERSION moves ahead of what
// this bundle reports -> show a "New version available -- reload" toast).
function buildIdMetaPlugin() {
  const pkg = require('./package.json');
  return {
    name: 'servicecycle-build-id-meta',
    transformIndexHtml(html) {
      return html
        .replace('%SERVICECYCLE_BUILD_ID%', 'v' + pkg.version)
        .split('%BOOTSTRAP_VER%').join(pkg.version);
    },
  };
}

// PWA — installable app + offline support for field technicians.
//
// Strategy:
//   - Precache (workbox generateSW default): the built JS/CSS/HTML shell, so
//     the app loads with zero network. registerType 'autoUpdate' = new SW
//     activates immediately and the v0.90.4 build-id toast handles telling
//     the user a reload is worthwhile.
//   - Runtime NetworkFirst for the read-mostly field API GETs (1h cap): fresh
//     when online, last-known-good when offline. NON-GET requests are NEVER
//     cached — offline mutations go through src/lib/outbox.js instead.
//   - navigateFallback serves index.html for SPA deep links offline, but /api
//     is excluded so API requests never get swallowed by the shell.
//
// PWA icons are generated from public/icons/icon.svg via
// `node scripts/generate-pwa-icons.mjs`. Replace icon.svg to regen them.
function pwaPlugin() {
  return VitePWA({
    registerType: 'autoUpdate',
    // SW registration is imported in src/main.jsx via the virtual module.
    // Dev mode keeps the SW OFF so HMR + the dev proxy behave normally.
    devOptions: { enabled: false },
    manifest: {
      name: 'ServiceCycle',
      short_name: 'ServiceCycle',
      description: 'Electrical maintenance compliance',
      display: 'standalone',
      start_url: '/field',
      scope: '/field/',
      theme_color: '#0f172a',
      background_color: '#0f172a',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    },
    workbox: {
      // registerType 'autoUpdate' already injects skipWaiting + clientsClaim, but
      // state them explicitly + clean up superseded precaches so a new deploy
      // takes over on the next load instead of waiting for every tab to close
      // (the "did it update?" dance).
      skipWaiting: true,
      clientsClaim: true,
      cleanupOutdatedCaches: true,
      // SPA offline deep-links — but never intercept API navigations/requests.
      navigateFallback: 'index.html',
      navigateFallbackDenylist: [/^\/api/],
      runtimeCaching: [
        {
          // Read-path field data: GET-only NetworkFirst, 1h freshness cap.
          // Static assets are CacheFirst by virtue of the precache manifest.
          //
          // COMP-8-4: the "works offline in the field" pitch previously cached
          // only the asset list + sites + bootstrap, so a tech who lost signal
          // in a switchgear room couldn't open a WORK ORDER, see a maintenance
          // SCHEDULE, or check PARTS/SPARES — the exact field scenario marketed.
          // Added /api/work-orders, /api/schedules, /api/parts to the read cache.
          // Still GET-ONLY and NetworkFirst (fresh when online, last-known-good
          // offline); non-GET mutations are never cached — they go through the
          // outbox. NetworkFirst means an authenticated read always re-validates
          // against the server when online, so a stale/foreign-tenant response
          // can't be served while connectivity exists; the 1h cap + 200-only
          // bound staleness and keep error/401 responses out of the cache.
          urlPattern: ({ url, request }) =>
            request.method === 'GET' &&
            url.origin === self.location.origin &&
            (url.pathname.startsWith('/api/field/') ||
              url.pathname === '/api/bootstrap' ||
              url.pathname.startsWith('/api/assets') ||
              url.pathname.startsWith('/api/sites') ||
              url.pathname.startsWith('/api/work-orders') ||
              url.pathname.startsWith('/api/schedules') ||
              url.pathname.startsWith('/api/parts')),
          handler: 'NetworkFirst',
          method: 'GET', // belt + braces: never cache non-GET
          options: {
            cacheName: 'api-cache',
            expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 },
            cacheableResponse: { statuses: [200] },
          },
        },
      ],
    },
  });
}

export default defineConfig({
  plugins: [react(), buildIdMetaPlugin(), routeModulePreloadPlugin(), pwaPlugin()],

  // Strip console.* and debugger from production bundles via esbuild.
  // Audit-7 launch-readiness fix: Vite's default prod minifier (esbuild)
  // does NOT drop console.log automatically. Without this, info-leak risk
  // + bundle bloat on every emitted chunk. Applies only to `vite build`
  // (production) because esbuild.drop is a global esbuild option but
  // dev-server uses esbuild only for dep pre-bundling, not source files.
  // Verification: `grep -r "console\\.log" client/dist/assets/*.js` should
  // return zero matches after a prod build.
  esbuild: {
    drop: ['console', 'debugger'],
  },

  server: {
    port: 5173,
    host: true, // Required for Docker. See SECURITY NOTE above.
    // Local dev proxy: the client uses relative /api/* URLs (empty baseURL —
    // see src/api/client.js), which production fronts with Caddy. In bare
    // `vite dev` there is no reverse proxy, so forward /api to the local
    // API server. Override target with VITE_DEV_API_TARGET if your API runs
    // on a different port.
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_TARGET || 'http://localhost:3001',
        changeOrigin: false,
      },
    },
    watch: {
      // Use polling on Windows for reliable hot-reload through Docker volume mounts
      usePolling: true,
      interval: 1000,
    },
    fs: {
      // Allow reading from the repo root (one level above client/) so the
      // legal page wrappers can `import ... from '../../../legal/*.md?raw'`
      // and use the markdown drafts as the single source of truth. Without
      // this, Vite dev-server blocks the read for security; the prod build
      // resolves imports at build time and isn't affected.
      allow: ['..'],
    },
  },
});