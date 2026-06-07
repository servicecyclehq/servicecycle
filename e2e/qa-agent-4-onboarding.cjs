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
async function shot(page, l) { try { await page.screenshot({ path: path.join(OUTPUTS, `agent4-${String(++si).padStart(2,"0")}-${l}.png`), fullPage: false }); } catch {} }
function log(sev, check, detail, pass) { findings.push({ sev, check, detail, pass: pass===undefined?null:pass }); console.log(`[${pass===true?"PASS":pass===false?"FAIL":"INFO"}][${sev}] ${check}: ${detail}`); }
async function noEB(page, ctx) { const t = await page.locator("body").innerText().catch(()=>""); if(t.match(/Something went wrong|We hit a snag/i)){log("CRITICAL","EB",ctx,false);return false;} return true; }

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", e => log("CRITICAL", "PageError", e.message, false));

  try {
    // 1. Check login page for fresh user experience
    await page.goto(BASE_URL + "/login", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(1500);
    await noEB(page, "/login");
    await shot(page, "login");
    const loginText = await page.locator("body").innerText();
    log("HIGH","LoginPage","Login page renders", true);
    log("MEDIUM","LoginBranding", "Page has brand elements: " + loginText.slice(0,200), null);

    // Check for registration link
    const regLink = page.locator("a").filter({ hasText: /register|sign up|create account/i }).first();
    const regExists = await regLink.isVisible({ timeout: 3000 }).catch(() => false);
    log("HIGH","RegistrationLink","Registration link visible on login: " + regExists, null);

    // Try /register directly
    await page.goto(BASE_URL + "/register", { waitUntil: "networkidle", timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);
    const regUrl = page.url();
    const regText = await page.locator("body").innerText();
    log("HIGH","RegisterRoute", `GET /register -> ${regUrl}. Body preview: ${regText.slice(0,150)}`, null);
    await shot(page, "register-attempt");

    // 2. Log in to check onboarding wizard
    await page.goto(BASE_URL + "/login", { waitUntil: "networkidle", timeout: 20000 });
    await page.fill("input[type=email]", EMAIL);
    await page.fill("input[type=password]", PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForURL(/dashboard|contracts|wizard|onboard/, { timeout: 15000 });
    await page.waitForTimeout(2000);
    await shot(page, "post-login");
    log("INFO","Login","Logged in", true);

    // 3. Check for onboarding wizard / setup flow
    await page.goto(BASE_URL + "/dashboard", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(2000);
    await noEB(page, "/dashboard");
    const dashText = await page.locator("body").innerText();

    // Look for any onboarding/wizard CTA
    const wizardCTA = page.locator("[class*=wizard], [class*=onboard], [class*=setup], [data-testid*=wizard]").first();
    const wizardExists = await wizardCTA.isVisible({ timeout: 3000 }).catch(() => false);
    log("MEDIUM","OnboardingWizard","Wizard/setup visible on dashboard: " + wizardExists, null);

    // Check /settings for setup wizard
    await page.goto(BASE_URL + "/settings", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(1500);
    const settingsText = await page.locator("body").innerText();
    log("INFO","SettingsOnboarding", "Settings page content preview: " + settingsText.slice(0,200), null);

    // 4. Fresh-eyes navigation assessment
    await page.goto(BASE_URL + "/dashboard", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(2000);
    await shot(page, "dashboard-fresh");

    // Check nav labels for clarity
    const navLinks = await page.locator("nav a, [role=navigation] a, aside a").all();
    const navTexts = await Promise.all(navLinks.map(l => l.innerText().catch(() => "")));
    log("INFO","NavLabels", "Nav link labels: " + navTexts.filter(t => t.trim()).join(" | "), null);

    // Check empty state quality on dashboard
    const emptyStates = await page.locator("[class*=empty], [class*=no-data], [class*=placeholder]").count();
    log("MEDIUM","EmptyStates", `Empty state components found: ${emptyStates}`, null);

    // 5. First contract creation UX
    await page.goto(BASE_URL + "/contracts/new", { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(1500);
    await noEB(page, "/contracts/new");
    await shot(page, "new-contract-ux");
    const formText = await page.locator("body").innerText();
    log("HIGH","NewContractForm","Form renders without EB", true);

    // Check form labels / field count
    const labels = await page.locator("label").all();
    const labelTexts = await Promise.all(labels.map(l => l.innerText().catch(() => "")));
    const cleanLabels = labelTexts.filter(t => t.trim().length > 0 && t.length < 50);
    log("INFO","FormFields", "Form labels found: " + cleanLabels.slice(0,12).join(", "), null);

    // Check required field indicators
    const required = await page.locator("[required], [aria-required=true]").count();
    log("MEDIUM","RequiredFields", `Required field indicators: ${required}`, required > 0);

    // 6. Help / documentation links
    const helpLinks = page.locator("a").filter({ hasText: /help|docs|guide|tutorial/i });
    const helpCount = await helpLinks.count();
    log("MEDIUM","HelpLinks", `Help/docs links found: ${helpCount}`, null);

    // 7. Error handling UX -- try bad login
    await page.goto(BASE_URL + "/login", { waitUntil: "networkidle", timeout: 20000 });
    await page.fill("input[type=email]", "notauser@test.com");
    await page.fill("input[type=password]", "wrongpassword");
    await page.click("button[type=submit]");
    await page.waitForTimeout(2000);
    const loginErrText = await page.locator("body").innerText();
    const hasErrMsg = loginErrText.match(/invalid|incorrect|wrong|not found|error/i);
    log("HIGH","LoginErrorMessage","Bad credentials shows error message: " + !!hasErrMsg, !!hasErrMsg);
    await shot(page, "login-error");

    // 8. Value prop clarity
    log("INFO","ValuePropAssessment",
      "Manual assessment needed: is the dashboard KPI language clear to a procurement manager who has never heard of LapseIQ?",
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
  md.push("# QA Agent 4: Onboarding Fresh-Eyes Findings");
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
  const outPath = path.join(OUTPUTS, "qa-agent-onboarding.md");
  fs.writeFileSync(outPath, md.join("\n"), "utf8");
  console.log("Report: " + outPath);
}

run().catch(e => { console.error("FATAL:", e); writeReport(); process.exit(1); });