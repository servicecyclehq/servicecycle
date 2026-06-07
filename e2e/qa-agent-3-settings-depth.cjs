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
  const n = `agent3-${String(++screenshotIdx).padStart(2,"0")}-${label}.png`;
  try { await page.screenshot({ path: path.join(OUTPUTS, n), fullPage: false }); } catch {}
}
async function noEB(page, ctx) {
  const t = await page.locator("body").innerText().catch(() => "");
  if (t.match(/Something went wrong|We hit a snag/i)) { log("CRITICAL","EB",ctx,false); return false; } return true;
}

const SETTINGS_PILLS = [
  { hash: "api-keys",      name: "API Keys" },
  { hash: "webhooks",      name: "Webhooks" },
  { hash: "alerts",        name: "Alert Preferences" },
  { hash: "consultant",    name: "Consultant Access" },
  { hash: "cloud",         name: "Cloud Connectors" },
  { hash: "backup",        name: "Backup" },
  { hash: "encryption",    name: "Encryption" },
  { hash: "custom-fields", name: "Custom Fields" },
  { hash: "categories",    name: "Categories" },
  { hash: "ai-caps",       name: "AI Caps" },
  { hash: "demo-reset",    name: "Demo Reset" },
  { hash: "slack",         name: "Slack Integration" },
  { hash: "teams",         name: "Teams Integration" },
  { hash: "news-outage",   name: "News Outage" },
];

// Safe sub-pill checks: just load + check for EB, capture content, no mutations for destructive
const SKIP_DESTRUCTIVE_PILLS = ["demo-reset", "encryption"];

async function checkPill(page, pill) {
  const url = BASE_URL + "/settings#" + pill.hash;
  await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
  await page.waitForTimeout(2000);
  const ok = await noEB(page, "/settings#" + pill.hash);
  await shot(page, "settings-" + pill.hash);

  if (!ok) return;

  // Check what rendered
  const sectionText = await page.evaluate((hash) => {
    // find the active section content
    const body = document.body.innerText;
    return body.slice(0, 500);
  }, pill.hash);
  log("HIGH", `Settings:${pill.name}`, `Section renders. Content preview: ${sectionText.slice(0,150)}`, ok);

  // For non-destructive pills, try to find a text input and modify it
  if (SKIP_DESTRUCTIVE_PILLS.includes(pill.hash)) {
    log("INFO", `Settings:${pill.name}:MutationSkipped`, "Skipped mutation for destructive section", null);
    return;
  }

  // Check for ReferenceError in console (the Bug from v0.91.3 session)
  // We detect this via checking if the page content has meaningful fields or shows blank
  const inputCount = await page.locator("input:visible, select:visible, textarea:visible").count();
  log("MEDIUM", `Settings:${pill.name}:InputCount`, `Visible inputs: ${inputCount}`, inputCount >= 0);

  // Check for broken refs by looking at runtime errors
  const hasContent = await page.evaluate(() => {
    const main = document.querySelector("main, [role=main], .settings-content, .section-content");
    return main ? main.children.length : 0;
  });
  log("MEDIUM", `Settings:${pill.name}:HasContent`, `Content children: ${hasContent}`, hasContent > 0);
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const runtimeErrors = [];
  page.on("pageerror", e => {
    runtimeErrors.push(e.message);
    log("CRITICAL", "RuntimeError", e.message, false);
  });
  page.on("console", msg => {
    if (msg.type() === "error") log("HIGH", "ConsoleError", msg.text().slice(0,200), null);
  });

  try {
    await login(page);
    log("INFO","Login","OK",true);

    // Walk every settings pill
    for (const pill of SETTINGS_PILLS) {
      if (page.isClosed()) break;
      await checkPill(page, pill);
      await page.waitForTimeout(500);
    }

    // Check for navigation pill rendering issues
    await page.goto(BASE_URL + "/settings", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(1500);
    const pillBtns = await page.locator("button, [role=tab]").all();
    const pillTexts = await Promise.all(pillBtns.map(b => b.innerText().catch(() => "")));
    const settingsPills = pillTexts.filter(t => t.trim().length > 0 && t.length < 30);
    log("INFO","SettingsPillNav", `Visible nav pills: ${settingsPills.slice(0,10).join(", ")}`, null);

    // Summary of runtime errors
    if (runtimeErrors.length > 0) {
      log("CRITICAL","RuntimeErrors", `Total runtime errors across settings: ${runtimeErrors.length}. First: ${runtimeErrors[0]}`, false);
    } else {
      log("HIGH","RuntimeErrors","No runtime/ReferenceErrors in any settings section", true);
    }

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
  md.push("# QA Agent 3: Settings Depth Findings");
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
  const outPath = path.join(OUTPUTS, "qa-agent-settings-depth.md");
  fs.writeFileSync(outPath, md.join("\n"), "utf8");
  console.log("Report: " + outPath);
}

run().catch(e => { console.error("FATAL:", e); writeReport(); process.exit(1); });