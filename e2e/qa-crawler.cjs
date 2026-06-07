// e2e/qa-crawler.cjs
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// LapseIQ QA crawler â€” v2 (Phase 1 augmented)
//
// Augmentations over v1:
//   1a. axe-core a11y scan on every route (WCAG2A + WCAG2AA, serious/critical)
//   1b. Lighthouse audit on every route (perf / a11y / best-practices / SEO)
//   1c. Mobile viewport second pass (375x667)
//   1d. Visual regression baseline screenshots (fullPage) to outputs/qa-screenshots-baseline/
//   1e. Click-failure root-cause classification (real bug vs locator flakiness)
//
// Fire:  node e2e/qa-crawler.cjs
// Or:    QA_HEADLESS=0 node e2e/qa-crawler.cjs   (headed for debugging)
//
// Output:
//   outputs/qa-day-report-PHASE1-<timestamp>.md
//   outputs/qa-screenshots-baseline/<route>.png
//   outputs/qa-screenshots-<timestamp>/<route>.png   (per-run)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const BASE_URL    = process.env.QA_BASE_URL  || 'https://demo.lapseiq.com';
const EMAIL       = process.env.QA_EMAIL     || 'admin@demo.local';
const PASSWORD    = process.env.QA_PASSWORD  || 'Admin1234!';
const HEADLESS    = process.env.QA_HEADLESS  !== '0';
const SKIP_LH     = process.env.QA_SKIP_LH   === '1'; // set to skip Lighthouse (faster dev iteration)
const MAX_RUNTIME_MS = 120 * 60 * 1000; // 2 hr ceiling (was 90 min; Lighthouse adds time)

const ROUTES_TO_CRAWL = [
  '/dashboard',
  '/contracts',
  '/contracts/archived',
  '/vendors',
  '/budget',
  '/reports',
  '/alerts',
  '/news',
  '/activity',
  '/settings',
  '/profile',
  '/users',
  '/settings#api-keys',
  '/settings#webhooks',
  '/settings#alerts',
  '/settings#consultant',
  '/settings#cloud',
  '/settings#backup',
  '/settings#encryption',
  '/settings#custom-fields',
  '/settings#categories',
  '/settings#ai-caps',
  '/settings#demo-reset',
];

// Routes to run Lighthouse against (skip hash-only settings sub-tabs â€” same HTML)
const LH_ROUTES = [
  '/dashboard',
  '/contracts',
  '/vendors',
  '/budget',
  '/reports',
  '/alerts',
  '/news',
  '/activity',
  '/settings',
  '/profile',
];

const DESTRUCTIVE_RX = /^(Delete|Remove|Sign out|Confirm delete|Reset|Wipe|Trash|Archive|Cancel subscription|Send test|Unarchive|Reset demo|Force re-seed|Rotate|Revoke|Disable|Disconnect|Logout|Log out)$/i;
const DESTRUCTIVE_TITLE_RX = /(delete|remove|wipe|reset|revoke|disconnect)/i;

// â”€â”€ Timestamps â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const startedAt = Date.now();
function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
}
function timeBudget() {
  return MAX_RUNTIME_MS - (Date.now() - startedAt);
}

// â”€â”€ Output directories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const OUTPUTS_DIR      = path.join(__dirname, '..', 'outputs');
const SCREENSHOT_DIR   = path.join(OUTPUTS_DIR, 'qa-screenshots-' + ts());
const BASELINE_DIR     = path.join(OUTPUTS_DIR, 'qa-screenshots-baseline');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
fs.mkdirSync(BASELINE_DIR,   { recursive: true });

// â”€â”€ Findings store â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const findings = {
  meta: { startedAt: new Date().toISOString(), base: BASE_URL, version: 'v2' },
  routes: [],           // per-route desktop results
  mobileRoutes: [],     // per-route mobile results
  lighthouseScores: [], // per-route LH scores
  axeViolations: [],    // aggregated axe violations across all routes
  errors: { console: [], network: [], render: [] },
  click_targets: [],
  modal_dialogs: [],
  clickFailureAnalysis: [], // 1e root-cause
};

// â”€â”€ axe-core source â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const AXE_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'node_modules', 'axe-core', 'axe.min.js'),
  'utf8'
);

// â”€â”€ Lighthouse â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let lighthouse, chromeLauncher;
if (!SKIP_LH) {
  try {
    lighthouse = require('lighthouse');
    chromeLauncher = require('chrome-launcher');
  } catch (e) {
    console.warn('[qa-crawler] lighthouse/chrome-launcher not available â€” skipping LH audits:', e.message);
    lighthouse = null;
    chromeLauncher = null;
  }
}

