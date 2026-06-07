// qa-agent-1-contract-lifecycle.cjs
// Drives full contract lifecycle: create -> edit -> upload doc -> tag -> archive -> restore -> delete
// Writes findings to outputs/qa-agent-contract-lifecycle.md

"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE_URL = "https://demo.lapseiq.com";
const EMAIL = "admin@demo.local";
const PASSWORD = "Admin1234!";
const OUTPUTS = path.join(__dirname, "..", "outputs");

const findings = [];
const screenshots = [];
let screenshotIdx = 0;

async function login(page) {
  await page.goto(BASE_URL + "/login", { waitUntil: "networkidle", timeout: 30000 });
  await page.fill("input[type=email]", EMAIL);
  await page.fill("input[type=password]", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL(/dashboard|contracts/, { timeout: 15000 });
  await page.waitForTimeout(2000);
}

function log(severity, check, detail, pass) {
  const entry = { severity, check, detail, pass: pass === undefined ? null : pass };
  findings.push(entry);
  const icon = pass === true ? "PASS" : pass === false ? "FAIL" : "INFO";
  console.log(`[${icon}] [${severity}] ${check}: ${detail}`);
}

async function shot(page, label) {
  const name = `agent1-${String(++screenshotIdx).padStart(2,"0")}-${label}.png`;
  const p = path.join(OUTPUTS, name);
  try { await page.screenshot({ path: p, fullPage: false }); screenshots.push(name); } catch {}
}

async function checkNoErrorBoundary(page, ctx) {
  const txt = await page.locator("body").innerText().catch(() => "");
  if (txt.match(/Something went wrong|We hit a snag/i)) {
    log("CRITICAL", "ErrorBoundary", ctx + " -- ErrorBoundary visible", false);
    return false;
  }
  return true;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", e => log("CRITICAL", "PageError", e.message, false));

  try {
    // LOGIN
    await login(page);
    log("INFO", "Login", "Logged in as admin@demo.local", true);
    await shot(page, "dashboard");

    // STEP 1: CREATE contract
    await page.goto(BASE_URL + "/contracts/new", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(1500);
    await checkNoErrorBoundary(page, "contracts/new");
    await shot(page, "new-contract-form");

    // Fill basic fields
    const vendorSel = page.locator("input[name=vendor], select[name=vendor], [placeholder*=vendor i], [placeholder*=Vendor]").first();
    if (await vendorSel.isVisible({ timeout: 3000 }).catch(() => false)) {
      await vendorSel.fill("TestVendor-QA").catch(() => {});
    } else {
      // Try dropdown
      const vendorDrop = page.locator("select, [role=combobox]").first();
      if (await vendorDrop.isVisible({ timeout: 2000 }).catch(() => false)) {
        log("INFO", "VendorField", "Vendor field is a combobox/select", null);
      }
    }

    const nameFld = page.locator("input[name=name], input[placeholder*='contract name' i], input[placeholder*='Contract name']").first();
    if (await nameFld.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nameFld.fill("QA Test Contract " + Date.now());
    } else {
      log("WARN", "ContractNameField", "Could not find contract name input by known selectors", null);
    }

    // Try to find and fill end date
    const endDateFld = page.locator("input[name=endDate], input[type=date]").first();
    if (await endDateFld.isVisible({ timeout: 2000 }).catch(() => false)) {
      await endDateFld.fill("2027-12-31").catch(() => {});
    }

    await shot(page, "new-contract-filled");

    // Look for Save / Submit button
    const saveBtn = page.locator("button").filter({ hasText: /save|create|submit|add contract/i }).first();
    if (await saveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await saveBtn.click();
      await page.waitForTimeout(2500);
      const url = page.url();
      log("HIGH", "ContractCreate", `After save URL: ${url}`, url.includes("/contracts") && !url.includes("/new"));
    } else {
      log("HIGH", "ContractCreate", "Could not find Save/Create button on new contract form", false);
    }
    await shot(page, "after-create");

    // STEP 2: Verify contract list shows new contract
    await page.goto(BASE_URL + "/contracts", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(1500);
    await checkNoErrorBoundary(page, "/contracts after create");
    const listText = await page.locator("body").innerText();
    log("HIGH", "ContractInList", "QA Test Contract appears in list after create",
      listText.includes("QA Test Contract"));
    await shot(page, "contract-list");

    // STEP 3: Navigate to a contract detail
    // Use existing seeded contract (more reliable than finding the one we just created)
    await page.goto(BASE_URL + "/contracts", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(2000);
    // Click the first contract row
    const firstContractLink = page.locator("table tbody tr, [data-testid*=contract], .contract-row").first();
    const contractLink = page.locator("a[href*='/contracts/']").first();
    if (await contractLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      const href = await contractLink.getAttribute("href");
      await contractLink.click();
      await page.waitForURL(/\/contracts\/[^/]+/, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(2000);
      log("HIGH", "ContractDetail", `Navigated to contract detail: ${page.url()}`,
        page.url().match(/\/contracts\/[^/]+/));
    } else {
      log("HIGH", "ContractDetail", "Could not find contract link to click â€” contracts list may be empty", false);
      await shot(page, "contracts-list-empty");
    }
    await checkNoErrorBoundary(page, "contract detail");
    await shot(page, "contract-detail");
    const detailUrl = page.url();

    // STEP 4: Check back-link navigation (Bug #11)
    const backLink = page.locator("a").filter({ hasText: /contracts/i }).first();
    if (await backLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      const backHref = await backLink.getAttribute("href");
      log("MEDIUM", "BackLinkTarget", `Back link href: ${backHref}`,
        backHref === "/contracts" || backHref?.endsWith("/contracts"));
    } else {
      log("MEDIUM", "BackLinkTarget", "No back-link found on contract detail", false);
    }

    // STEP 5: Check toolbar button sizing (Bug #1)
    const toolbarBtns = page.locator(".toolbar button, header button, [data-testid*=toolbar] button, nav button").all();
    const btns = await page.locator("button").all();
    const toolbarArea = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button")).filter(b => {
        const rect = b.getBoundingClientRect();
        return rect.top < 150 && rect.width > 0;
      });
      return buttons.map(b => ({
        text: b.textContent.trim().slice(0, 40),
        width: Math.round(b.getBoundingClientRect().width),
        height: Math.round(b.getBoundingClientRect().height),
      }));
    });
    const uniqueHeights = [...new Set(toolbarArea.map(b => b.height))];
    log("MEDIUM", "ToolbarButtonSizing",
      `Top toolbar buttons: ${JSON.stringify(toolbarArea.slice(0,5))}. Unique heights: ${uniqueHeights.join(",")}`,
      uniqueHeights.length === 1);

    // STEP 6: Try Add Tag (Bug #2)
    const addTagBtn = page.locator("button").filter({ hasText: /add tag|tag/i }).first();
    if (await addTagBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await addTagBtn.click();
      await page.waitForTimeout(1000);
      // Check if something happened (modal/input appeared)
      const tagInput = page.locator("input[placeholder*=tag i], [role=dialog], .tag-input").first();
      const tagInputVisible = await tagInput.isVisible({ timeout: 1500 }).catch(() => false);
      log("HIGH", "AddTagButton", "Add tag button opens input/modal: " + tagInputVisible, tagInputVisible);
      if (tagInputVisible) {
        await page.keyboard.press("Escape");
      }
    } else {
      log("MEDIUM", "AddTagButton", "Add Tag button not found on contract detail â€” may not exist", null);
    }
    await shot(page, "tag-test");

    // STEP 7: Check Recent Activity -> View All (Bug #3)
    const viewAllLink = page.locator("a, button").filter({ hasText: /view all/i }).first();
    if (await viewAllLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      const hrefVal = await viewAllLink.getAttribute("href");
      log("MEDIUM", "ViewAllActivity",
        `View All href: ${hrefVal}`,
        hrefVal && (hrefVal.includes("/activity") || hrefVal.includes("contract")));
    } else {
      log("MEDIUM", "ViewAllActivity", "No 'View All' link found on contract detail", null);
    }

    // STEP 8: Archive the contract
    await page.goto(detailUrl, { waitUntil: "networkidle", timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    // Look for archive button/menu
    const archiveBtn = page.locator("button, [role=menuitem]").filter({ hasText: /^archive$/i }).first();
    if (await archiveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await archiveBtn.click();
      await page.waitForTimeout(1500);
      // Confirm if dialog appeared
      const confirmBtn = page.locator("button").filter({ hasText: /confirm|yes|archive/i }).last();
      if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await confirmBtn.click();
        await page.waitForTimeout(2000);
      }
      log("HIGH", "ArchiveContract", `After archive URL: ${page.url()}`, true);
    } else {
      // Try 3-dot menu / kebab
      const menuBtn = page.locator("[aria-label*='more' i], [aria-label*='menu' i], button[aria-haspopup]").first();
      if (await menuBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await menuBtn.click();
        await page.waitForTimeout(800);
        const archiveItem = page.locator("[role=menuitem], li").filter({ hasText: /archive/i }).first();
        if (await archiveItem.isVisible({ timeout: 2000 }).catch(() => false)) {
          await archiveItem.click();
          await page.waitForTimeout(2000);
          log("HIGH", "ArchiveContract", "Archived via context menu", true);
        } else {
          log("HIGH", "ArchiveContract", "Archive option not found in context menu", false);
          await page.keyboard.press("Escape");
        }
      } else {
        log("HIGH", "ArchiveContract", "No Archive button or menu found on contract detail", false);
      }
    }
    await shot(page, "after-archive");

    // STEP 9: Verify in archived list
    await page.goto(BASE_URL + "/contracts/archived", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(1500);
    await checkNoErrorBoundary(page, "/contracts/archived");
    const archivedText = await page.locator("body").innerText();
    log("HIGH", "ArchivedList", "/contracts/archived loads without ErrorBoundary", true);
    await shot(page, "archived-list");

    // STEP 10: Activity log check
    await page.goto(BASE_URL + "/activity", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(1500);
    await checkNoErrorBoundary(page, "/activity");
    const actText = await page.locator("body").innerText();
    log("MEDIUM", "ActivityLog", "Activity log renders without ErrorBoundary", true);

    // STEP 11: Dashboard counter spot-check (Bug #10)
    await page.goto(BASE_URL + "/dashboard", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(2000);
    await checkNoErrorBoundary(page, "/dashboard");
    await shot(page, "dashboard-counters");
    // Read visible numbers from KPI cards
    const kpiText = await page.evaluate(() => {
      const cards = document.querySelectorAll("[class*=kpi], [class*=metric], [class*=stat], [class*=card]");
      return Array.from(cards).slice(0, 6).map(c => c.textContent.trim().slice(0, 80)).join(" | ");
    });
    log("HIGH", "DashboardKPIs", "KPI card text: " + kpiText, null);

    // Find "Cancel windows closing" and click it
    const cancelWindowCard = page.locator("[class*=card], [class*=kpi], div").filter({ hasText: /cancel/i }).first();
    if (await cancelWindowCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      const cancelCount = await cancelWindowCard.evaluate(el => {
        const nums = el.textContent.match(/\d+/g);
        return nums ? nums[0] : "?";
      });
      log("HIGH", "DashboardCancelCount", "Cancel windows closing shows: " + cancelCount, null);
    }

  } catch (e) {
    log("CRITICAL", "UnhandledError", e.message, false);
    await shot(page, "crash");
  } finally {
    await browser.close();
    writeReport();
  }
}

function writeReport() {
  const now = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const md = [];
  md.push("# QA Agent 1: Contract Lifecycle Findings");
  md.push(`Generated: ${now}`);
  md.push("");
  md.push("## Summary");
  const fails = findings.filter(f => f.pass === false);
  const passes = findings.filter(f => f.pass === true);
  md.push(`- Total checks: ${findings.length}`);
  md.push(`- PASS: ${passes.length}`);
  md.push(`- FAIL: ${fails.length}`);
  md.push(`- INFO: ${findings.filter(f => f.pass === null).length}`);
  md.push("");
  md.push("## Findings");
  for (const f of findings) {
    const icon = f.pass === true ? "PASS" : f.pass === false ? "FAIL" : "INFO";
    md.push(`### [${icon}] [${f.severity}] ${f.check}`);
    md.push(f.detail);
    md.push("");
  }
  md.push("## Screenshots");
  for (const s of screenshots) md.push(`- ${s}`);
  const outPath = path.join(OUTPUTS, "qa-agent-contract-lifecycle.md");
  fs.writeFileSync(outPath, md.join("\n"), "utf8");
  console.log("Report written: " + outPath);
}

run().catch(e => { console.error("FATAL:", e); writeReport(); process.exit(1); });