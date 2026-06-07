// audit-mockups.mjs
// ----------------------------------------------------------
// Runs Lighthouse + axe-core against the standalone HTML
// mockups in outputs/exports/. Both light + dark modes via
// data-theme attribute injection.
//
// Usage: node scripts/audit-mockups.mjs
// Outputs: outputs/audit-mockups-{ISO}/report.md + per-file JSON
// ----------------------------------------------------------

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { default as AxeBuilder } from '@axe-core/playwright';
import lighthouse from 'lighthouse';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO     = path.resolve(__dirname, '..');
const EXPORTS  = path.join(REPO, 'outputs', 'exports');
const OUT_BASE = path.join(REPO, 'outputs');

const FILES = [
  { name: 'dashboard-final.html',       label: '/dashboard (locked v0.91)' },
  { name: 'contract-detail-final.html', label: '/contracts/:id (locked v0.91)' },
  { name: 'contracts-final.html',       label: '/contracts (pre-lock drift)' },
  { name: 'settings-final.html',        label: '/settings (pre-lock drift)' },
];

const MODES = ['light', 'dark'];
const PORT  = 8767;

function tsForFolder() {
  return new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
}

// ── local file server ──────────────────────────────────────
function startServer() {
  return new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const file = decodeURIComponent(url.pathname.slice(1));
      const full = path.join(EXPORTS, file);
      if (!FILES.find(f => f.name === file)) {
        res.writeHead(404); return res.end('not in audit set');
      }
      try {
        const data = await readFile(full);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      } catch {
        res.writeHead(500); res.end('read error');
      }
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

// ── audit one (file, mode) pair ────────────────────────────
async function auditOne(file, mode, runDir) {
  const url = `http://127.0.0.1:${PORT}/${encodeURIComponent(file.name)}`;
  const slug = file.name.replace('.html', '') + '-' + mode;

  // 1. Playwright + axe
  const browser = await chromium.launch({
    args: ['--remote-debugging-port=9222', '--no-sandbox'],
  });
  const context = await browser.newContext({
    colorScheme: mode,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  // Force theme via data-theme attribute (matches LapseIQ's pattern)
  await page.evaluate((m) => {
    if (m === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  }, mode);
  await page.waitForTimeout(500);

  // axe-core
  let axe;
  try {
    axe = await new AxeBuilder.default({ page }).analyze();
  } catch (e) {
    axe = { error: e.message, violations: [] };
  }

  const axeSummary = {
    total: axe.violations?.length || 0,
    critical: axe.violations?.filter(v => v.impact === 'critical').length || 0,
    serious:  axe.violations?.filter(v => v.impact === 'serious').length || 0,
    moderate: axe.violations?.filter(v => v.impact === 'moderate').length || 0,
    minor:    axe.violations?.filter(v => v.impact === 'minor').length || 0,
    violations: (axe.violations || []).map(v => ({
      id: v.id, impact: v.impact, help: v.help,
      nodes: v.nodes.length, sample: v.nodes[0]?.target?.[0] || null,
    })),
  };

  // 2. Lighthouse — connect to same Chrome via remote debugging port
  let lhScores = { performance: null, accessibility: null, error: null };
  try {
    const lhr = await lighthouse(url, {
      port: 9222,
      output: 'json',
      logLevel: 'error',
      onlyCategories: ['performance', 'accessibility'],
      formFactor: 'desktop',
      screenEmulation: { mobile: false, width: 1440, height: 900, deviceScaleFactor: 1, disabled: false },
      throttling: { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1 },
      emulatedUserAgent: false,
    });
    lhScores = {
      performance:   Math.round((lhr.lhr.categories.performance.score   || 0) * 100),
      accessibility: Math.round((lhr.lhr.categories.accessibility.score || 0) * 100),
      lcp:  Math.round(lhr.lhr.audits['largest-contentful-paint']?.numericValue || 0),
      cls:  (lhr.lhr.audits['cumulative-layout-shift']?.numericValue || 0).toFixed(3),
      fcp:  Math.round(lhr.lhr.audits['first-contentful-paint']?.numericValue || 0),
    };
  } catch (e) {
    lhScores.error = e.message;
  }

  await browser.close();

  // write per-file JSON
  await writeFile(
    path.join(runDir, `${slug}.json`),
    JSON.stringify({ file: file.name, mode, axe: axeSummary, lighthouse: lhScores }, null, 2)
  );

  return { file: file.name, label: file.label, mode, axe: axeSummary, lh: lhScores };
}

// ── main ───────────────────────────────────────────────────
async function main() {
  const runId  = tsForFolder();
  const runDir = path.join(OUT_BASE, `audit-mockups-${runId}`);
  await mkdir(runDir, { recursive: true });
  console.log(`run dir: ${runDir}`);

  const srv = await startServer();
  console.log(`server listening on http://127.0.0.1:${PORT}`);

  const results = [];
  for (const file of FILES) {
    if (!existsSync(path.join(EXPORTS, file.name))) {
      console.log(`MISS ${file.name} — skipping`);
      continue;
    }
    for (const mode of MODES) {
      process.stdout.write(`auditing ${file.name} (${mode})... `);
      try {
        const r = await auditOne(file, mode, runDir);
        results.push(r);
        console.log(`a11y=${r.lh.accessibility} perf=${r.lh.performance} axe-serious+critical=${r.axe.critical + r.axe.serious}`);
      } catch (e) {
        console.log(`ERR ${e.message}`);
        results.push({ file: file.name, label: file.label, mode, error: e.message });
      }
    }
  }

  srv.close();

  // Aggregate into markdown
  const baseline = {
    'dashboard-final.html':       { mode: 'light', a11y: 92, perf: 81 }, // /dashboard
    'contract-detail-final.html': { mode: 'light', a11y: null, perf: null }, // no /contracts/:id baseline
    'contracts-final.html':       { mode: 'light', a11y: 88, perf: 69 },
    'settings-final.html':        { mode: 'light', a11y: 88, perf: 81 },
  };

  let md = `# v0.91 mockup audit — ${runId}\n\n`;
  md += `Source files: \`outputs/exports/\` (4 standalone HTMLs from Claude Design)\n\n`;
  md += `Locked v0.91: dashboard-final, contract-detail-final\n`;
  md += `Pre-lock drift: contracts-final, settings-final (generated before §A1/A2/A3 decisions)\n\n`;

  md += `## Summary\n\n`;
  md += `| File | Mode | a11y | perf | axe serious+critical | LCP (ms) | CLS | FCP (ms) |\n`;
  md += `|---|---|---|---|---|---|---|---|\n`;
  for (const r of results) {
    if (r.error) {
      md += `| ${r.file} | ${r.mode} | — | — | ERR: ${r.error.slice(0,30)} | — | — | — |\n`;
      continue;
    }
    const axeSerious = r.axe.critical + r.axe.serious;
    md += `| ${r.file} | ${r.mode} | ${r.lh.accessibility ?? '—'} | ${r.lh.performance ?? '—'} | **${axeSerious}** | ${r.lh.lcp ?? '—'} | ${r.lh.cls ?? '—'} | ${r.lh.fcp ?? '—'} |\n`;
  }

  md += `\n## Baseline comparison (v0.90.9 live demo)\n\n`;
  md += `| File | Mode | Mockup a11y | v0.90.9 a11y | Δ | Mockup perf | v0.90.9 perf | Δ |\n`;
  md += `|---|---|---|---|---|---|---|---|\n`;
  for (const r of results) {
    if (r.error || r.mode !== 'light') continue; // baseline reference is light
    const b = baseline[r.file];
    if (!b) continue;
    const da11y = r.lh.accessibility != null && b.a11y != null ? r.lh.accessibility - b.a11y : null;
    const dperf = r.lh.performance != null && b.perf != null ? r.lh.performance - b.perf : null;
    const fmt = (x) => x == null ? '—' : (x > 0 ? `+${x}` : `${x}`);
    md += `| ${r.file} | ${r.mode} | ${r.lh.accessibility ?? '—'} | ${b.a11y ?? '—'} | ${fmt(da11y)} | ${r.lh.performance ?? '—'} | ${b.perf ?? '—'} | ${fmt(dperf)} |\n`;
  }

  md += `\n## Cross-page cohesion (±3 gate)\n\n`;
  const a11ys = results.filter(r => !r.error && r.lh.accessibility != null).map(r => r.lh.accessibility);
  const perfs = results.filter(r => !r.error && r.lh.performance   != null).map(r => r.lh.performance);
  if (a11ys.length > 1) {
    const a11yRange = Math.max(...a11ys) - Math.min(...a11ys);
    const perfRange = Math.max(...perfs) - Math.min(...perfs);
    md += `- a11y spread: ${Math.min(...a11ys)} → ${Math.max(...a11ys)} = **${a11yRange} points** ${a11yRange <= 3 ? '(PASS ±3)' : '(FAIL ±3)'}\n`;
    md += `- perf spread: ${Math.min(...perfs)} → ${Math.max(...perfs)} = **${perfRange} points** ${perfRange <= 3 ? '(PASS ±3)' : '(FAIL ±3)'}\n`;
  }

  md += `\n## Top axe violations across all surfaces\n\n`;
  const allViolations = {};
  for (const r of results) {
    if (r.error) continue;
    for (const v of r.axe.violations) {
      const key = v.id;
      if (!allViolations[key]) allViolations[key] = { id: v.id, impact: v.impact, help: v.help, count: 0, surfaces: new Set() };
      allViolations[key].count += v.nodes;
      allViolations[key].surfaces.add(`${r.file}/${r.mode}`);
    }
  }
  const sorted = Object.values(allViolations).sort((a, b) => b.count - a.count);
  if (sorted.length === 0) md += `_(no violations found — clean)_\n`;
  for (const v of sorted) {
    md += `- **${v.id}** (${v.impact}): ${v.count} nodes across ${v.surfaces.size} surfaces — ${v.help}\n`;
  }

  await writeFile(path.join(runDir, 'report.md'), md);
  console.log(`\nreport: ${path.join(runDir, 'report.md')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