// â”€â”€ Auth cookie store for Lighthouse â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let authToken = null; // set after login

// â”€â”€ Login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function login(page) {
  await page.goto(BASE_URL + '/login', { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Grab token from localStorage for Lighthouse use
  authToken = await page.evaluate(() => localStorage.getItem('lapseiq_token'));
}

// â”€â”€ Event listeners â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function attachListeners(page) {
  page.on('console', msg => {
    if (msg.type() === 'error') {
      findings.errors.console.push({
        url: page.url(),
        text: msg.text(),
        at: new Date().toISOString(),
      });
    }
  });
  page.on('pageerror', err => {
    findings.errors.render.push({
      url: page.url(),
      name: err.name,
      message: err.message,
      stack: (err.stack || '').slice(0, 1500),
      at: new Date().toISOString(),
    });
  });
  page.on('response', res => {
    const status = res.status();
    const url = res.url();
    if (status >= 400 && !url.includes('/__webpack_hmr')) {
      findings.errors.network.push({
        url: url.replace(BASE_URL, ''),
        status,
        method: res.request().method(),
        page: page.url(),
        at: new Date().toISOString(),
      });
    }
  });
}

// â”€â”€ 1a: axe-core scan â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function runAxe(page, route) {
  try {
    await page.evaluate(AXE_SOURCE);
    const results = await page.evaluate(async () => {
      return await window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] },
        resultTypes: ['violations'],
      });
    });
    const serious = (results.violations || []).filter(v =>
      v.impact === 'serious' || v.impact === 'critical'
    );
    for (const v of serious) {
      findings.axeViolations.push({
        route,
        id: v.id,
        impact: v.impact,
        description: v.description,
        help: v.help,
        helpUrl: v.helpUrl,
        nodes: v.nodes.length,
        nodeSnippet: v.nodes[0]?.html?.slice(0, 200) || '',
      });
    }
    return { total: results.violations.length, serious: serious.length };
  } catch (e) {
    console.warn(`[axe] ${route}: ${e.message}`);
    return { total: 0, serious: 0, error: e.message };
  }
}

// â”€â”€ 1b: Lighthouse â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function runLighthouse(route) {
  if (!lighthouse || !chromeLauncher) return null;
  let chrome;
  try {
    chrome = await chromeLauncher.launch({
      chromeFlags: ['--headless', '--no-sandbox', '--disable-gpu'],
    });
    const url = BASE_URL + route;
    const lhConfig = {
      logLevel: 'error',
      output: 'json',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      port: chrome.port,
      extraHeaders: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    };
    // Support both older (lh(url, flags, config)) and newer (lh(url, options)) API shapes
    let runnerResult;
    try {
      runnerResult = await lighthouse(url, lhConfig);
    } catch (e1) {
      // try the older split-args API
      runnerResult = await lighthouse(url, { port: chrome.port }, {
        extends: 'lighthouse:default',
        settings: { onlyCategories: lhConfig.onlyCategories, output: 'json' },
      });
    }
    const cats = runnerResult.lhr.categories;
    const scores = {
      route,
      performance:    Math.round((cats.performance?.score    || 0) * 100),
      accessibility:  Math.round((cats.accessibility?.score  || 0) * 100),
      bestPractices:  Math.round((cats['best-practices']?.score || 0) * 100),
      seo:            Math.round((cats.seo?.score            || 0) * 100),
      failedAudits: [],
    };
    // Record any failed audits (score < 0.9)
    for (const [id, audit] of Object.entries(runnerResult.lhr.audits)) {
      if (audit.score !== null && audit.score < 0.9 && audit.details?.type !== 'opportunity') {
        scores.failedAudits.push({
          id,
          title: audit.title,
          score: audit.score,
          displayValue: audit.displayValue || '',
        });
      }
    }
    findings.lighthouseScores.push(scores);
    return scores;
  } catch (e) {
    console.warn(`[lighthouse] ${route}: ${e.message}`);
    findings.lighthouseScores.push({ route, error: e.message });
    return null;
  } finally {
    if (chrome) await chrome.kill().catch(() => {});
  }
}

