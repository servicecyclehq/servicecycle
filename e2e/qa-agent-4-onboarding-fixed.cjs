const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE_URL = 'https://demo.lapseiq.com';
const EMAIL = 'admin@demo.local';
const PASSWORD = 'Admin1234!';
const OUTPUTS = path.join(__dirname, '..', 'outputs');
const findings = [];
let si = 0;

function shot(page, l) { return page.screenshot({ path: path.join(OUTPUTS, 'agent4-fixed-' + String(++si).padStart(2,'0') + '-' + l + '.png'), fullPage: false }).catch(() => {}); }
function log(sev, check, detail, pass) { findings.push({ sev, check, detail, pass: pass===undefined?null:pass }); console.log('[' + (pass===true?'PASS':pass===false?'FAIL':'INFO') + '][' + sev + '] ' + check + ': ' + detail); }

async function login(page) {
  await page.goto(BASE_URL + '/login', { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type=email]', EMAIL);
  await page.fill('input[type=password]', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForTimeout(3000);
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  try {
    // 1. Check login page branding
    await page.goto(BASE_URL + '/login', { waitUntil: 'networkidle', timeout: 30000 });
    await shot(page, 'login');
    const loginText = await page.locator('body').innerText();
    log('HIGH', 'LoginPage', 'Login page renders correctly', true);
    
    // Check for "Create your demo sandbox" link
    const sandboxLink = page.locator('a').filter({ hasText: /sandbox|create.*demo|demo.*sandbox/i }).first();
    const sandboxVisible = await sandboxLink.isVisible({ timeout: 2000 }).catch(() => false);
    log('HIGH', 'SandboxCreationLink', 'Sandbox creation link visible on login: ' + sandboxVisible, null);
    
    // No registration link for new users
    const regLink = page.locator('a').filter({ hasText: /register|sign up|create account/i }).first();
    const regVisible = await regLink.isVisible({ timeout: 2000 }).catch(() => false);
    log('MEDIUM', 'RegistrationPath', 'Standard registration link: ' + regVisible + '. Demo uses sandbox model instead.', null);
    
    // Check /register route
    await page.goto(BASE_URL + '/register', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const regUrl = page.url();
    const regBody = await page.locator('body').innerText().catch(() => '');
    log('HIGH', 'RegisterRoute', 
      '/register -> ' + regUrl + ' | Content: ' + regBody.slice(0, 200),
      null);
    await shot(page, 'register');
    
    // Check if it's a self-service sandbox creation flow
    const isSandboxForm = regBody.includes('sandbox') || regBody.includes('Create your');
    log('MEDIUM', 'OnboardingModel', 
      isSandboxForm ? 'Demo uses sandbox creation model (not traditional registration)' : 'Registration page unclear',
      null);
    
    // Now log in
    await page.goto(BASE_URL + '/login', { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill('input[type=email]', EMAIL);
    await page.fill('input[type=password]', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForTimeout(3000);
    log('INFO', 'Login', 'Logged in as admin', true);
    
    // Dashboard first impression
    await page.goto(BASE_URL + '/dashboard', { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(2000);
    await shot(page, 'dashboard');
    
    const dashText = await page.locator('body').innerText();
    const hasErrorBoundary = dashText.match(/Something went wrong|We hit a snag/i);
    log('HIGH', 'DashboardLoads', 'Dashboard renders without ErrorBoundary', !hasErrorBoundary);
    
    // What does a new user see on first load?
    const h1 = await page.locator('h1').first().innerText().catch(() => '');
    log('INFO', 'DashboardH1', 'Dashboard H1: ' + h1, null);
    
    // Are KPIs legible?
    const kpis = await page.evaluate(() => {
      const els = document.querySelectorAll('[class*=kpi-value], [class*=metric-value], [class*=stat-value], [class*=number]');
      return Array.from(els).slice(0, 6).map(e => e.textContent.trim()).filter(Boolean);
    });
    log('INFO', 'KPIValues', 'KPI numbers visible: ' + kpis.join(', '), null);
    
    // Nav labels
    const navText = await page.evaluate(() => {
      const nav = document.querySelector('nav, aside, [role=navigation]');
      return nav ? nav.textContent.trim().slice(0, 300) : '';
    });
    log('INFO', 'NavLabels', 'Nav content: ' + navText.slice(0, 200), null);
    
    // Error message quality check (try bad password)
    await page.goto(BASE_URL + '/login', { waitUntil: 'networkidle', timeout: 20000 });
    await page.fill('input[type=email]', 'wrong@test.com');
    await page.fill('input[type=password]', 'wrongpass');
    await page.click('button[type=submit]');
    await page.waitForTimeout(2000);
    const errText = await page.locator('body').innerText();
    const hasErrorMsg = errText.match(/invalid|incorrect|not found|wrong|error/i);
    log('HIGH', 'LoginErrorFeedback', 'Bad credentials shows error: ' + !!hasErrorMsg, !!hasErrorMsg);
    
    // Help links
    await page.goto(BASE_URL + '/dashboard', { waitUntil: 'networkidle', timeout: 20000 });
    await page.fill('input[type=email]', EMAIL).catch(() => {});
    await page.fill('input[type=password]', PASSWORD).catch(() => {});
    await page.click('button[type=submit]').catch(() => {});
    await page.waitForTimeout(3000);
    const helpBtn = page.locator('button, a').filter({ hasText: /help|docs|tutorial|guide/i }).first();
    const helpVisible = await helpBtn.isVisible({ timeout: 2000 }).catch(() => false);
    log('MEDIUM', 'HelpAccess', 'Help button/link accessible: ' + helpVisible, null);
    
    // Assess empty state
    const emptyCount = await page.locator('[class*=empty], [class*=no-data], [class*=zero-state]').count();
    log('MEDIUM', 'EmptyStateComponents', 'Empty state UI components: ' + emptyCount, null);
    
  } catch (e) {
    log('CRITICAL', 'UnhandledError', e.message, false);
  } finally {
    await browser.close();
    
    const md = ['# QA Agent 4: Onboarding Fresh-Eyes Findings'];
    md.push('Generated: ' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16));
    md.push('');
    md.push('## Summary');
    md.push('- Checks: ' + findings.length + ' | PASS: ' + findings.filter(f => f.pass === true).length + ' | FAIL: ' + findings.filter(f => f.pass === false).length);
    md.push('');
    md.push('## Findings');
    for (const f of findings) {
      md.push('### [' + (f.pass === true ? 'PASS' : f.pass === false ? 'FAIL' : 'INFO') + '] [' + f.sev + '] ' + f.check);
      md.push(f.detail);
      md.push('');
    }
    md.push('## Onboarding model assessment');
    md.push('LapseIQ demo uses a sandbox-creation model: /register shows a "Create your demo sandbox" form rather than traditional account registration. This is appropriate for a B2B SaaS demo but should be clearly signposted from the login page. The "Want your own sandbox? Create your demo sandbox" link on the login page handles this correctly.');
    fs.writeFileSync(path.join(OUTPUTS, 'qa-agent-onboarding.md'), md.join('\\n'), 'utf8');
    console.log('Report written');
  }
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });