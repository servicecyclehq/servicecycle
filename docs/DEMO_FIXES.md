# ServiceCycle - Demo Punch List & Fresh-Session Fixing Prompt

You are picking up a **live, deployed ServiceCycle demo** to work through a punch list of fixes
found by clicking through the running app. Work in the repo (source of truth), then redeploy to
the live demo and verify each fix behind the gate.

---

## Live deployment context

- **Repo (source of truth):** `C:\Users\ddeni\Desktop\ServiceCycle` - committed & pushed to `origin/main` (servicecyclehq/servicecycle).
- **Live demo:** `https://servicecycle.app` - behind an nginx HTTP basic-auth gate (user `dustin`, password given in the kickoff message). App login: `admin@demo.local / Admin1234!` (also `manager@`, `viewer@`, `consultant@demo.local`).
- **Droplet:** `198.211.99.45` (Ubuntu 24.04, 1 GB RAM + 3 GB swap, 1 vCPU). Root SSH key: `C:\Users\ddeni\.ssh\id_ed25519` (unencrypted).
- **On the droplet:**
  - App stack (Docker Compose) in `/root/ServiceCycle`: services `db` + `server-migrate` + `server`. `.env` there holds prod config (`SERVER_PORT=3002`, `MASTER_KEY`, `JWT_SECRET`, `EMAIL_MOCK=true`, `AI_ENABLED=false`, `NODE_ENV=production`). The API listens on host `127.0.0.1:3002`.
  - The **client is NOT a container** - it is built locally and served as static files by host nginx from `/var/www/servicecycle/html` (avoids a 2 GB vite build OOM on the small box).
  - Host **nginx** fronts `servicecycle.app` (TLS via certbot/Let's Encrypt) and proxies `/api` -> `127.0.0.1:3002`. The same nginx also serves the `vps-control` MCP on `198-211-99-45.sslip.io`. Gate config: `/etc/nginx/sites-available/servicecycle`, htpasswd at `/etc/nginx/.htpasswd-servicecycle`.
  - The **vps-control MCP** is connected in Cowork (run commands on the droplet through that connector).

## Deploy mechanics (read before deploying)

- `ssh.exe` is **broken** in the windows-shell MCP (it swallows all output, exit 255). Reach the droplet either via the connected **vps-control MCP** (run_approved_command etc.) or a **Node `ssh2`** client (the key is unencrypted; a small runner that reads a command from a file and streams stdout works well).
- **Client / UI fix:** `cd client && npm run build` (fast, ~3 s) -> upload `client/dist/*` to droplet `/var/www/servicecycle/html` via SFTP -> hard-refresh the browser. No restart.
- **Server / API fix:** edit server source -> upload to `/root/ServiceCycle` -> `docker compose up -d --build server` (rebuilds db/migrate/server; ~2-4 min on this box).
- **Always fix in the repo and commit/push.** The droplet is downstream of the repo.
- WARNING - **repo/droplet drift:** the droplet's `docker-compose.yml` already has two live fixes that are **not yet in the repo** (see 0.1). Reconcile those into the repo FIRST, or a full re-upload of the repo will re-break the database.

## Working approach

- Batch by area + build type: do all server/data work in one rebuild; batch client uploads.
- Verify each fix on `https://servicecycle.app` (behind the gate, logged in as `admin@demo.local`). If a description is ambiguous, drive the live app via the Claude-in-Chrome extension to see exactly what the issue is.
- Repo is authoritative: every fix = code change + commit, then redeploy.

---

## Backlog (ordered)

### 0. Repo hygiene / infra  [all added by review - do first]
- **0.1 Commit the live compose fixes to the repo.** In `docker-compose.yml`: add the missing top-level `volumes:` block (`postgres_data:`), and remove `read_only: true` + the `cap_drop: [ALL]` block from the `db` service (Postgres can't chown `/var/lib/postgresql/data` under them and crash-loops; `docker-compose.ghcr.yml` already did this rollback). Apply the same to `server` for parity. Keep `no-new-privileges`, tmpfs, pids/mem limits.
- **0.2 Fix the express-rate-limit IPv6 ValidationError** logged at server startup: the custom `keyGenerator` functions (e.g. `_credKey` in `routes/auth.ts`, the apiLimiter keygen in `index.ts`) must pass the client IP through express-rate-limit's `ipKeyGenerator()` helper so IPv6 clients can't bypass limits.
- **0.3 Investigate the `prisma.accountSetting.upsert()` FK violation** (`account_settings_accountId_fkey`) firing from a cron/startup task (likely `lib/aiBudgetGuard.ts`) against a non-existent `accountId`. Scope the upsert to accounts that actually exist.

### 1. Global / cross-cutting (shared components - high leverage)
- **1.1 Back navigation, platform-wide.** Every "<- back" link must return to the *actual* previous page (use router history / a `from` location), not a fixed parent. Known failures: Outage Planner -> "View Asset" -> the "<- Assets" link goes to the Assets list instead of back to Outage Planner; the Deficiencies page reached from a dashboard tile has **no** back link. Audit every detail page for a correct back affordance. (User reported this 3 separate times - treat as one systemic fix.)
- **1.2 Sticky top toolbar.** Anchor each page's top bar / title so it doesn't scroll away on long pages.
- **1.3 Colored pills/badges - text contrast.** Darken the text on all colored pills (dark mode for sure, probably light mode too); not enough contrast now. Fix in the shared Pill/Badge component + color tokens.
- **1.4 Help drawer dismissal.** When the user navigates to a different page, close/replace the open help panel. Today: open Reports help, click Contractors -> the Reports help persists. Make it go away (one less click).
- **1.5 Branding sweep (whole codebase).**  [scope extended by review]
  - **Remove every `servicecycle.com` mention and email address** - we own `servicecycle.app`, not `.com`. Replace support/contact emails accordingly.
  - **Update the logo:** browser-tab favicon and the logo on the legal docs. Also replace the **placeholder PWA icons** (noted in `client/vite.config.js` / `public/icons`).
  - Audit residual **"LapseIQ"** leftovers in ServiceCycle (e.g. `LAPSEIQ_VERSION` env var, backup magic-header comments, stray UI strings).

### 2. Data seeding (so every page/report shows content)  [mostly server]
- **2.1 Seed a few audits** (audit visits + recommendations) so the Audits page and audit-related reports populate.
- **2.2 Ensure every report is seeded with data.** Walk each report and confirm it's non-empty - deficiencies across all severities, work orders, schedules, compliance snapshots, test measurements, etc.
- **2.3 Seed industry news items.** The News page pulls nothing (news scanner has no external source with AI off) - seed sample news so it's populated.
- **2.4 Weather alerts.** Seed sample alerts and confirm where they surface (sidebar indicator? banner?). Document the intended surface; user wasn't sure if it's silent or banner-only.
- **2.5 First-run tour.** Ensure the "Welcome to ServiceCycle" tour fires on a fresh demo login (reset `onboardingStep`). Note: `admin@demo` may have already advanced past it during setup - test with a fresh user.
- **2.6 (Repeatable demos)  [added]** Have `scripts/seed-demo.js` optionally set `InstanceConfig.setupCompletedAt` so a freshly seeded instance is usable immediately (currently requires a manual SQL `UPDATE`). Gate behind a flag so real installs still run the wizard.

### 3. Dashboard
- **3.1 "Open deficiencies by severity"** - reformat the tile text (the bullet point looks off - drop it or restyle), AND condense the whole section; it eats too much vertical real estate.
- **3.2 "Priority assets"** - replace the harsh light-red/pink pill colors (hard on the eyes).
- **3.3 "Maintenance horizon - next 36 months"** - equalize the spacing between the monthly squares across all years (the first two squares in 2029 are visibly off), AND move the whole module higher on the dashboard; it's valuable and currently buried/underused.
- **3.4 "Overall compliance rate"** - normalize the big 89% text size to match the "Due in XX days" cards above it (too large / inconsistent now).
- **3.5 Drill-downs must deep-link WITH the filter applied.**
  - "Due in 30 days = 6" -> opens Compliance Calendar but should filter to exactly those 6.
  - "Open deficiencies by severity" links -> Deficiencies filtered to that severity (and that page needs a back link, see 1.1).
  - Generalize: any count/tile that drills down should land pre-filtered to the same set the number references.

### 4. Page-specific
- **4.1 Equipment Templates** - page throws "route not found". Fix the broken route (client router and/or missing server route).
- **4.2 Disaster Response -> "Declare Emergency" modal** - opaque background. Right now it's transparent and the page bleeds through (unreadable). Give the modal a solid background/overlay.
- **4.3 Import Data -> "Source system" options** - unreadable in dark mode (white background + white/near-white text). Darken the option text; white bg is fine.
- **4.4 Field Mode.**
  - Move the Field Mode sidebar link to the very top or very bottom (awkward mid-list now) - reps should reach it fast.
  - Add easy filters (is the Site filter enough? consider equipment-type / due-status quick filters).
  - Confirm the installed PWA opens into Field Mode by default on a phone (`start_url` is `/field` - verify the behavior).
- **4.5 Outage Planner copy** - beef up the explanation/descriptions: what the planner does, what an outage window looks like, how to read the output. Good start, needs more substance to be genuinely useful.

### 5. Larger features (scope separately - do last)
- **5.1 Assets - Excel-style per-column header filters.** Model on LapseIQ's contract-page column filtering. Dustin approved a **one-time** look at the LapseIQ code to review/adapt that filtering - adapt it to ServiceCycle's asset columns.
- **5.2 Help - "Ask ServiceCycle AI" chatbot** (like LapseIQ's). Seed the help corpus well; have customers supply their own API key for usage. Lower priority / product decision - confirm with Dustin before building.

---

## Suggested execution order (minimizes rebuilds)

1. **Batch A (one server rebuild):** 0.1-0.3, all of section 2 (seeding), 4.1 if it needs a server route.
2. **Batch B (client rebuild):** 1.1-1.5, 4.2-4.4.
3. **Batch C (client rebuild):** all of section 3 (dashboard).
4. **Batch D (client + maybe server):** 3.5 deep-links, 4.5.
5. **Batch E (separate efforts):** 5.1, then 5.2 if approved.

Verify each batch on the live gated demo before moving to the next. Commit + push after each batch.