// â”€â”€ Core route crawler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function crawlRoute(page, route, opts = {}) {
  const { mobile = false, saveBaseline = false } = opts;
  if (timeBudget() < 60_000) return { skipped: 'time-budget exhausted' };

  const entry = {
    route,
    mobile,
    errors: [],
    h1: null,
    hasErrorBoundary: false,
    clickedTargets: 0,
    screenshot: null,
    axe: null,
  };
  const url = BASE_URL + route;

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    entry.errors.push('goto-fail: ' + e.message);
    return entry;
  }
  await page.waitForTimeout(1500);

  // ErrorBoundary check
  entry.hasErrorBoundary = await page.evaluate(() =>
    !!document.body.innerText?.match(/Something went wrong|We hit a snag/i)
  );

  // H1
  entry.h1 = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    if (h1) return h1.textContent.trim().slice(0, 100);
    const t = document.querySelector('.page-title');
    if (t) return t.textContent.trim().slice(0, 100);
    return null;
  });

  // Screenshot (viewport)
  const safeRoute = route.replace(/[\/#]/g, '_');
  const prefix = mobile ? 'mobile-' : 'route-';
  const screenshotName = `${prefix}${safeRoute}.png`;
  const screenshotPath = path.join(SCREENSHOT_DIR, screenshotName);
  try {
    await page.screenshot({ path: screenshotPath, fullPage: false });
    entry.screenshot = screenshotName;
  } catch (e) {
    entry.errors.push('screenshot-fail: ' + e.message);
  }

  // 1d: Full-page baseline (desktop pass only, first run)
  if (saveBaseline && !mobile) {
    const baselinePath = path.join(BASELINE_DIR, `${safeRoute}.png`);
    const alreadyExists = fs.existsSync(baselinePath);
    if (!alreadyExists) {
      try {
        await page.screenshot({ path: baselinePath, fullPage: true });
      } catch {}
    }
  }

  // 1a: axe-core (desktop + mobile both)
  if (!entry.hasErrorBoundary) {
    entry.axe = await runAxe(page, (mobile ? '[mobile] ' : '') + route);
  }

  // Clicks (desktop pass only â€” mobile pass is screenshot + axe only)
  if (!mobile && !entry.hasErrorBoundary && timeBudget() > 30_000) {
    const targets = await page.evaluate(() => {
      const sels = ['button', 'a', '[role="button"]'];
      const out = [];
      for (const s of sels) {
        for (const el of document.querySelectorAll(s)) {
          if (el.disabled) continue;
          if (el.closest('form') && el.type === 'submit') continue;
          const text = (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 60);
          const tag  = el.tagName.toLowerCase();
          const href = el.getAttribute('href') || null;
          const title = el.getAttribute('title') || '';
          const rect = el.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) continue;
          if (rect.top > window.innerHeight * 2) continue;
          out.push({ text, tag, href, title });
        }
      }
      return out;
    });

    const seenText = new Set();
    let clicked = 0;
    for (const t of targets) {
      if (timeBudget() < 15_000) break;
      if (clicked >= 25) break;

      const safeText = (t.text || '').trim();
      if (!safeText) continue;
      if (DESTRUCTIVE_RX.test(safeText)) continue;
      if (t.title && DESTRUCTIVE_TITLE_RX.test(t.title)) continue;
      if (seenText.has(safeText)) continue;
      seenText.add(safeText);

      const before = page.url();
      try {
        const locator = page.getByRole('button', { name: safeText }).first()
                          .or(page.getByRole('link', { name: safeText }).first());
        if (!(await locator.isVisible({ timeout: 800 }).catch(() => false))) continue;
        await locator.click({ timeout: 3000 });
        await page.waitForTimeout(800);
        const after = page.url();
        const errorBoundaryAppeared = await page.evaluate(() =>
          !!document.body.innerText?.match(/Something went wrong|We hit a snag/i)
        );
        findings.click_targets.push({
          route, label: safeText, tag: t.tag, href: t.href,
          before, after, navigated: before !== after,
          errorBoundary: errorBoundaryAppeared,
        });
        clicked++;

        if (after !== before && !after.includes('/login')) {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(1000);
        }

        const dialogOpen = await page.evaluate(() =>
          !!document.querySelector('[role="dialog"], .modal-overlay, .modal-backdrop')
        );
        if (dialogOpen) {
          const dialogScreenshot = path.join(SCREENSHOT_DIR, `dialog-${safeRoute}-${clicked}.png`);
          try { await page.screenshot({ path: dialogScreenshot, fullPage: false }); } catch {}
          findings.modal_dialogs.push({ route, opened_by: safeText, screenshot: path.basename(dialogScreenshot) });
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);
          await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(800);
        }
      } catch (e) {
        const errMsg = e.message.slice(0, 200);
        // 1e: root-cause classification
        const classification = classifyClickFailure(t, errMsg);
        findings.click_targets.push({
          route, label: safeText, tag: t.tag,
          before, after: before, navigated: false,
          errorBoundary: false, click_failed: errMsg,
          failureClass: classification,
        });
        findings.clickFailureAnalysis.push({
          route, label: safeText, tag: t.tag, href: t.href,
          error: errMsg, classification,
        });
      }
    }
    entry.clickedTargets = clicked;
  }

  return entry;
}

