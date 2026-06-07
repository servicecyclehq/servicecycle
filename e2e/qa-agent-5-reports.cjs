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
async function shot(page, l) { try { await page.screenshot({ path: path.join(OUTPUTS, `agent5-${String(++si).padStart(2,"0")}-${l}.png`), fullPage: false }); } catch {} }
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

const REPORTS = [
  { path: "/reports/renewal-horizon",          name: "Renewal Horizon" },
  { path: "/reports/auto-renewal-exposure",    name: "Auto-Renewal Exposure" },
  { path: "/reports/co-term-opportunity",      name: "Co-Termination Opportunity" },
  { path: "/reports/price-escalation-radar",   name: "Price Escalation Radar" },
  { path: "/reports/multi-year-commitment-risk",name: "Multi-Year Commitment Risk" },
  { path: "/reports/risk-radar",               name: "Risk Radar" },
  { path: "/reports/vendor-concentration",     name: "Vendor Concentration" },
  { path: "/reports/audit-evidence-pack",      name: "Audit Evidence Pack" },
  { path: "/reports/contract-health-score",    name: "Contract Health Score" },
  { path: "/reports/savings-ledger",           name: "Savings Ledger" },
  { path: "/reports/spend-ledger",             name: "Spend Ledger" },
];

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", e => log("CRITICAL", "PageError", e.message, false));

  try {
    await login(page);
    log("INFO","Login","OK",true);

    // Hub page
    await page.goto(BASE_URL + "/reports", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(1500);
    await noEB(page, "/reports");
    await shot(page, "reports-hub");

    const hubText = await page.locator("body").innerText();
    const reportLinks = await page.locator("a[href*='/reports/']").count();
    log("HIGH","ReportsHub", `Hub renders. Report links visible: ${reportLinks}`, reportLinks > 0);

    // Check each report
    for (const report of REPORTS) {
      await page.goto(BASE_URL + report.path, { waitUntil: "networkidle", timeout: 20000 });
      await page.waitForTimeout(2000);
      const ok = await noEB(page, report.path);
      await shot(page, report.name.toLowerCase().replace(/\s+/g,"-").slice(0,20));

      if (!ok) continue;

      const bodyText = await page.locator("body").innerText();
      const hasData = bodyText.match(/\$|\d+\s*(contracts?|vendor|days|month)/i);
      const isEmpty = bodyText.match(/no data|no contracts|empty|coming soon/i);
      log("HIGH", `Report:${report.name}`,
        isEmpty ? "Report shows empty/coming soon state" :
        hasData ? "Report has data content" : "Report renders but content unclear",
        ok);

      // Check for export button
      const exportBtn = page.locator("button").filter({ hasText: /export|pdf|download/i }).first();
      const exportExists = await exportBtn.isVisible({ timeout: 2000 }).catch(() => false);
      log("MEDIUM", `Report:${report.name}:Export`, "Export button visible: " + exportExists, null);

      if (exportExists) {
        // Click export and check for response
        const dlPromise = page.waitForEvent("download", { timeout: 8000 }).catch(() => null);
        await exportBtn.click();
        await page.waitForTimeout(2000);
        const dl = await dlPromise;
        if (dl) {
          log("HIGH", `Report:${report.name}:ExportDL`, "PDF export triggered download", true);
        } else {
          // May have opened in new tab or triggered different UI
          const afterText = await page.locator("body").innerText();
          if (afterText.match(/generating|downloading|preparing/i)) {
            log("MEDIUM", `Report:${report.name}:ExportDL`, "Export shows progress state", true);
          } else if (afterText.match(/Something went wrong/i)) {
            log("HIGH", `Report:${report.name}:ExportDL`, "Export triggered ErrorBoundary", false);
          } else {
            log("MEDIUM", `Report:${report.name}:ExportDL`, "Export clicked but no download event captured â€” may work differently", null);
          }
        }
        // navigate back if left
        if (!page.url().includes(report.path)) {
          await page.goto(BASE_URL + report.path, { waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
        }
      }

      // Try changing a filter if available
      const filterSelect = page.locator("select, [role=combobox]").first();
      if (await filterSelect.isVisible({ timeout: 1500 }).catch(() => false)) {
        await filterSelect.selectOption({ index: 1 }).catch(() => {});
        await page.waitForTimeout(1500);
        log("INFO", `Report:${report.name}:FilterChange`, "Filter changed, page did not crash", null);
      }
    }

    // Check /reports index links correctness
    await page.goto(BASE_URL + "/reports", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(1500);
    const allReportLinks = await page.locator("a[href*='/reports/']").all();
    const reportHrefs = await Promise.all(allReportLinks.map(l => l.getAttribute("href")));
    log("INFO","AllReportLinks", "Report hrefs on hub: " + reportHrefs.join(", "), null);

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
  md.push("# QA Agent 5: Reports Depth Findings");
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
  const outPath = path.join(OUTPUTS, "qa-agent-reports.md");
  fs.writeFileSync(outPath, md.join("\n"), "utf8");
  console.log("Report: " + outPath);
}

run().catch(e => { console.error("FATAL:", e); writeReport(); process.exit(1); });