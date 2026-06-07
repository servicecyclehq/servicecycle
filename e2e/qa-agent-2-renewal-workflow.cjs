"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const BASE_URL = "https://demo.lapseiq.com";
const EMAIL = "admin@demo.local";
const PASSWORD = "Admin1234!";
const OUTPUTS = path.join(__dirname, "..", "outputs");
const findings = [];
let screenshotIdx = 0;

async function login(page) {
  await page.goto(BASE_URL + "/login", { waitUntil: "networkidle", timeout: 30000 });
  await page.fill("input[type=email]", EMAIL);
  await page.fill("input[type=password]", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL(/dashboard|contracts/, { timeout: 15000 });
  await page.waitForTimeout(2000);
}
function log(sev, check, detail, pass) {
  findings.push({ sev, check, detail, pass: pass === undefined ? null : pass });
  console.log(`[${pass===true?"PASS":pass===false?"FAIL":"INFO"}][${sev}] ${check}: ${detail}`);
}
async function shot(page, label) {
  const n = `agent2-${String(++screenshotIdx).padStart(2,"0")}-${label}.png`;
  try { await page.screenshot({ path: path.join(OUTPUTS, n), fullPage: false }); } catch {}
}
async function noEB(page, ctx) {
  const t = await page.locator("body").innerText().catch(() => "");
  if (t.match(/Something went wrong|We hit a snag/i)) { log("CRITICAL","EB",ctx,false); return false; } return true;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", e => log("CRITICAL", "PageError", e.message, false));

  try {
    await login(page);
    log("INFO","Login","OK",true);

    // Navigate to contracts filtered for cancel-window contracts
    await page.goto(BASE_URL + "/contracts?renewal=cancel30", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(2000);
    await noEB(page, "/contracts?renewal=cancel30");
    await shot(page, "cancel30-list");

    // Count visible contracts
    const contractLinks = page.locator("a[href*='/contracts/']");
    const count = await contractLinks.count();
    log("HIGH","Cancel30Contracts", `Found ${count} contracts in cancel30 view`, count > 0);

    // Click first contract
    if (count > 0) {
      const firstHref = await contractLinks.first().getAttribute("href");
      await contractLinks.first().click();
      await page.waitForURL(/\/contracts\/[^/]+$/, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(2500);
      log("INFO","ContractDetail", `Navigated to: ${page.url()}`, null);
    } else {
      // Fall back to any contract
      await page.goto(BASE_URL + "/contracts", { waitUntil: "networkidle", timeout: 20000 });
      await page.waitForTimeout(1500);
      const fallback = page.locator("a[href*='/contracts/']").first();
      if (await fallback.isVisible({ timeout: 3000 }).catch(() => false)) {
        await fallback.click();
        await page.waitForTimeout(2500);
      }
    }
    await noEB(page, "contract detail");
    await shot(page, "contract-detail");
    const detailUrl = page.url();

    // Check Mojibake in renewal analysis card (Bug #7)
    const bodyText = await page.locator("body").innerText();
    const hasMojibake = bodyText.includes("Ã°") || bodyText.includes("Ã‚Â·") || bodyText.includes("Ã¢â‚¬");
    log("HIGH","MojibakeCheck",
      hasMojibake ? "Mojibake text found on page: " + bodyText.slice(0, 200) : "No mojibake detected",
      !hasMojibake);

    // Check for AI Renewal Brief button
    const briefBtn = page.locator("button").filter({ hasText: /ai.{0,10}brief|renewal.{0,10}brief|generate.{0,10}brief/i }).first();
    const briefExists = await briefBtn.isVisible({ timeout: 3000 }).catch(() => false);
    log("HIGH","AIBriefButton","AI Renewal Brief button visible: " + briefExists, null);
    await shot(page, "before-brief");

    if (briefExists) {
      // Click to generate brief
      await briefBtn.click();
      log("INFO","AIBriefClick","Clicked AI Brief button â€” waiting up to 40s for result", null);
      // Wait for either completion or ErrorBoundary
      const start = Date.now();
      let briefDone = false;
      while (Date.now() - start < 40000) {
        await page.waitForTimeout(2000);
        const t = await page.locator("body").innerText();
        if (t.match(/Something went wrong|We hit a snag/i)) {
          log("CRITICAL","AIBriefResult","ErrorBoundary after brief generation", false);
          briefDone = true;
          break;
        }
        if (t.match(/executive summary|recommendation|negotiation|jump to/i)) {
          log("HIGH","AIBriefResult","Brief rendered successfully with content", true);
          briefDone = true;
          break;
        }
        if (t.match(/generating|analyzing|processing/i)) {
          // Still loading
        }
      }
      if (!briefDone) log("HIGH","AIBriefResult","Brief did not complete within 40s timeout", false);
      await shot(page, "after-brief");
    }

    // Check "Jump to" anchors (Bug #5)
    const jumpLinks = page.locator("a[href^='#']");
    const jumpCount = await jumpLinks.count();
    log("MEDIUM","JumpToAnchors", `Found ${jumpCount} same-page anchor links`, null);
    if (jumpCount > 0) {
      for (let i = 0; i < Math.min(jumpCount, 3); i++) {
        const href = await jumpLinks.nth(i).getAttribute("href");
        const text = await jumpLinks.nth(i).innerText();
        // Check the target ID exists
        const targetExists = await page.evaluate((id) => !!document.getElementById(id), href?.replace("#",""));
        log("MEDIUM","AnchorTarget", `"${text}" -> ${href} target exists: ${targetExists}`, targetExists);
      }
    }

    // Try Renewal Analysis (Bug #8)
    await page.goto(detailUrl, { waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const analysisBtn = page.locator("button").filter({ hasText: /run analysis|renewal analysis|ai analysis/i }).first();
    const analysisExists = await analysisBtn.isVisible({ timeout: 3000 }).catch(() => false);
    log("HIGH","RenewalAnalysisButton","Renewal Analysis button visible: " + analysisExists, null);

    if (analysisExists) {
      await analysisBtn.click();
      log("INFO","RenewalAnalysisClick","Clicked Renewal Analysis â€” waiting up to 40s", null);
      const start2 = Date.now();
      let done = false;
      while (Date.now() - start2 < 40000) {
        await page.waitForTimeout(2000);
        const t = await page.locator("body").innerText();
        if (t.match(/Something went wrong|We hit a snag/i)) {
          log("CRITICAL","RenewalAnalysisResult","ErrorBoundary after analysis (Bug #8 confirmed)", false);
          done = true; break;
        }
        if (t.match(/negotiation|recommendation|analysis complete|verdict/i)) {
          log("HIGH","RenewalAnalysisResult","Analysis rendered successfully", true);
          done = true; break;
        }
      }
      if (!done) log("HIGH","RenewalAnalysisResult","Analysis did not complete within 40s", false);
      await shot(page, "after-analysis");
    }

    // Check Renewal Planning card (Bug #4)
    const renewalPlanCard = page.locator("[class*=renewal], [class*=planning], section, .card").filter({ hasText: /renewal planning|sku|licenses/i }).first();
    if (await renewalPlanCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      const planText = await renewalPlanCard.innerText();
      const hasPrefilledData = planText.match(/\$|count|qty|quantity|\d+\s*(seats|licenses|users)/i);
      log("HIGH","RenewalPlanningAutoFill",
        hasPrefilledData ? "Renewal Planning has pre-filled data" : "Renewal Planning appears EMPTY (Bug #4)",
        !!hasPrefilledData);
    } else {
      log("MEDIUM","RenewalPlanningCard","Renewal Planning card not found by selector", null);
    }

    // Check card ordering (Bug #6)
    const cardOrder = await page.evaluate(() => {
      const cards = document.querySelectorAll("[class*=card], section, [class*=panel]");
      return Array.from(cards).slice(0,10).map(c => c.querySelector("h2,h3")?.textContent?.trim() || "").filter(Boolean);
    });
    log("MEDIUM","CardOrdering", "Card order on detail page: " + cardOrder.slice(0,6).join(" > "), null);

    // AI generation timing check
    log("INFO","AITiming","Expected: AI brief ~26s, analysis ~26s. Long waits perceived as timeout by users.", null);

  } catch (e) {
    log("CRITICAL","UnhandledError",e.message,false);
    await shot(page, "crash");
  } finally {
    await browser.close();
    writeReport();
  }
}

function writeReport() {
  const now = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const md = [];
  md.push("# QA Agent 2: Renewal Workflow Findings");
  md.push(`Generated: ${now}`);
  md.push("");
  const fails = findings.filter(f => f.pass === false);
  const passes = findings.filter(f => f.pass === true);
  md.push(`## Summary`);
  md.push(`- Checks: ${findings.length} | PASS: ${passes.length} | FAIL: ${fails.length}`);
  md.push("");
  md.push("## Findings");
  for (const f of findings) {
    const icon = f.pass === true ? "PASS" : f.pass === false ? "FAIL" : "INFO";
    md.push(`### [${icon}] [${f.sev}] ${f.check}`);
    md.push(f.detail);
    md.push("");
  }
  const outPath = path.join(OUTPUTS, "qa-agent-renewal-workflow.md");
  fs.writeFileSync(outPath, md.join("\n"), "utf8");
  console.log("Report: " + outPath);
}

run().catch(e => { console.error("FATAL:", e); writeReport(); process.exit(1); });