// â”€â”€ 1e: Click failure root-cause classifier â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function classifyClickFailure(target, errMsg) {
  // Real bugs: element exists but click has no effect / throws a functional error
  const lowerErr = errMsg.toLowerCase();
  const lowerLabel = (target.text || '').toLowerCase();

  // Locator flakiness indicators
  if (lowerErr.includes('timeout') && lowerErr.includes('isvisible')) {
    return 'CRAWLER_FLAKY: isVisible timeout â€” element may not be in viewport or is conditionally rendered';
  }
  if (lowerErr.includes('strict mode violation')) {
    return 'CRAWLER_FLAKY: multiple elements matched the locator â€” crawler needs more specific selector';
  }
  if (lowerErr.includes('element is not attached')) {
    return 'CRAWLER_FLAKY: element detached from DOM before click â€” likely a re-render race';
  }
  if (lowerErr.includes('intercepts pointer events')) {
    return 'REAL_BUG: another element is overlapping this one â€” z-index or modal blocking the click target';
  }
  if (lowerErr.includes('outside of the viewport')) {
    return 'CRAWLER_FLAKY: element is outside viewport â€” crawler skip-below-fold check missed it';
  }
  if (lowerErr.includes('disabled')) {
    return 'CRAWLER_FLAKY: element is disabled â€” crawler should have filtered it';
  }
  // If it is a nav link with an href and it navigated nowhere, likely real
  if (target.href && target.href !== '#' && !target.href.startsWith('javascript')) {
    return 'REAL_BUG: element has href but click failed â€” anchor may be broken or JS handler threw';
  }
  // Generic timeout without isVisible = real element that did not respond
  if (lowerErr.includes('timeout')) {
    return 'REAL_BUG: click timed out waiting for element to respond â€” element may be unresponsive';
  }
  return 'UNKNOWN: ' + errMsg.slice(0, 80);
}

// â”€â”€ Carried-forward items â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function carriedForwardItems() {
  return [
    '### 1. Toolbar button sizing (visual)',
    'AI Brief / Edit / Renew buttons on contract detail are different sizes.',
    '',
    '### 4. Renewal planning should auto-pull licenses (UX-blocker)',
    'SKU/Count/pricing table starts empty â€” Dustin called this a "non-starter".',
    '',
    '### 5. AI renewal brief "Jump to" anchors (layout)',
    'Weird targeting / scroll behavior on the Jump To section.',
    '',
    '### 6. Card reordering on contract detail (structural)',
    'Renewal workflow card should sit next to / before Renewal Planning card.',
    '',
    '### 7. Mojibake in Renewal Analysis card (encoding bug)',
    'Visible: `Ã°ÂŸÂ¤Â Renewal Analysis` and `Ã‚Â·` instead of middle-dot U+00B7.',
    '',
    '### 8. AI Renewal Analysis crashes (ErrorBoundary)',
    'Clicking the button fires the analysis, lands on ErrorBoundary.',
    '',
    '### 9. M365 E3/E5 overlap suggestion (DEFERRED product idea)',
    '',
    '### 10. Dashboard counter mismatches',
    'Cancel windows closing: 2 shown, /contracts filter shows 5.',
    'Overdue reviews: 7 shown, /contracts filter shows 0.',
    '',
    '### 11. Back-link on contract detail goes to /dashboard not /contracts',
    '',
    '### 14. Renewal Analysis gating decision (open product question)',
    'Gate: features.renewal_brief && aiBriefEnabled && brief. Should they be independently runnable?',
    '',
    '### Long AI generation feels like timeout',
    '~26s for brief and ~26s for analysis â€” UX recommendation: adversarial debate progress indicator.',
    '',
    '### 2. Add tag button does nothing',
    '### 3. Contract Recent Activity "View All" link goes to empty log',
  ].join('\n');
}

