// @ts-check
//
// e2e/audit.spec.js â€” ServiceCycle design + a11y audit collector
// ----------------------------------------------------------
//
// Walks every protected route in BOTH light and dark mode. For each
// (route, mode) pair we capture:
//   - a full-page screenshot           â†’ audit-reports/<run>/screenshots/
//   - axe-core a11y violations (JSON)  â†’ audit-reports/<run>/axe/
//   - any console errors / page errors â†’ audit-reports/<run>/console/
//
// This spec is data-collection only. It does NOT pass/fail on findings â€”
// the aggregator in stage 4 reads everything back and decides severity.
//
// Mirrors the auth + route conventions of e2e/smoke.spec.js intentionally
// so the two stay in lockstep. Credentials default to the demo seed admin
// (admin@demo.local / Admin1234!) and the base URL defaults to
// https://servicecycle.app unless E2E_BASE_URL is set.
//
// Theme toggle mechanism (see client/src/components/ThemeToggle.jsx):
//   localStorage['servicecycle_theme'] = 'dark' | 'light'
//   <html data-theme="dark">                  (omitted when light)
// We seed BOTH before navigation so the page never flashes the wrong mode.

const path  = require('path');
const fs    = require('fs');
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

// â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const ADMIN_EMAIL    = process.env.E2E_ADMIN_EMAIL    || 'admin@demo.local';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'Admin1234!';

// Keep this list in lockstep with smoke.spec.js. If you add a route to one,
// add it to the other â€” the canonical audit and the canonical deploy gate
// should cover the same surface.
const PROTECTED_ROUTES = [
  { path: '/dashboard',          title: 'Dashboard'         },
  { path: '/contracts',          title: 'Contracts'         },
  { path: '/contracts/archived', title: 'Archived'          },
  { path: '/vendors',            title: 'Vendors'           },
  { path: '/budget',             title: 'Budget'            },
  { path: '/reports',            title: 'Reports'           },
  { path: '/alerts',             title: 'Alerts'            },
  { path: '/news',               title: 'News'              },
  { path: '/activity',           title: 'Activity Log'      },
  { path: '/settings',           title: 'Settings'          },
  { path: '/profile',            title: 'Profile'           },
];

const MODES = ['light', 'dark'];

const AUDIT_REPORTS_DIR = path.resolve(__dirname, '..', 'audit-reports');

