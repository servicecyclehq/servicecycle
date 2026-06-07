// server/scripts/run-lighthouse.js
// --------------------------------
//
// Runs Lighthouse in accessibility + performance mode against every
// (route, mode) pair recorded in audit-reports/.latest-run/manifest.json.
//
// Lighthouse v10+ is ESM-only, so we use dynamic import from this CJS file.
// chrome-launcher and puppeteer-core stay CJS-compatible.
//
// Auth strategy: launch one Chrome instance via chrome-launcher, then before
// each Lighthouse audit attach puppeteer-core, seed localStorage with the
// admin bearer token + theme, detach, and let Lighthouse drive a fresh
// navigation with `disableStorageReset: true` so the seed survives.
//
// Output: audit-reports/<run>/lighthouse/<route>-<mode>.json containing the
// trimmed-down Lighthouse Report (LHR). We strip out screenshots,
// full traces, and devtoolsLogs to keep file sizes sane â€” the audit-bot
// already has its own Playwright screenshots.

const fs   = require('fs');
const path = require('path');

const AUDIT_REPORTS_DIR = path.resolve(__dirname, '..', '..', 'audit-reports');

function safeRouteSlug(routePath) {
  if (!routePath || routePath === '/') return 'root';
  return routePath.replace(/^\//, '').replace(/\//g, '__');
}

function readManifest() {
  const latestFile = path.join(AUDIT_REPORTS_DIR, '.latest-run');
  if (!fs.existsSync(latestFile)) {
    throw new Error(`No .latest-run breadcrumb found at ${latestFile}. Did the Playwright collector run first?`);
  }
  const runId = fs.readFileSync(latestFile, 'utf8').trim();
  const runDir = path.join(AUDIT_REPORTS_DIR, runId);
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest missing at ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return { runId, runDir, manifest };
}

// Slim down the LHR so we don't carry ~5MB of trace data per route into git.
// Keep enough for the aggregator to summarise scores + failing audits.
function slimLhr(lhr) {
  if (!lhr || typeof lhr !== 'object') return lhr;
  const slim = {
    requestedUrl: lhr.requestedUrl,
    finalUrl:     lhr.finalUrl,
    fetchTime:    lhr.fetchTime,
    lighthouseVersion: lhr.lighthouseVersion,
    userAgent:    lhr.userAgent,
    categories:   {},
    audits:       {},
    runtimeError: lhr.runtimeError || null,
    runWarnings:  lhr.runWarnings  || [],
  };
  for (const [cat, body] of Object.entries(lhr.categories || {})) {
    slim.categories[cat] = {
      id:          body.id,
      title:       body.title,
      score:       body.score,
      auditRefs:   (body.auditRefs || []).map((r) => ({ id: r.id, weight: r.weight, group: r.group })),
    };
  }
  // Only keep audits referenced by a category (skip noise).
  const referenced = new Set();
  for (const cat of Object.values(slim.categories)) {
    for (const r of cat.auditRefs) referenced.add(r.id);
  }
  for (const [auditId, body] of Object.entries(lhr.audits || {})) {
    if (!referenced.has(auditId)) continue;
    slim.audits[auditId] = {
      id:           body.id,
      title:        body.title,
      description:  body.description,
      score:        body.score,
      scoreDisplayMode: body.scoreDisplayMode,
      displayValue: body.displayValue || null,
      numericValue: body.numericValue || null,
      // Compact the details object â€” keep items/headings if present, drop screenshots.
      details: body.details
        ? {
            type:     body.details.type,
            headings: body.details.headings,
            items:    Array.isArray(body.details.items)
              ? body.details.items.slice(0, 30).map((item) => {
                  const cp = {};
                  for (const [k, v] of Object.entries(item)) {
                    if (k === 'snippet' && typeof v === 'string' && v.length > 400) {
                      cp[k] = v.slice(0, 400) + 'â€¦ [truncated]';
                    } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
                      cp[k] = v;
                    } else if (v && typeof v === 'object' && v.value !== undefined) {
                      cp[k] = v.value;
                    } else {
                      cp[k] = '[object]';
                    }
                  }
                  return cp;
                })
              : undefined,
          }
        : null,
    };
  }
  return slim;
}