// â”€â”€ Report writer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function writeReport(label) {
  const now = ts();
  const reportName = label ? `qa-day-report-${label}-${now}.md` : `qa-report-${now}.md`;
  const reportPath = path.join(OUTPUTS_DIR, reportName);

  const totalClicks = findings.click_targets.length;
  const failedClicks = findings.click_targets.filter(c => c.click_failed).length;
  const realBugClicks = findings.clickFailureAnalysis.filter(c => c.classification.startsWith('REAL')).length;
  const flakyClicks = findings.clickFailureAnalysis.filter(c => c.classification.startsWith('CRAWLER')).length;
  const errorBoundaryClicks = findings.click_targets.filter(c => c.errorBoundary).length;
  const errorRoutes = findings.routes.filter(r => r.hasErrorBoundary || r.errors.length).length;
  const totalAxeSerious = findings.axeViolations.filter(v => v.impact === 'serious' || v.impact === 'critical').length;

  const lines = [];
  lines.push('# LapseIQ QA crawl report â€” Phase 1 augmented (v2)');
  lines.push('');
  lines.push(`Started:    ${findings.meta.startedAt}`);
  lines.push(`Finished:   ${new Date().toISOString()}`);
  lines.push(`Base URL:   ${findings.meta.base}`);
  lines.push(`Screenshots (per-run): ${SCREENSHOT_DIR.replace(OUTPUTS_DIR, './outputs')}`);
  lines.push(`Screenshots (baseline): ${BASELINE_DIR.replace(OUTPUTS_DIR, './outputs')}`);
  lines.push('');

  // â”€â”€ Executive summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  lines.push('## Executive Summary');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Routes crawled (desktop) | ${findings.routes.length} |`);
  lines.push(`| Routes crawled (mobile) | ${findings.mobileRoutes.length} |`);
  lines.push(`| Routes with ErrorBoundary/hard errors | **${errorRoutes}** |`);
  lines.push(`| Click targets exercised | ${totalClicks} |`);
  lines.push(`| Click failures | ${failedClicks} (${realBugClicks} real bugs / ${flakyClicks} crawler flakiness) |`);
  lines.push(`| ErrorBoundary on click | **${errorBoundaryClicks}** |`);
  lines.push(`| Console errors | ${findings.errors.console.length} |`);
  lines.push(`| Network 4xx/5xx | ${findings.errors.network.length} |`);
  lines.push(`| Unhandled exceptions | ${findings.errors.render.length} |`);
  lines.push(`| axe-core serious/critical violations | **${totalAxeSerious}** |`);
  lines.push(`| Lighthouse routes audited | ${findings.lighthouseScores.length} |`);
  lines.push(`| Modals discovered | ${findings.modal_dialogs.length} |`);
  lines.push(`| Visual baseline saved | ${BASELINE_DIR} |`);
  lines.push('');

  // â”€â”€ ErrorBoundary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  lines.push('## ðŸ”´ ErrorBoundary fires (critical)');
  lines.push('');
  const boundaryRoutes = findings.routes.filter(r => r.hasErrorBoundary);
  const boundaryClicks = findings.click_targets.filter(c => c.errorBoundary);
  if (boundaryRoutes.length === 0 && boundaryClicks.length === 0) {
    lines.push('_None â€” every route loads without ErrorBoundary._');
  } else {
    for (const r of boundaryRoutes) lines.push(`- **Route load**: \`${r.route}\``);
    for (const c of boundaryClicks)  lines.push(`- **Click**: \`${c.route}\` â†’ \`${c.label}\` â†’ ErrorBoundary`);
  }
  lines.push('');

  // â”€â”€ Lighthouse scores â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  lines.push('## ðŸ’¡ Lighthouse Scores (per route)');
  lines.push('');
  if (findings.lighthouseScores.length === 0) {
    lines.push('_Lighthouse skipped (QA_SKIP_LH=1 or not available)._');
  } else {
    lines.push('| Route | Performance | A11y | Best Practices | SEO |');
    lines.push('|-------|------------|------|----------------|-----|');
    for (const s of findings.lighthouseScores) {
      if (s.error) {
        lines.push(`| \`${s.route}\` | ERROR | ERROR | ERROR | ERROR |`);
      } else {
        const perf = s.performance < 50 ? `âŒ ${s.performance}` : s.performance < 90 ? `âš ï¸ ${s.performance}` : `âœ… ${s.performance}`;
        const a11y = s.accessibility < 50 ? `âŒ ${s.accessibility}` : s.accessibility < 90 ? `âš ï¸ ${s.accessibility}` : `âœ… ${s.accessibility}`;
        const bp   = s.bestPractices < 50 ? `âŒ ${s.bestPractices}` : s.bestPractices < 90 ? `âš ï¸ ${s.bestPractices}` : `âœ… ${s.bestPractices}`;
        const seo  = s.seo < 50 ? `âŒ ${s.seo}` : s.seo < 90 ? `âš ï¸ ${s.seo}` : `âœ… ${s.seo}`;
        lines.push(`| \`${s.route}\` | ${perf} | ${a11y} | ${bp} | ${seo} |`);
      }
    }
    lines.push('');
    // Failed audits detail
    const failedAudits = findings.lighthouseScores.flatMap(s => (s.failedAudits || []).map(a => ({ route: s.route, ...a })));
    if (failedAudits.length > 0) {
      lines.push('### Lighthouse failed audits (score < 0.9)');
      lines.push('');
      for (const a of failedAudits.slice(0, 40)) {
        lines.push(`- \`${a.route}\` â€” **${a.id}** (score: ${a.score?.toFixed(2)}) â€” ${a.title} ${a.displayValue ? '('+a.displayValue+')' : ''}`);
      }
      if (failedAudits.length > 40) lines.push(`  _...and ${failedAudits.length - 40} more_`);
    }
  }
  lines.push('');

  // â”€â”€ Mobile delta â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  lines.push('## ðŸ“± Mobile Viewport Results (375x667)');
  lines.push('');
  if (findings.mobileRoutes.length === 0) {
    lines.push('_Mobile pass not yet completed._');
  } else {
    const mobileBoundary = findings.mobileRoutes.filter(r => r.hasErrorBoundary);
    const mobileAxeTotal = findings.axeViolations.filter(v => v.route.startsWith('[mobile]')).length;
    lines.push(`- Mobile routes crawled: **${findings.mobileRoutes.length}**`);
    lines.push(`- Mobile ErrorBoundary fires: **${mobileBoundary.length}**`);
    lines.push(`- Mobile-specific axe violations (serious/critical): **${mobileAxeTotal}**`);
    lines.push('');
    lines.push('| Route | ErrorBoundary | H1 | axe serious |');
    lines.push('|-------|--------------|-----|-------------|');
    for (const r of findings.mobileRoutes) {
      const axeCount = findings.axeViolations.filter(v => v.route === '[mobile] ' + r.route).length;
      lines.push(`| \`${r.route}\` | ${r.hasErrorBoundary ? 'ðŸ”´ YES' : 'âœ… No'} | ${r.h1 || 'n/a'} | ${axeCount} |`);
    }
  }
  lines.push('');

  // â”€â”€ axe-core violations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  lines.push('## â™¿ axe-core Violations (WCAG2A/2AA â€” serious + critical)');
  lines.push('');
  if (findings.axeViolations.length === 0) {
    lines.push('_No serious or critical axe violations found._');
  } else {
    // Group by rule ID
    const byId = {};
    for (const v of findings.axeViolations) {
      byId[v.id] = byId[v.id] || { id: v.id, impact: v.impact, description: v.description, help: v.help, helpUrl: v.helpUrl, routes: [], totalNodes: 0 };
      byId[v.id].routes.push(v.route);
      byId[v.id].totalNodes += v.nodes;
    }
    const sorted = Object.values(byId).sort((a, b) => {
      const order = { critical: 0, serious: 1 };
      return (order[a.impact] || 2) - (order[b.impact] || 2);
    });
    for (const rule of sorted) {
      lines.push(`### \`${rule.id}\` â€” ${rule.impact.toUpperCase()}`);
      lines.push(`**${rule.help}**`);
      lines.push(`- Affected routes (${rule.routes.length}): ${rule.routes.slice(0, 5).map(r => `\`${r}\``).join(', ')}`);
      lines.push(`- Total failing nodes: ${rule.totalNodes}`);
      lines.push(`- [Learn more](${rule.helpUrl})`);
      lines.push('');
    }
  }

  // â”€â”€ Click failure root-cause â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  lines.push('## ðŸ”Ž Click Failure Root-Cause Analysis (1e)');
  lines.push('');
  lines.push(`Total click failures: **${failedClicks}**`);
  lines.push(`- Classified as REAL BUG: **${realBugClicks}**`);
  lines.push(`- Classified as CRAWLER FLAKY: **${flakyClicks}**`);
  lines.push(`- Unclassified: **${failedClicks - realBugClicks - flakyClicks}**`);
  lines.push('');
  if (findings.clickFailureAnalysis.length > 0) {
    lines.push('### Real bugs (click failures that appear to be application bugs)');
    const realBugs = findings.clickFailureAnalysis.filter(c => c.classification.startsWith('REAL'));
    if (realBugs.length === 0) {
      lines.push('_None classified as definitive real bugs._');
    } else {
      for (const c of realBugs) {
        lines.push(`- \`${c.route}\` â€” **${c.label}** (${c.tag}${c.href ? ', href='+c.href : ''})`);
        lines.push(`  - Classification: ${c.classification}`);
        lines.push(`  - Error: ${c.error}`);
      }
    }
    lines.push('');
    lines.push('### Crawler flakiness (not application bugs)');
    const flakyItems = findings.clickFailureAnalysis.filter(c => c.classification.startsWith('CRAWLER'));
    if (flakyItems.length === 0) {
      lines.push('_No crawler flakiness detected._');
    } else {
      for (const c of flakyItems.slice(0, 15)) {
        lines.push(`- \`${c.route}\` â€” **${c.label}**: ${c.classification}`);
      }
      if (flakyItems.length > 15) lines.push(`  _...and ${flakyItems.length - 15} more_`);
    }
  }
  lines.push('');

  // â”€â”€ Console / network errors â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  lines.push('## ðŸŸ  Console / Render Exceptions');
  lines.push('');
  if (findings.errors.render.length > 0) {
    lines.push('### Unhandled exceptions');
    for (const e of findings.errors.render.slice(0, 20)) {
      lines.push(`- **${e.name}**: ${e.message.slice(0, 200)}`);
      lines.push(`  - URL: \`${e.url.replace(BASE_URL, '')}\` at ${e.at}`);
    }
    lines.push('');
  }
  if (findings.errors.console.length > 0) {
    lines.push('### Console errors (first 30 unique)');
    const seen = new Set();
    let shown = 0;
    for (const e of findings.errors.console) {
      const key = e.text.slice(0, 100);
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- \`${e.url.replace(BASE_URL, '')}\` â€” ${e.text.slice(0, 200)}`);
      shown++;
      if (shown >= 30) break;
    }
    lines.push('');
  }
  if (findings.errors.render.length === 0 && findings.errors.console.length === 0) {
    lines.push('_No console or runtime exceptions captured._');
    lines.push('');
  }

  // â”€â”€ Network 4xx/5xx â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  lines.push('## ðŸŸ  Network 4xx / 5xx');
  lines.push('');
  if (findings.errors.network.length === 0) {
    lines.push('_No 4xx/5xx responses observed._');
  } else {
    const byUrl = {};
    for (const e of findings.errors.network) {
      const key = `${e.method} ${e.url}`;
      byUrl[key] = byUrl[key] || { count: 0, statuses: new Set() };
      byUrl[key].count++;
      byUrl[key].statuses.add(e.status);
    }
    for (const [key, v] of Object.entries(byUrl).sort((a, b) => b[1].count - a[1].count)) {
      lines.push(`- \`${key}\` â€” ${v.count}x â€” statuses [${[...v.statuses].join(', ')}]`);
    }
  }
  lines.push('');

  // â”€â”€ Navigation anomalies â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  lines.push('## ðŸŸ¡ Navigation Anomalies');
  lines.push('');
  const navigations = findings.click_targets.filter(c => c.navigated);
  const interesting = navigations.filter(c => {
    if (c.href === c.after.replace(BASE_URL, '')) return false;
    return true;
  });
  if (interesting.length === 0) {
    lines.push('_No suspicious navigations._');
  } else {
    for (const c of interesting.slice(0, 30)) {
      lines.push(`- On \`${c.route}\` clicked \`${c.label}\` (${c.tag}) â†’ \`${c.after.replace(BASE_URL, '')}\``);
    }
    if (interesting.length > 30) lines.push(`  _...and ${interesting.length - 30} more_`);
  }
  lines.push('');

  // â”€â”€ Per-route detail â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  lines.push('## Per-Route Detail');
  lines.push('');
  for (const r of findings.routes) {
    const status = r.hasErrorBoundary ? 'ðŸ”´' : r.errors.length ? 'ðŸŸ ' : 'âœ…';
    lines.push(`### ${status} \`${r.route}\``);
    if (r.h1) lines.push(`- H1: ${r.h1}`);
    lines.push(`- Click targets exercised: ${r.clickedTargets}`);
    if (r.axe) lines.push(`- axe violations (serious/critical): ${r.axe.serious || 0} of ${r.axe.total || 0} total`);
    if (r.screenshot) lines.push(`- Screenshot: \`${r.screenshot}\``);
    if (r.hasErrorBoundary) lines.push(`- âš ï¸ ErrorBoundary visible on load`);
    for (const e of r.errors) lines.push(`- âš ï¸ ${e}`);
    lines.push('');
  }

  // â”€â”€ Carried forward â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  lines.push('---');
  lines.push('');
  lines.push('# Carried-Forward Items (from prior session)');
  lines.push('');
  lines.push(carriedForwardItems());
  lines.push('');

  // â”€â”€ Agent links placeholder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  lines.push('---');
  lines.push('');
  lines.push('# Phase 2 Agent Reports');
  lines.push('');
  lines.push('- [Contract lifecycle](./qa-agent-contract-lifecycle.md)');
  lines.push('- [Renewal workflow](./qa-agent-renewal-workflow.md)');
  lines.push('- [Settings depth](./qa-agent-settings-depth.md)');
  lines.push('- [Onboarding](./qa-agent-onboarding.md)');
  lines.push('- [Reports depth](./qa-agent-reports.md)');
  lines.push('- [Demo-flow simulation](./qa-agent-demo-flow.md)');
  lines.push('');

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`\n[qa-crawler] Report: ${reportPath}`);
  return reportPath;
}

