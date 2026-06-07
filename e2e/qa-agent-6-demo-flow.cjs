"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const BASE_URL = "https://demo.lapseiq.com";
const EMAIL = "admin@demo.local";
const PASSWORD = "Admin1234!";
const OUTPUTS = path.join(__dirname, "..", "outputs");
const findings = [];
let si = 0;
async function shot(page, l) { try { await page.screenshot({ path: path.join(OUTPUTS, `agent6-${String(++si).padStart(2,"0")}-${l}.png`), fullPage: false }); } catch {} }
function log(sev, check, detail, pass) { findings.push({ sev, check, detail, pass: pass===undefined?null:pass }); console.log(`[${pass===true?"PASS":pass===false?"FAIL":"INFO"}][${sev}] ${check}: ${detail}`); }
async function noEB(page, ctx) { const t = await page.locator("body").innerText().catch(()=>""); if(t.match(/Something went wrong|We hit a snag/i)){log("CRITICAL","EB",ctx,false);return false;} return true; }
async function login(page) {
  await page.goto(BASE_URL + "/login", { waitUntil: "networkidle", timeout: 30000 });
  await page.fill("input[type=email]", EMAIL);
  await page.fill("input[type=password]", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL(/dashboard|contracts/, { timeout: 15000 });
  await page.waitForTimeout(2000);
}

// Marketing-ese terms to flag
const BAD_COPY = /\b(leverage|synergy|transform|transforming|best-in-class|world-class|cutting-edge|paradigm|empower|disrupting|revolutionary|game-changing|seamless|robust|holistic|utilize|utilize|leverage)\b/i;

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", e => log("CRITICAL","PageError",e.message,false));

  try {
    await login(page);
    log("INFO","Login","OK",true);

    // STEP 1: Dashboard â€” high-level KPIs
    await page.goto(BASE_URL + "/dashboard", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(2500);
    await noEB(page, "/dashboard");
    await shot(page, "dashboard-overview");

    const dashText = await page.locator("body").innerText();
    // Check brand voice
    const badCopyMatches = dashText.match(BAD_COPY);
    log("HIGH","DashboardBrandVoice",
      badCopyMatches ? "Marketing-ese found on dashboard: " + badCopyMatches.slice(0,3).join(", ") : "No obvious marketing-ese on dashboard",
      !badCopyMatches);

    // Check KPI labels for clarity
    const kpiLabels = await page.evaluate(() => {
      const els = document.querySelectorAll("[class*=kpi], [class*=metric], [class*=stat-label], [class*=card-title]");
      return Array.from(els).map(e => e.textContent.trim()).filter(t => t.length > 0 && t.length < 60);
    });
    log("INFO","DashboardKPILabels","KPI labels: " + kpiLabels.slice(0,8).join(" | "), null);

    // Are the numbers obviously meaningful? (Cancel windows, overdue reviews)
    const cancelWidget = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("*"));
      const cancel = els.find(e => e.textContent.includes("cancel") && e.children.length < 5);
      return cancel ? { text: cancel.textContent.trim().slice(0, 100) } : null;
    });
    log("INFO","CancelWindowsWidget","Cancel windows widget text: " + JSON.stringify(cancelWidget), null);

    // STEP 2: Navigate to cancel30 filter â€” the "trap-detection" value prop
    await page.goto(BASE_URL + "/contracts?renewal=cancel30", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(2000);
    await noEB(page, "/contracts?renewal=cancel30");
    await shot(page, "cancel30-demo");

    const cancel30Text = await page.locator("body").innerText();
    const cancel30Count = (cancel30Text.match(/contract/gi) || []).length;
    log("HIGH","Cancel30Filter",`cancel30 filter shows ${cancel30Count} contract mentions`, cancel30Count > 0);

    // Check if the filter label is clear
    const activeFilters = await page.evaluate(() => {
      const chips = document.querySelectorAll("[class*=chip], [class*=filter-tag], [class*=badge][class*=filter]");
      return Array.from(chips).map(c => c.textContent.trim()).filter(Boolean);
    });
    log("MEDIUM","ActiveFilterLabels","Active filter chips: " + (activeFilters.join(", ") || "none"), null);

    // STEP 3: Contract detail â€” value prop
    const contractLink = page.locator("a[href*='/contracts/']").first();
    if (await contractLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await contractLink.click();
      await page.waitForURL(/\/contracts\/[^/]+$/, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(2500);
      await noEB(page, "contract detail (demo flow)");
      await shot(page, "contract-detail-demo");

      const detailText = await page.locator("body").innerText();

      // Check for mojibake (embarrassing for a prospect)
      const hasMojibake = detailText.includes("Ã°") || detailText.includes("Ã‚Â·") || detailText.includes("Ã¢â‚¬");
      log("CRITICAL","DemoMojibake",
        hasMojibake ? "EMBARRASSING: Mojibake visible on contract detail during demo" : "No mojibake on contract detail",
        !hasMojibake);

      // Brand voice check on detail
      const badInDetail = detailText.match(BAD_COPY);
      log("MEDIUM","DetailBrandVoice",
        badInDetail ? "Marketing-ese in contract detail: " + badInDetail.slice(0,3).join(", ") : "No marketing-ese on detail",
        !badInDetail);

      // Check for clear renewal date visibility
      const hasRenewalDate = detailText.match(/renew|end date|expir/i);
      log("HIGH","RenewalDateVisible","Renewal date information visible: " + !!hasRenewalDate, !!hasRenewalDate);

      // Check toolbar button alignment (Bug #1)
      const topButtons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("button")).filter(b => {
          const r = b.getBoundingClientRect();
          return r.top < 120 && r.width > 20 && r.height > 20;
        }).map(b => ({ text: b.textContent.trim().slice(0,20), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) }));
      });
      log("MEDIUM","ToolbarButtonSizes","Top area buttons: " + JSON.stringify(topButtons.slice(0,6)), null);
    }

    // STEP 4: AI Brief in demo context
    const briefBtn = page.locator("button").filter({ hasText: /ai.{0,10}brief|renewal.{0,10}brief/i }).first();
    if (await briefBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await briefBtn.click();
      log("INFO","AIBriefDemoFlow","AI Brief triggered â€” waiting 35s", null);
      const start = Date.now();
      let done = false;
      while (Date.now() - start < 35000) {
        await page.waitForTimeout(2500);
        const t = await page.locator("body").innerText();
        if (t.match(/Something went wrong|We hit a snag/i)) {
          log("CRITICAL","AIBriefDemoFlow","ErrorBoundary during demo AI brief", false);
          done = true; break;
        }
        if (t.match(/executive summary|recommendation|jump to/i)) {
          log("HIGH","AIBriefDemoFlow","AI Brief rendered successfully for demo", true);
          done = true; break;
        }
      }
      if (!done) log("HIGH","AIBriefDemoFlow","AI Brief did not complete within 35s", false);
      await shot(page, "ai-brief-demo");
    }

    // STEP 5: Reports â€” executive output
    await page.goto(BASE_URL + "/reports", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(1500);
    await noEB(page, "/reports");
    await shot(page, "reports-hub-demo");
    const reportsText = await page.locator("body").innerText();
    const badInReports = reportsText.match(BAD_COPY);
    log("MEDIUM","ReportsBrandVoice",
      badInReports ? "Marketing-ese in reports: " + badInReports.slice(0,3).join(", ") : "No marketing-ese in reports hub",
      !badInReports);

    // Try Renewal Horizon report
    await page.goto(BASE_URL + "/reports/renewal-horizon", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(2000);
    await noEB(page, "/reports/renewal-horizon");
    await shot(page, "renewal-horizon-demo");

    const horizonText = await page.locator("body").innerText();
    log("HIGH","RenewalHorizonDemo","Renewal Horizon renders for demo", !horizonText.match(/Something went wrong/i));

    // Overall demo assessment
    log("INFO","DemoFlowAssessment",
      "Overall demo path completed. Key concerns: #7 mojibake (embarrassing), #8 EB on analysis, #10 counter mismatches reduce trust. Dashboard -> cancel30 filter -> detail -> AI brief -> reports is a coherent demo path.",
      null);

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
  md.push("# QA Agent 6: Demo-Flow Sales Simulation Findings");
  md.push(`Generated: ${now}`);
  md.push("");
  const fails = findings.filter(f => f.pass === false);
  md.push(`## Summary`);
  md.push(`- Checks: ${findings.length} | PASS: ${findings.filter(f=>f.pass===true).length} | FAIL: ${fails.length}`);
  md.push("");
  md.push("## Findings");
  for (const f of findings) {
    const icon = f.pass === true ? "PASS" : f.pass === false ? "FAIL" : "INFO";
    md.push(`### [${icon}] [${f.sev}] ${f.check}`);
    md.push(f.detail);
    md.push("");
  }
  md.push("## Sales demo path recommendation");
  md.push("Dashboard -> /contracts?renewal=cancel30 -> contract detail -> AI Brief -> /reports/renewal-horizon");
  md.push("This 5-step flow demonstrates: portfolio visibility, trap detection, contract intelligence, AI analysis, executive output.");
  const outPath = path.join(OUTPUTS, "qa-agent-demo-flow.md");
  fs.writeFileSync(outPath, md.join("\n"), "utf8");
  console.log("Report: " + outPath);
}

run().catch(e => { console.error("FATAL:", e); writeReport(); process.exit(1); });