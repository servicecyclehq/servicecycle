# ServiceCycle Self-Host / Air-Gap Guide

**Audience:** utilities, federal sites, and large industrials whose security policy is "no customer data leaves our network."
**Companion docs:** `DEPLOY_RUNBOOK.md` (the step-by-step Docker Compose mechanics) and `SECURITY_TRUST_PACK.md` (the security posture). This document is the *productization* layer: what a fully self-hosted / air-gapped install looks like and how to configure it so nothing egresses.

> **Why ServiceCycle can run air-gapped at all:** the core data-in engine — the deterministic PDF/test-report parser (`server/pyextract`, pdfplumber + tesseract OCR) — runs **entirely inside the container**. Reading a test report never requires a third party. AI is the *only* component that can reach outside the network, and it is off by default and opt-in (BYO-AI). Turn AI off and the product is fully local with zero outbound dependencies beyond your own database.

---

## 1. What an air-gapped install includes (and excludes)

| Capability | Air-gapped behavior |
|---|---|
| Asset register, schedules, work orders, deficiencies, compliance math, Path-to-100 | **Fully local.** No external calls. |
| Deterministic document ingest (PDF/photo → measurements), nameplate OCR (tesseract) | **Fully local** in-container. |
| Compliance snapshots + EMP PDFs + hash-chained audit log + SIEM export | **Fully local.** |
| AI assist (maintenance brief, AI gap-fill on thin reports, photo-inspect type guess) | **Off by default.** Optional via BYO-AI (your key, your provider). Leave `AI_ENABLED=false` for a true air-gap. |
| Email notifications (digests, alerts) | Optional. Point at your **internal SMTP/Brevo**, or set `EMAIL_MOCK=true` to disable outbound mail. |
| Backups | Local volume by default; S3 only if you explicitly configure it. |
| Object storage (documents, photos, snapshots) | Local disk by default (`STORAGE_DEST=local`). |
| Stripe billing | Off (`STRIPE_ENABLED=false`). Licensed instances bypass billing entirely. |

Nothing in the first three rows ever makes an outbound connection. The only configurable egress points are AI (off by default), email (your server or mocked), backups (local unless you opt into S3), and the news/weather scanners (off unless enabled).

---

## 2. Licensing seam

Self-hosted instances run as `planType=licensed`:

- **Stripe is bypassed** — no checkout, no subscription enforcement, no calls to Stripe.
- **Demo caps are off** — the per-user AI demo metering and the shared budget guard (`lib/aiBudgetGuard`) are no-ops whenever `DEMO_MODE !== 'true'`. A licensed install has no artificial scan/brief caps.
- The account is provisioned through the first-run setup wizard (`/api/setup`) rather than a hosted signup.

Offline license-key validation and an update channel are the remaining productization work (tracked); today a licensed instance is provisioned by setting `DEMO_MODE=false` + `STRIPE_ENABLED=false` and running the setup wizard.

---

## 3. Minimal air-gapped `.env`

Set these in `/path/to/ServiceCycle/.env` next to `docker-compose.yml`. Values marked **required** have no safe default.

```dotenv
# ── Core ──────────────────────────────────────────────────────────────
NODE_ENV=production
DEMO_MODE=false                       # licensed install — no demo caps
REGISTRATION_OPEN=false               # provision users via the wizard/admin only
SERVER_PORT=3001
SERVICECYCLE_HOST_BIND=127.0.0.1      # API bound to loopback; your proxy fronts it
TRUST_PROXY=1                         # if behind nginx/Caddy on the same host

# ── Database ──────────────────────────────────────────────────────────
POSTGRES_DB=servicecycle
POSTGRES_USER=servicecycle
POSTGRES_PASSWORD=__required__        # required
# DATABASE_URL is derived from the above inside compose

# ── Secrets (generate locally; never reuse across installs) ───────────
MASTER_KEY=__required__               # 44-char base64 of 32 random bytes — encrypts secrets at rest
JWT_SECRET=__required__               # long random string
JWT_EXPIRES_IN=1h

# ── No outbound by default ────────────────────────────────────────────
AI_ENABLED=false                      # true air-gap. Set true + BYO key only if you accept that egress.
STRIPE_ENABLED=false
EMAIL_MOCK=true                       # or configure internal SMTP/Brevo + set EMAIL_FROM/SUPPORT_EMAIL
NEWS_SCANNER_ENABLED=false
SLACK_ENABLED=false
STORAGE_DEST=local                    # documents/photos/snapshots on local disk
BACKUP_DEST=local                     # off-host backups (S3) are OFF unless you set BACKUP_S3_*
ENCRYPT_DOCS=true                     # encrypt stored documents at rest
```

Generate the secrets locally (no network needed):

```bash
# MASTER_KEY (32 random bytes, base64)
openssl rand -base64 32
# JWT_SECRET
openssl rand -hex 48
```

---

## 4. Optional: BYO-AI on a self-hosted box

If the customer *wants* AI and accepts that those specific calls leave the network to their chosen provider:

- Set `AI_ENABLED=true`, `AI_PROVIDER=<gemini|anthropic|openai|azure|cloudflare>`, `AI_MODEL=...`, and the provider key (`AI_API_KEY`, or the Azure trio).
- The agreement and data-residency decision sit between the **customer and their AI provider** — ServiceCycle never proxies or resells. Identifiers are scrubbed before any call.
- The deterministic parser still runs locally; AI only augments thin/low-coverage reports and optional briefs. The product is fully usable with AI off.

For an on-prem model with **no internet at all**, point `AI_PROVIDER=cloudflare`-style/OpenAI-compatible config at an **internal inference endpoint** (e.g. a local OpenAI-compatible server) so even AI stays inside the network.

---

## 5. Bring-up (air-gapped)

Full mechanics live in `DEPLOY_RUNBOOK.md`. For a disconnected host, the only extra step is getting the images/base layers onto the box:

1. On a connected machine, build the images (`docker compose build`) and `docker save` them to a tarball; transfer the tarball + the repo to the air-gapped host; `docker load`.
2. Place `.env` (section 3) next to `docker-compose.yml`.
3. `docker compose up -d` — the `server-migrate` init container applies the baseline migration, then the API starts.
4. Complete the first-run setup wizard to create the first admin + account (`planType=licensed`).
5. Front the API + client with your own TLS proxy (nginx/Caddy). No external CDN or font/CDN dependency is required.

---

## 6. Verifying zero egress

- Run the stack with no outbound network route (or a deny-all egress firewall) and confirm: login, asset CRUD, document upload, **deterministic report ingest**, nameplate OCR, compliance snapshot generation, EMP PDF, and SIEM audit export all succeed.
- The only operations that should fail under deny-all are the explicitly external ones you left enabled (AI with `AI_ENABLED=true`, real SMTP, S3 backups, the news/weather scanners).

*Contact your ServiceCycle representative for a deployment-specific architecture diagram and the current pen-test attestation.*