// â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(async () => {
  console.log(`[qa-crawler v2] starting against ${BASE_URL} as ${EMAIL}`);
  console.log(`[qa-crawler] screenshots  -> ${SCREENSHOT_DIR}`);
  console.log(`[qa-crawler] baseline     -> ${BASELINE_DIR}`);
  console.log(`[qa-crawler] lighthouse   -> ${SKIP_LH ? 'SKIPPED' : 'ENABLED'}`);
  console.log(`[qa-crawler] max runtime  -> ${(MAX_RUNTIME_MS / 60000)|0} min`);

  // â”€â”€ Desktop pass â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1366, height: 800 },
  });
  const page = await ctx.newPage();
  attachListeners(page);

  try {
    await login(page);
    console.log('[qa-crawler] login OK, token captured:', !!authToken);
  } catch (e) {
    console.error('[qa-crawler] login failed:', e.message);
    writeReport('PHASE1');
    await browser.close();
    process.exit(2);
  }

  console.log('\n[qa-crawler] === DESKTOP PASS ===');
  for (const route of ROUTES_TO_CRAWL) {
    if (timeBudget() < 30_000) {
      console.log('[qa-crawler] time budget exhausted; stopping desktop crawl');
      break;
    }
    console.log(`[qa-crawler] desktop ${route} (budget: ${(timeBudget()/60000)|0}min)`);
    try {
      const entry = await crawlRoute(page, route, { saveBaseline: true });
      if (entry && !entry.skipped) findings.routes.push(entry);
    } catch (e) {
      console.error(`[qa-crawler] route ${route} failed: ${e.message}`);
      findings.routes.push({ route, errors: ['crawl-fatal: ' + e.message] });
    }
    try { writeReport('PHASE1'); } catch {}
  }

  await browser.close();

  // â”€â”€ Lighthouse pass (separate Chrome per route) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (!SKIP_LH && lighthouse && chromeLauncher) {
    console.log('\n[qa-crawler] === LIGHTHOUSE PASS ===');
    for (const route of LH_ROUTES) {
      if (timeBudget() < 60_000) break;
      console.log(`[qa-crawler] lighthouse ${route} (budget: ${(timeBudget()/60000)|0}min)`);
      try { await runLighthouse(route); } catch (e) {
        console.warn(`[lighthouse] ${route}: ${e.message}`);
      }
      try { writeReport('PHASE1'); } catch {}
    }
  }

  // â”€â”€ Mobile pass â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log('\n[qa-crawler] === MOBILE PASS (375x667) ===');
  const browser2 = await chromium.launch({ headless: HEADLESS });
  const mobileCtx = await browser2.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 375, height: 667 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
  });
  const mobilePage = await mobileCtx.newPage();
  attachListeners(mobilePage);

  try {
    await login(mobilePage);
    console.log('[qa-crawler] mobile login OK');
  } catch (e) {
    console.warn('[qa-crawler] mobile login failed:', e.message);
  }

  for (const route of ROUTES_TO_CRAWL) {
    if (timeBudget() < 30_000) break;
    console.log(`[qa-crawler] mobile ${route} (budget: ${(timeBudget()/60000)|0}min)`);
    try {
      const entry = await crawlRoute(mobilePage, route, { mobile: true });
      if (entry && !entry.skipped) findings.mobileRoutes.push(entry);
    } catch (e) {
      console.warn(`[qa-crawler] mobile ${route} failed: ${e.message}`);
      findings.mobileRoutes.push({ route, mobile: true, errors: ['crawl-fatal: ' + e.message] });
    }
    try { writeReport('PHASE1'); } catch {}
  }

  await browser2.close();

  const reportPath = writeReport('PHASE1');
  console.log('\n[qa-crawler v2] DONE');
  console.log(`Report: ${reportPath}`);
  console.log(`Baseline screenshots: ${BASELINE_DIR}`);
})().catch(err => {
  console.error('[qa-crawler] FATAL:', err);
  try { writeReport('PHASE1'); } catch {}
  process.exit(1);
});