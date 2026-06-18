// server/scripts/audit-aggregator.js
// ----------------------------------
//
// Reads the per-route artefacts produced by e2e/audit.spec.js (axe +
// screenshots + console) and server/scripts/run-lighthouse.js (LHRs),
// optionally enriches each surface with a Gemini 2.5 Pro heuristic UX
// critique, and emits a single Markdown report at
//   audit-reports/<run>/report.md
//
// Gemini behaviour:
//   - If GEMINI_API_KEY is not set, the entire Gemini layer is skipped.
//     axe + Lighthouse still produce a complete report.
//   - Free-tier RPM is tight (5 RPM on Gemini 2.5 Pro at time of writing),
//     so we sleep MIN_GAP_MS between calls and exponential-backoff on 429s.
//   - We cap the run at MAX_GEMINI_CALLS to avoid burning quota in a loop.
//   - Output is parsed defensively â€” fenced JSON, raw JSON, or "throw it
//     out and keep going" are all handled.
//
// Markdown output is the load-bearing artifact. Future Claude Code sessions
// will read report.md as a punch list; section IDs and table shape MUST stay
// stable across runs so diffs work.

const fs   = require('fs');
const path = require('path');

const AUDIT_REPORTS_DIR = path.resolve(__dirname, '..', '..', 'audit-reports');

const MAX_GEMINI_CALLS = 30;
const MIN_GAP_MS       = 7000;   // 8.6 RPM, safe under 10 RPM Flash free tier
const GEMINI_MODEL_ID  = 'gemini-2.5-flash';  // CONFIRMED 2026-05-27: Pro free tier returns "limit: 0" on AI Studio projects without billing -- not usable. Flash free tier = 20 RPD per project, resets on rolling 24h. If quota exhausted, wait + re-run `npm run audit:aggregate`.

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function safeRouteSlug(routePath) {
  if (!routePath || routePath === '/') return 'root';
  return routePath.replace(/^\//, '').replace(/\//g, '__');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readManifest() {
  const latestFile = path.join(AUDIT_REPORTS_DIR, '.latest-run');
  if (!fs.existsSync(latestFile)) {
    throw new Error(`No .latest-run breadcrumb at ${latestFile}. Run the Playwright collector first.`);
  }
  const runId  = fs.readFileSync(latestFile, 'utf8').trim();
  const runDir = path.join(AUDIT_REPORTS_DIR, runId);
  const manifestPath = path.join(runDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest missing at ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return { runId, runDir, manifest };
}

function safeReadJson(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (err) { return { _readError: String((err && err.message) || err) }; }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Gemini layer
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function buildGeminiPrompt(routePath, mode) {
  return [
    'You are a senior product designer doing a heuristic UX audit on a',
    'B2B SaaS dashboard surface. Product: ServiceCycle, self-hosted',
    'contract-renewal SaaS, target buyer ops director at 200-2000 person',
    `company paying $50K/year. Current surface: ${routePath}, theme: ${mode}.`,
    '',
    "Apply Nielsen's 10 usability heuristics + Baymard premium-vs-generic",
    'aesthetic principles. For each issue found, output JSON only:',
    '',
    '{',
    '  "issues": [',
    '    {',
    '      "severity": "P0" | "P1" | "P2",',
    '      "heuristic": "<heuristic name violated>",',
    '      "element": "<concrete element description>",',
    '      "issue": "<one-sentence problem>",',
    '      "fix": "<one-sentence concrete fix>",',
    '      "mode_specific": true | false',
    '    }',
    '  ]',
    '}',
    '',
    'Ignore copy/microcopy issues â€” separate pass. Be specific; avoid',
    'generic advice like "improve hierarchy." Output JSON only, no prose.',
  ].join('\n');
}

function parseGeminiJson(text) {
  if (!text || typeof text !== 'string') return { ok: false, reason: 'empty', raw: text };
  // Try fenced ```json ... ``` first.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try { return { ok: true, data: JSON.parse(fence[1].trim()) }; }
    catch (_) { /* fall through */ }
  }
  // Try the whole text.
  try { return { ok: true, data: JSON.parse(text) }; }
  catch (_) { /* fall through */ }
  // Try substring between first { and last }.
  const first = text.indexOf('{');
  const last  = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return { ok: true, data: JSON.parse(text.slice(first, last + 1)) }; }
    catch (_) { /* fall through */ }
  }
  return { ok: false, reason: 'unparseable', raw: text };
}

