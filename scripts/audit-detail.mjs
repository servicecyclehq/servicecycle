// audit-detail.mjs
// Runs Lighthouse against a single mockup HTML and dumps which
// audits failed with the description + how-to-fix from Lighthouse itself.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import lighthouse from 'lighthouse';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO    = path.resolve(__dirname, '..');
const EXPORTS = path.join(REPO, 'outputs', 'exports');

const FILE = process.argv[2] || 'settings-final.html';
const MODE = process.argv[3] || 'light';
const PORT = 8769;

if (!existsSync(path.join(EXPORTS, FILE))) {
  console.error('missing:', path.join(EXPORTS, FILE));
  process.exit(1);
}

const srv = createServer(async (req, res) => {
  const f = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname.slice(1));
  if (f !== FILE) { res.writeHead(404); return res.end(); }
  const data = await readFile(path.join(EXPORTS, f));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(data);
});
await new Promise(r => srv.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ args: ['--remote-debugging-port=9223', '--no-sandbox'] });
const ctx = await browser.newContext({ colorScheme: MODE });
const page = await ctx.newPage();
const url = `http://127.0.0.1:${PORT}/${encodeURIComponent(FILE)}`;
await page.goto(url, { waitUntil: 'networkidle' });
await page.evaluate((m) => {
  if (m === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
}, MODE);
await page.waitForTimeout(500);

const lhr = await lighthouse(url, {
  port: 9223,
  output: 'json',
  logLevel: 'error',
  onlyCategories: ['accessibility'],
  formFactor: 'desktop',
  screenEmulation: { mobile: false, width: 1440, height: 900, deviceScaleFactor: 1, disabled: false },
  throttling: { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1 },
});

const score = Math.round((lhr.lhr.categories.accessibility.score || 0) * 100);
const a11yAuditRefs = lhr.lhr.categories.accessibility.auditRefs || [];

const failedAudits = [];
for (const ref of a11yAuditRefs) {
  const a = lhr.lhr.audits[ref.id];
  if (!a) continue;
  // Lighthouse a11y audits: scoreDisplayMode either 'binary' (0|1) or 'manual' or 'notApplicable' or 'informative'
  // Skip notApplicable/manual/informative — we only care about audits that ran and failed
  if (a.scoreDisplayMode === 'notApplicable' || a.scoreDisplayMode === 'manual' || a.scoreDisplayMode === 'informative') continue;
  if (a.score === 1 || a.score === null) continue;
  failedAudits.push({
    id: a.id,
    weight: ref.weight,
    title: a.title,
    description: a.description,
    nodeCount: (a.details?.items?.length || 0),
    sampleNode: a.details?.items?.[0]?.node?.selector || a.details?.items?.[0]?.node?.snippet?.slice(0, 100) || null,
  });
}

console.log(`# Lighthouse a11y detail — ${FILE} (${MODE} mode)`);
console.log(`# Score: ${score}/100`);
console.log(`# ${failedAudits.length} audits failing\n`);

if (failedAudits.length === 0) {
  console.log('(No failing audits.)');
} else {
  failedAudits.sort((a, b) => (b.weight || 0) - (a.weight || 0));
  for (const f of failedAudits) {
    console.log(`## ${f.id}  (weight: ${f.weight})`);
    console.log(`**${f.title}**`);
    console.log(`Affected: ${f.nodeCount} node(s)`);
    if (f.sampleNode) console.log(`Sample: \`${f.sampleNode}\``);
    console.log(`\n${f.description}\n`);
  }
}

await browser.close();
srv.close();