async function seedStorage(chromePort, baseURL, authToken, mode) {
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${chromePort}`,
    defaultViewport: null,
  });
  try {
    const page = await browser.newPage();
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.evaluate(([t, m]) => {
      try { window.localStorage.setItem('lapseiq_token', t); } catch (_) {}
      try { window.localStorage.setItem('lapseiq_theme', m); } catch (_) {}
      if (m === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
      else              document.documentElement.removeAttribute('data-theme');
    }, [authToken, mode]);
    await page.close();
  } finally {
    // Detach (don't close â€” Lighthouse still wants the browser).
    browser.disconnect();
  }
}

async function main() {
  const { runId, runDir, manifest } = readManifest();
  const lhrDir = path.join(runDir, 'lighthouse');
  fs.mkdirSync(lhrDir, { recursive: true });

  console.log(`[lighthouse] runId=${runId}`);
  console.log(`[lighthouse] target=${manifest.baseURL}`);
  console.log(`[lighthouse] routes=${manifest.routes.length} modes=${manifest.modes.length}`);

  // ESM imports for lighthouse + chrome-launcher v1.x.
  const lighthouse     = (await import('lighthouse')).default;
  const chromeLauncher = await import('chrome-launcher');

  const chrome = await chromeLauncher.launch({
    chromeFlags: [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1440,900',
    ],
    logLevel: 'silent',
  });
  console.log(`[lighthouse] chrome launched on port ${chrome.port}`);

  const summary = [];

  try {
    for (const route of manifest.routes) {
      for (const mode of manifest.modes) {
        const tag = `${safeRouteSlug(route.path)}-${mode}`;
        const url = `${manifest.baseURL}${route.path}`;
        const outPath = path.join(lhrDir, `${tag}.json`);

        console.log(`[lighthouse] ${tag} â†’ ${url}`);
        try {
          await seedStorage(chrome.port, manifest.baseURL, manifest.authToken, mode);

          const result = await lighthouse(url, {
            port: chrome.port,
            output: 'json',
            logLevel: 'error',
            onlyCategories: ['accessibility', 'performance'],
            disableStorageReset: true,        // preserve our seeded token+theme
            formFactor: 'desktop',
            screenEmulation: {
              mobile: false,
              width:  1440,
              height: 900,
              deviceScaleFactor: 1,
              disabled: false,
            },
            throttlingMethod: 'simulate',
          });

          const slim = slimLhr(result.lhr);
          fs.writeFileSync(outPath, JSON.stringify(slim, null, 2));

          const a11y = slim.categories.accessibility ? slim.categories.accessibility.score : null;
          const perf = slim.categories.performance   ? slim.categories.performance.score   : null;
          summary.push({ tag, a11y, perf, error: slim.runtimeError ? slim.runtimeError.code : null });
          console.log(`[lighthouse]   a11y=${a11y != null ? Math.round(a11y * 100) : 'n/a'} perf=${perf != null ? Math.round(perf * 100) : 'n/a'}`);
        } catch (err) {
          const msg = (err && err.message) || String(err);
          console.warn(`[lighthouse]   FAILED ${tag}: ${msg}`);
          fs.writeFileSync(outPath, JSON.stringify({ tag, error: msg }, null, 2));
          summary.push({ tag, a11y: null, perf: null, error: msg });
        }
      }
    }
  } finally {
    // Persist summary BEFORE chrome.kill() so a destroyTmp EPERM on Windows
    // doesnt swallow the run output. chrome-launcher v1.x occasionally cant
    // clean up its temp dir on Windows because the Chrome process is still
    // releasing handles; we tolerate that and continue.
    try {
      fs.writeFileSync(path.join(lhrDir, '_summary.json'), JSON.stringify(summary, null, 2));
      console.log(`[lighthouse] done -- ${summary.length} audits written to ${lhrDir}`);
    } catch (err) {
      console.warn(`[lighthouse] summary write failed: ${(err && err.message) || err}`);
    }
    try { await chrome.kill(); }
    catch (err) {
      console.warn(`[lighthouse] chrome.kill() non-fatal warning: ${(err && err.message) || err}`);
    }
  }
}

main().catch((err) => {
  console.error(`[lighthouse] fatal: ${(err && err.stack) || err}`);
  process.exit(1);
});