async function critiqueWithGemini({ model, screenshotPath, routePath, mode, geminiDir, tag }) {
  const prompt = buildGeminiPrompt(routePath, mode);
  const imageData = fs.readFileSync(screenshotPath);
  const b64 = imageData.toString('base64');

  let attempt = 0;
  let lastErr = null;
  while (attempt < 4) {
    attempt += 1;
    try {
      const result = await model.generateContent([
        prompt,
        { inlineData: { mimeType: 'image/png', data: b64 } },
      ]);
      const text = result.response.text();
      const parsed = parseGeminiJson(text);
      fs.writeFileSync(path.join(geminiDir, `${tag}.json`), JSON.stringify({
        tag, routePath, mode, attempt,
        parsedOk: parsed.ok,
        data:     parsed.ok ? parsed.data : null,
        rawText:  text,
      }, null, 2));
      return parsed;
    } catch (err) {
      lastErr = err;
      const status = (err && (err.status || (err.response && err.response.status))) || 0;
      const message = (err && err.message) || String(err);
      const is429 = status === 429 || /rate|quota|exhausted/i.test(message);
      if (!is429 || attempt >= 4) {
        fs.writeFileSync(path.join(geminiDir, `${tag}.json`), JSON.stringify({
          tag, routePath, mode, attempt,
          parsedOk: false,
          error: message,
        }, null, 2));
        return { ok: false, reason: 'api-error', error: message };
      }
      const backoff = Math.min(60000, 8000 * attempt + Math.floor(Math.random() * 2000));
      console.warn(`[aggregator]   rate-limited, sleeping ${backoff}ms (attempt ${attempt})`);
      await sleep(backoff);
    }
  }
  return { ok: false, reason: 'exhausted', error: lastErr && lastErr.message };
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Report rendering
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function fmtScore(score01) {
  if (score01 == null) return 'n/a';
  return String(Math.round(score01 * 100));
}

function countGeminiBySeverity(geminiResult, sev) {
  if (!geminiResult || !geminiResult.ok || !geminiResult.data || !Array.isArray(geminiResult.data.issues)) return 0;
  return geminiResult.data.issues.filter((i) => String(i.severity).toUpperCase() === sev).length;
}

function renderSummaryTable(rows) {
  const header = '| Route | Mode | axe violations | Lighthouse a11y | Lighthouse perf | Gemini P0 | Gemini P1 | Gemini P2 |';
  const sep    = '|---|---|---|---|---|---|---|---|';
  const body   = rows.map((r) => {
    return `| ${r.route} | ${r.mode} | ${r.axeCount} | ${fmtScore(r.lhA11y)} | ${fmtScore(r.lhPerf)} | ${r.gP0} | ${r.gP1} | ${r.gP2} |`;
  }).join('\n');
  return [header, sep, body].join('\n');
}

function renderAxeBlock(axe) {
  if (!axe || axe._readError) return `_axe data missing or unreadable_`;
  if (axe.error) return `_axe error: ${axe.error}_`;
  const violations = axe.violations || [];
  if (violations.length === 0) return `_axe: no violations_`;
  const lines = [`**axe (${violations.length} violations)**`];
  for (const v of violations) {
    const elemCount = (v.nodes || []).length;
    const sample = (v.nodes && v.nodes[0] && v.nodes[0].target && v.nodes[0].target.join(' ')) || '';
    lines.push(`- **${v.id}** (impact: ${v.impact || 'n/a'}, ${elemCount} node${elemCount === 1 ? '' : 's'}) â€” ${v.help || v.description || ''}`);
    if (sample) lines.push(`  - example selector: \`${sample.slice(0, 200)}\``);
    if (v.helpUrl) lines.push(`  - docs: ${v.helpUrl}`);
  }
  return lines.join('\n');
}

function renderLighthouseBlock(lhr) {
  if (!lhr || lhr._readError) return `_Lighthouse data missing or unreadable_`;
  if (lhr.error) return `_Lighthouse error: ${lhr.error}_`;
  if (lhr.runtimeError) return `_Lighthouse runtime error: ${lhr.runtimeError.code} â€” ${lhr.runtimeError.message || ''}_`;
  const cats = lhr.categories || {};
  const audits = lhr.audits || {};
  const lines = ['**Lighthouse**'];
  for (const [catId, cat] of Object.entries(cats)) {
    const score = fmtScore(cat.score);
    lines.push(`- **${cat.title}**: ${score}/100`);
    const failing = (cat.auditRefs || [])
      .map((r) => audits[r.id])
      .filter((a) => a && a.score != null && a.score < 0.9 && a.scoreDisplayMode !== 'notApplicable' && a.scoreDisplayMode !== 'informative');
    if (failing.length === 0) {
      lines.push(`  - no failing audits`);
    } else {
      for (const a of failing.slice(0, 12)) {
        const dv = a.displayValue ? ` (${a.displayValue})` : '';
        lines.push(`  - ${a.title}${dv} â€” ${a.id}`);
      }
      if (failing.length > 12) lines.push(`  - â€¦ and ${failing.length - 12} more`);
    }
  }
  return lines.join('\n');
}

function renderGeminiBlock(geminiResult) {
  if (!geminiResult) return `_Gemini skipped_`;
  if (geminiResult.reason === 'skipped') return `_Gemini skipped: ${geminiResult.note || 'no API key'}_`;
  if (!geminiResult.ok) {
    const reason = geminiResult.reason || 'unknown';
    return `_Gemini: ${reason} â€” ${geminiResult.error || ''}_`;
  }
  const issues = (geminiResult.data && geminiResult.data.issues) || [];
  if (issues.length === 0) return `_Gemini: no issues_`;
  const lines = [`**Gemini (${issues.length} findings)**`];
  // Sort P0 â†’ P1 â†’ P2
  const order = { P0: 0, P1: 1, P2: 2 };
  const sorted = [...issues].sort((a, b) => (order[String(a.severity).toUpperCase()] ?? 9) - (order[String(b.severity).toUpperCase()] ?? 9));
  for (const i of sorted) {
    const sev = String(i.severity || '?').toUpperCase();
    const heur = i.heuristic ? ` â€” _${i.heuristic}_` : '';
    const modeNote = i.mode_specific ? ' _(mode-specific)_' : '';
    lines.push(`- [${sev}]${heur}: **${i.element || 'element'}** â€” ${i.issue || ''}${modeNote}`);
    if (i.fix) lines.push(`  - Fix: ${i.fix}`);
  }
  return lines.join('\n');
}

function renderConsoleBlock(con) {
  if (!con) return null;
  const events = con.consoleEvents || [];
  const errors = con.pageErrors    || [];
  const net    = con.networkErrors || [];
  if (events.length === 0 && errors.length === 0 && net.length === 0) return null;
  const lines = ['**Console / network signals**'];
  if (errors.length) {
    for (const e of errors.slice(0, 5)) lines.push(`- pageerror: ${(e.message || '').slice(0, 200)}`);
  }
  if (net.length) {
    for (const n of net.slice(0, 5)) lines.push(`- ${n.status} ${n.url}`);
  }
  const onlyErrors = events.filter((e) => e.type === 'error');
  if (onlyErrors.length) {
    for (const e of onlyErrors.slice(0, 5)) lines.push(`- console.error: ${(e.text || '').slice(0, 200)}`);
  }
  return lines.join('\n');
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Cross-surface inconsistency stub
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function detectCrossSurfaceIssues(rows) {
  const findings = [];
  // Wide axe violation count variance often means the same rule fails on
  // some surfaces and not others â€” surface-specific regressions worth
  // flagging.
  const axePerRule = {};
  for (const r of rows) {
    for (const v of r.axeRaw) {
      axePerRule[v.id] = axePerRule[v.id] || { rule: v.id, surfaces: new Set() };
      axePerRule[v.id].surfaces.add(`${r.route} [${r.mode}]`);
    }
  }
  for (const { rule, surfaces } of Object.values(axePerRule)) {
    if (surfaces.size > 0 && surfaces.size < rows.length / 2) {
      findings.push(`axe rule \`${rule}\` violates on ${surfaces.size} of ${rows.length} surfaces â€” fix once, regress everywhere`);
    }
  }
  // Performance regressions: any surface with perf < 0.6 where the cohort
  // median is > 0.8.
  const perfs = rows.map((r) => r.lhPerf).filter((s) => typeof s === 'number');
  if (perfs.length >= 4) {
    const sorted = [...perfs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median > 0.8) {
      for (const r of rows) {
        if (typeof r.lhPerf === 'number' && r.lhPerf < 0.6) {
          findings.push(`perf outlier: ${r.route} [${r.mode}] scored ${fmtScore(r.lhPerf)} vs cohort median ${fmtScore(median)}`);
        }
      }
    }
  }
  if (findings.length === 0) {
    return '_No cross-surface inconsistencies detected by the heuristic pass._\n\nThe deeper "same control rendered N ways" check is not implemented yet â€” Gemini-driven cross-surface critique is a v0.91.x extension.';
  }
  return findings.map((f) => `- ${f}`).join('\n');
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Main
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function main() {
  const { runId, runDir, manifest } = readManifest();

  // Prepare Gemini client if configured.
  let geminiModel  = null;
  let geminiActive = false;
  let geminiCalls  = 0;
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const ai = new GoogleGenerativeAI(apiKey);
      geminiModel  = ai.getGenerativeModel({ model: GEMINI_MODEL_ID });
      geminiActive = true;
      console.log(`[aggregator] Gemini active (model=${GEMINI_MODEL_ID})`);
    } catch (err) {
      console.warn(`[aggregator] Gemini client failed to init: ${(err && err.message) || err}`);
      geminiActive = false;
    }
  } else {
    console.log('[aggregator] GEMINI_API_KEY not set â€” heuristic critique layer SKIPPED');
  }

  const axeDir       = path.join(runDir, 'axe');
  const lhrDir       = path.join(runDir, 'lighthouse');
  const consoleDir   = path.join(runDir, 'console');
  const screenshotDir= path.join(runDir, 'screenshots');
  const geminiDir    = path.join(runDir, 'gemini');
  fs.mkdirSync(geminiDir, { recursive: true });

  const rows = [];

  for (const route of manifest.routes) {
    for (const mode of manifest.modes) {
      const tag = `${safeRouteSlug(route.path)}-${mode}`;
      const axe = safeReadJson(path.join(axeDir, `${tag}.json`));
      const lhr = safeReadJson(path.join(lhrDir, `${tag}.json`));
      const con = safeReadJson(path.join(consoleDir, `${tag}.json`));

      let geminiResult = { reason: 'skipped', note: 'no API key' };

      // Resume support: if a prior aggregator run already wrote a successful
      // parsedOk:true result for this surface, load it rather than burning
      // another API call. Lets a re-run of `npm run audit:aggregate` retry
      // only the surfaces that failed last time (e.g. due to free-tier
      // 429s).
      const existingGeminiPath = path.join(geminiDir, `${tag}.json`);
      if (fs.existsSync(existingGeminiPath)) {
        const prior = safeReadJson(existingGeminiPath);
        if (prior && prior.parsedOk === true && prior.data && Array.isArray(prior.data.issues)) {
          geminiResult = { ok: true, data: prior.data, resumed: true };
        }
      }

      if (geminiActive && geminiCalls < MAX_GEMINI_CALLS && (!geminiResult || !geminiResult.ok)) {
        const shotPath = path.join(screenshotDir, `${tag}.png`);
        if (fs.existsSync(shotPath)) {
          if (geminiCalls > 0) await sleep(MIN_GAP_MS);
          console.log(`[aggregator] Gemini critique â†’ ${tag} (call ${geminiCalls + 1}/${MAX_GEMINI_CALLS})`);
          geminiResult = await critiqueWithGemini({
            model: geminiModel,
            screenshotPath: shotPath,
            routePath: route.path,
            mode,
            geminiDir,
            tag,
          });
          geminiCalls += 1;
        } else {
          geminiResult = { ok: false, reason: 'no-screenshot' };
        }
      } else if (geminiActive && geminiCalls >= MAX_GEMINI_CALLS) {
        geminiResult = { reason: 'skipped', note: `MAX_GEMINI_CALLS (${MAX_GEMINI_CALLS}) hit` };
      }

      const axeCount = (axe && axe.violations) ? axe.violations.length : 0;
      const lhA11y = lhr && lhr.categories && lhr.categories.accessibility ? lhr.categories.accessibility.score : null;
      const lhPerf = lhr && lhr.categories && lhr.categories.performance   ? lhr.categories.performance.score   : null;

      rows.push({
        route: route.path,
        mode,
        tag,
        axe, lhr, con,
        gemini: geminiResult,
        axeCount,
        axeRaw: (axe && axe.violations) || [],
        lhA11y, lhPerf,
        gP0: countGeminiBySeverity(geminiResult, 'P0'),
        gP1: countGeminiBySeverity(geminiResult, 'P1'),
        gP2: countGeminiBySeverity(geminiResult, 'P2'),
      });
    }
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Render markdown
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const md = [];
  md.push(`# ServiceCycle Audit Report â€” ${manifest.version} â€” ${manifest.timestamp}`);
  md.push('');
  md.push(`Run ID: \`${runId}\`  `);
  md.push(`Target: \`${manifest.baseURL}\`  `);
  md.push(`Routes: ${manifest.routes.length} Ã— Modes: ${manifest.modes.length} = ${rows.length} surfaces  `);
  const cachedCount = rows.filter((r) => r.gemini && r.gemini.resumed).length;
  const newCount    = rows.filter((r) => r.gemini && r.gemini.ok && !r.gemini.resumed).length;
  const missingCount = rows.length - cachedCount - newCount;
  if (geminiActive) {
    md.push(`Gemini: enabled (model=${GEMINI_MODEL_ID}) - ${newCount} new + ${cachedCount} cached + ${missingCount} missing of ${rows.length} surfaces; ${geminiCalls}/${MAX_GEMINI_CALLS} API calls used this run`);
  } else if (cachedCount > 0) {
    md.push(`Gemini: ${cachedCount}/${rows.length} surfaces have cached findings; ${missingCount} surfaces missing (set GEMINI_API_KEY and re-run \`npm run audit:aggregate\` to retry)`);
  } else {
    md.push('Gemini: SKIPPED (set GEMINI_API_KEY to enable heuristic UX critique)');
  }
  md.push('');
  md.push('## Summary');
  md.push('');
  md.push(renderSummaryTable(rows));
  md.push('');
  md.push('## Per-surface findings');
  md.push('');

  for (const route of manifest.routes) {
    md.push(`### ${route.path}`);
    md.push('');
    for (const mode of manifest.modes) {
      const r = rows.find((x) => x.route === route.path && x.mode === mode);
      if (!r) continue;
      md.push(`#### ${mode} mode`);
      md.push('');
      md.push(`Screenshot: \`screenshots/${r.tag}.png\``);
      md.push('');
      md.push(renderAxeBlock(r.axe));
      md.push('');
      md.push(renderLighthouseBlock(r.lhr));
      md.push('');
      md.push(renderGeminiBlock(r.gemini));
      const conBlock = renderConsoleBlock(r.con);
      if (conBlock) {
        md.push('');
        md.push(conBlock);
      }
      md.push('');
    }
  }

  md.push('## Cross-surface inconsistencies');
  md.push('');
  md.push(detectCrossSurfaceIssues(rows));
  md.push('');

  // Footer
  md.push('---');
  md.push('');
  md.push(`Generated by audit-aggregator at ${new Date().toISOString()}.`);
  md.push('Re-run: `npm run audit` (against the live demo).');

  const reportPath = path.join(runDir, 'report.md');
  fs.writeFileSync(reportPath, md.join('\n'), 'utf8');
  console.log(`[aggregator] wrote ${reportPath}`);
  console.log(`[aggregator] Gemini calls used: ${geminiCalls}`);
}

main().catch((err) => {
  console.error(`[aggregator] fatal: ${(err && err.stack) || err}`);
  process.exit(1);
});