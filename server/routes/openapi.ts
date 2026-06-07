/**
 * routes/openapi.js — public OpenAPI 3 spec + Swagger UI mount.
 *
 *   GET /api/v1/openapi.json   — parsed spec as JSON (machine-readable)
 *   GET /api/v1/openapi.yaml   — raw YAML for tools that prefer it
 *   GET /docs/api              — interactive Swagger UI for humans
 *   GET /docs/api/assets/*     — bundled swagger-ui-dist static assets
 *
 * Public — NO auth required. Integrators need to read API docs before
 * they have an API key. The v1 routes themselves still require auth via
 * the apiKeyAuth middleware; this only exposes the *description* of those
 * routes, not the data behind them.
 *
 * Rate-limit posture: per-route limiter at 30/min/IP - generous enough
 * for a Swagger UI page that triggers a handful of spec fetches on
 * initial paint, but caps a hostile script polling the spec.
 *
 * v0.37.1 W5 MT-128 — initial route shipped with cdnjs CDN load + made-up SRI hashes.
 * v0.37.2 W6 followup — SRI hashes dropped (I couldn't verify them from
 *   the build env; shipping wrong hashes would silently break the page).
 * v0.37.3 W6 followup — swagger-ui-dist now bundled as a server npm
 *   dependency + served from node_modules via express.static. Removes
 *   the cdnjs dependency entirely (no external load, no SRI concern,
 *   works on air-gapped self-hosts), simpler CSP, smaller surface.
 *
 * Exports `register(app)` — call once during server boot to wire all
 * handlers. The two URL trees (`/api/v1/openapi.*` and `/docs/api`)
 * don't share a prefix, so a single express.Router with relative paths
 * cannot mount both; the setup-function pattern keeps the wiring in one
 * file without forcing two router exports.
 */

'use strict';

const path      = require('path');
const express   = require('express');
const rateLimit = require('express-rate-limit');
const openapi   = require('../lib/openapiRegistry');

// Resolve the bundled swagger-ui-dist asset directory once at module load.
// require.resolve() throws if the dep isn't installed, which we catch + log
// so a misbuilt image surfaces clearly instead of 404ing at request time.
let SWAGGER_UI_DIST_DIR = null;
try {
  // require.resolve points at the package's entry index.js; the dirname
  // is the directory we want to serve via express.static.
  SWAGGER_UI_DIST_DIR = path.dirname(require.resolve('swagger-ui-dist'));
} catch (err) {
  console.warn('[openapi] swagger-ui-dist not installed — /docs/api will 503 until `npm install` runs.');
}

const openapiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { success: false, error: 'Too many openapi requests - try again in a minute.' },
});

// The Swagger UI HTML shell. References to JS/CSS go through our own
// /docs/api/assets/* mount, so there is no external network dependency.
// Inline <style> + the swagger-ui.css below give us the LapseIQ chrome
// header without forking the upstream UI bundle.
const SWAGGER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LapseIQ API - Documentation</title>
  <link
    rel="stylesheet"
    href="/docs/api/assets/swagger-ui.css"
  />
  <style>
    body { margin: 0; padding: 0; background: #fafafa; }
    .topbar { display: none; } /* hide the swagger logo header - LapseIQ chrome is implicit */
    #lapseiq-header {
      background: #0d4f6e;
      color: #fff;
      padding: 14px 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 15px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    #lapseiq-header a { color: #d8eaf2; text-decoration: none; margin-left: auto; font-weight: 500; font-size: 13px; }
    #lapseiq-header a:hover { text-decoration: underline; }
    #lapseiq-header a + a { margin-left: 16px; }
  </style>
</head>
<body>
  <div id="lapseiq-header">
    LapseIQ API - v1 Documentation
    <a href="/api/v1/openapi.json">openapi.json</a>
    <a href="/api/v1/openapi.yaml">openapi.yaml</a>
    <a href="/">&larr; Back to app</a>
  </div>
  <div id="swagger-ui"></div>
  <script src="/docs/api/assets/swagger-ui-bundle.js"></script>
  <script src="/docs/api/assets/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: '/api/v1/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [SwaggerUIBundle.plugins.DownloadUrl],
        layout: 'StandaloneLayout',
        persistAuthorization: true
      });
    };
  </script>
</body>
</html>
`;

function serveSpecJson(req, res) {
  const spec = openapi.getSpec();
  if (!spec) {
    return res.status(503).json({
      success: false,
      error: 'OpenAPI spec is not available on this instance. Run `npm run openapi:sync` and restart the server.',
    });
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.send(JSON.stringify(spec));
}

function serveSpecYaml(req, res) {
  const body = openapi.getYaml();
  if (!body) {
    return res.status(503).type('text/plain').send('OpenAPI spec is not available on this instance.');
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  // RFC 9512: application/yaml is the registered media type as of 2023.
  res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
  return res.send(body);
}

function serveSwaggerUi(req, res) {
  if (!SWAGGER_UI_DIST_DIR) {
    return res.status(503).type('text/plain').send(
      'Swagger UI is not available on this instance. Reinstall server dependencies with `npm install` and restart.'
    );
  }
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Helmet's default CSP would block the inline <script> bootstrap +
  // styled header below. The per-route override is narrow to /docs/api
  // ONLY; rest of the app keeps the stricter default. All script/style
  // sources are now same-origin (we ship swagger-ui-dist ourselves) —
  // no external CDN load, no 'unsafe-inline' on scripts beyond the
  // 5-line bootstrap, simpler attack surface than the CDN approach.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "connect-src 'self'; " +
    "font-src 'self' data:;"
  );
  return res.send(SWAGGER_HTML);
}

/**
 * Wire the openapi routes onto the given express app. Call once at boot,
 * before the authenticated /api/v1/* mounts so the spec endpoints don't
 * get caught by the apiKeyAuth middleware that gates the data routes.
 */
function register(app) {
  app.get('/api/v1/openapi.json', openapiLimiter, serveSpecJson);
  app.get('/api/v1/openapi.yaml', openapiLimiter, serveSpecYaml);
  app.get('/docs/api',            openapiLimiter, serveSwaggerUi);

  // Bundled swagger-ui-dist assets. Mounted only if the dep is installed
  // — otherwise the static handler would 404 every asset request and
  // produce confusing log noise. The express.static `fallthrough: false`
  // option makes a missing asset surface as 404 cleanly.
  if (SWAGGER_UI_DIST_DIR) {
    app.use(
      '/docs/api/assets',
      express.static(SWAGGER_UI_DIST_DIR, {
        index:        false,
        fallthrough:  false,
        maxAge:       '7d',  // assets are version-pinned via package.json; safe to cache aggressively
        immutable:    true,
      })
    );
  }
}

module.exports = { register };

export {};