// â”€â”€ Shared state (populated in beforeAll) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let authToken    = null;
let serverVersion = null;
let runDir       = null;
let runId        = null;

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function safeRouteSlug(routePath) {
  // /contracts/archived â†’ contracts__archived ; / â†’ root
  if (!routePath || routePath === '/') return 'root';
  return routePath.replace(/^\//, '').replace(/\//g, '__');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function tsForFolder() {
  // 2026-05-26T22-30-15Z â€” Windows-safe (no colons)
  return new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
}

async function seedAuthAndTheme(page, baseURL, mode) {
  // Land somewhere harmless on origin so localStorage is writable, then seed
  // both auth + theme keys at once. The pre-React bootstrap in index.html
  // reads servicecycle_theme and applies the data-theme attribute synchronously
  // before the SPA mounts, so we'll never see a flash of the wrong mode on
  // the subsequent navigation.
  await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([t, m]) => {
    try { window.localStorage.setItem('servicecycle_token', t); } catch (_) {}
    try { window.localStorage.setItem('servicecycle_theme', m); } catch (_) {}
    if (m === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else              document.documentElement.removeAttribute('data-theme');
  }, [authToken, mode]);
}

// â”€â”€ Run-scoped setup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

test.beforeAll(async ({ request, baseURL }) => {
  // 1. Detect deployed version via the unauthed liveness endpoint.
  let versionStr = 'unknown';
  try {
    const h = await request.get(`${baseURL}/api/health`);
    if (h.ok()) {
      const j = await h.json();
      versionStr = (j && j.data && j.data.version) || 'unknown';
    }
  } catch (_) { /* tolerate; runId just won't have a clean version label */ }
  serverVersion = versionStr;

  // 2. Build the run directory: audit-reports/<version>-<timestamp>/
  runId  = `${versionStr}-${tsForFolder()}`;
  runDir = path.join(AUDIT_REPORTS_DIR, runId);
  ensureDir(path.join(runDir, 'screenshots'));
  ensureDir(path.join(runDir, 'axe'));
  ensureDir(path.join(runDir, 'console'));
  ensureDir(path.join(runDir, 'lighthouse'));
  ensureDir(path.join(runDir, 'gemini'));

  // 3. Authenticate as the demo admin so localStorage seeding gives the SPA
  //    a valid bearer token.
  const res = await request.post(`${baseURL}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(res.status(), `login failed for ${ADMIN_EMAIL}`).toBe(200);
  const json = await res.json();
  authToken = (json && json.data && json.data.token) || json.token;
  expect(authToken, 'login returned no token').toBeTruthy();

  // 4. Persist a manifest the downstream stages (Lighthouse, aggregator)
  //    consume. .latest-run is the breadcrumb the npm pipeline reads.
  const manifest = {
    runId,
    version:    serverVersion,
    timestamp:  nowIso(),
    baseURL,
    adminEmail: ADMIN_EMAIL,
    authToken,                  // localhost-only artifact; gitignored
    modes:  MODES,
    routes: PROTECTED_ROUTES,
  };
  fs.writeFileSync(path.join(runDir, 'manifest.json'),  JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(AUDIT_REPORTS_DIR, '.latest-run'), runId);

  console.log(`[audit] run ${runId} prepared (version=${serverVersion})`);
});

// â”€â”€ Per-route, per-mode collection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

for (const route of PROTECTED_ROUTES) {
  for (const mode of MODES) {
    const slug = safeRouteSlug(route.path);
    const tag  = `${slug}-${mode}`;

    test(`collect ${route.path} [${mode}]`, async ({ page, baseURL }) => {
      const consoleEvents = [];
      const networkErrors = [];
      const pageErrors    = [];

      page.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
          consoleEvents.push({
            type: msg.type(),
            text: msg.text(),
            url:  msg.location().url,
          });
        }
      });
      page.on('pageerror', (err) => {
        pageErrors.push({ message: err.message, stack: err.stack || null });
      });
      page.on('response', (resp) => {
        // Track API 5xx â€” UI-rendering 5xx (e.g. SSR) won't fire here for an SPA
        // but XHR/fetch 5xx from the page do. The aggregator surfaces these.
        if (resp.status() >= 500 && resp.url().includes('/api/')) {
          networkErrors.push({ url: resp.url(), status: resp.status() });
        }
      });

      await seedAuthAndTheme(page, baseURL, mode);
      await page.goto(`${baseURL}${route.path}`, { waitUntil: 'networkidle', timeout: 45000 });

      // Allow lazy components, charts, fonts, etc. to settle. networkidle
      // alone is too aggressive â€” recharts often paints after.
      await page.waitForTimeout(800);

      // Screenshot full page in current mode. PNG, full-page (not viewport).
      const screenshotPath = path.join(runDir, 'screenshots', `${tag}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      // axe-core scan. We disable the color-contrast rule's experimental
      // bits via tags filter so output stays deterministic across runs.
      let axeResults = null;
      try {
        axeResults = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
      } catch (err) {
        axeResults = { error: String((err && err.message) || err) };
      }
      fs.writeFileSync(
        path.join(runDir, 'axe', `${tag}.json`),
        JSON.stringify({
          route: route.path,
          mode,
          url:       page.url(),
          analyzed:  nowIso(),
          violations: (axeResults && axeResults.violations) || [],
          incomplete: (axeResults && axeResults.incomplete) || [],
          error:      axeResults && axeResults.error || null,
        }, null, 2),
      );

      // Console + network sidecar â€” useful signal even though we never fail
      // the test on it. The aggregator surfaces meaningful entries.
      fs.writeFileSync(
        path.join(runDir, 'console', `${tag}.json`),
        JSON.stringify({
          route: route.path,
          mode,
          captured: nowIso(),
          consoleEvents,
          pageErrors,
          networkErrors,
        }, null, 2),
      );

      // Soft assertion â€” we'd like to know if a route 404'd or boundaried
      // without failing the whole audit run. Print a warning but pass.
      const bodyLen = ((await page.locator('body').innerText()) || '').trim().length;
      if (bodyLen < 20) {
        console.warn(`[audit] WARN ${route.path} [${mode}] rendered empty (len=${bodyLen})`);
      }
      const boundaryCount = await page.getByRole('heading', { name: /Something went wrong/i }).count();
      if (boundaryCount > 0) {
        console.warn(`[audit] WARN ${route.path} [${mode}] ErrorBoundary fired`);
      }
    });
  }
}