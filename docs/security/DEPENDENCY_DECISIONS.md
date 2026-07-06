# Dependency Approval Process & Decision Log

**Version:** 1.0
**Effective date:** 2026-07-04
**Next review:** 2027-01-04
**Owner:** Dustin
**SOC 2 mapping:** CC7.1 (identifies and monitors vulnerabilities), CC8.1 (change management).

Where `docs/security/SECURITY_DECISIONS.md` records architectural decisions, this
doc records **dependency decisions** — every new package we add, every CVE we
knowingly accept, and every rotation we defer.

Related tooling: `npm audit --audit-level=high` in CI (`ci.yml`), Dependabot
(`.github/dependabot.yml`), Trivy (`.github/workflows/trivy.yml`), Gitleaks
(`.github/workflows/gitleaks.yml`), CodeQL (`.github/workflows/codeql.yml`).

---

## When this process fires

**Add-a-dependency approval** (before `npm install`):

Any new **direct** dependency added to `server/package.json` or `client/package.json`,
or a major-version upgrade of an existing direct dep. Transitive deps are governed
by the audit + scan tooling, not this process.

**Accept-a-CVE approval** (before adding to `.trivyignore` or a `npm audit`
allowlist):

Any HIGH or CRITICAL CVE that we choose not to patch immediately, for whatever
reason (no fix available yet, breaks compatibility, requires migration work).

## Add-a-dependency template

Copy this block into the log below when adding a package:

```markdown
### YYYY-MM-DD — Adding `<package-name>`

- **Package**: `<package-name>@<version>`
- **Purpose**: <one sentence: what problem does it solve here?>
- **Where used**: <file paths / feature scope>
- **Maintainer**: <person or org; company-backed or hobby?>
- **License**: <SPDX ID, e.g., MIT / Apache-2.0 / BSD-3>
- **Last published**: <date of latest release>
- **Weekly downloads**: <npm figure at time of adding>
- **Direct + transitive dep count**: <if the tree is huge, note it>
- **Known CVEs at time of adoption**: <none / list>
- **Alternatives considered**: <what else we looked at + why this won>
- **Bundle size impact (client only)**: <if adding to client>
- **Approver**: Dustin
- **Approved by**: 2026-YY-MM
```

## Accept-a-CVE template

```markdown
### YYYY-MM-DD — Accepting CVE-XXXX-YYYY in `<package>`

- **CVE**: [CVE-XXXX-YYYY](https://nvd.nist.gov/vuln/detail/CVE-XXXX-YYYY)
- **Severity**: HIGH / CRITICAL
- **Affected package**: `<package>@<version>` (direct / transitive via `<parent>`)
- **Vector**: <one sentence: how would this be exploited?>
- **Why accept**:
  - <reason 1: no fix available>
  - <reason 2: exploitation requires attacker-controlled input we do not accept>
  - <reason 3: fix requires breaking migration>
- **Compensating controls**: <what stops exploitation in our specific deployment>
- **Reconsider by**: <date — usually next quarterly review or when a fix ships>
- **Approver**: Dustin
- **Trivy ignore entry**: added to `.trivyignore` with comment linking here.
```

---

## Log

### 2026-07-04 — Establishing this process

- **Decision:** create `DEPENDENCY_DECISIONS.md` + `.trivyignore` + wire Trivy into CI.
- **Reason:** SOC 2 CC7.1 asks for a documented process for vulnerability triage that goes beyond "Dependabot opens a PR." Also gives us a place to point when an auditor asks "why do you still have package X at that version?"
- **Approver:** Dustin.

### 2026-07-04 — Accepting first-scan CVE batch (base image + Python deps)

First run of `.github/workflows/trivy.yml` surfaced 6 base-image CVEs (Debian bookworm packages) and 4 Python-package CVEs in the server extract pipeline.

**Base-image CVEs (libcap2, libgnutls30):**

- **CVEs**:
  - [CVE-2026-4878](https://nvd.nist.gov/vuln/detail/CVE-2026-4878) — libcap2 TOCTOU privilege escalation
  - [CVE-2026-33845](https://nvd.nist.gov/vuln/detail/CVE-2026-33845) — libgnutls30 DTLS zero-length DoS (CRITICAL)
  - [CVE-2026-33846](https://nvd.nist.gov/vuln/detail/CVE-2026-33846) — libgnutls30 heap-buffer-overflow DoS
  - [CVE-2026-42009](https://nvd.nist.gov/vuln/detail/CVE-2026-42009) — libgnutls30 DTLS reordering DoS
  - [CVE-2026-42010](https://nvd.nist.gov/vuln/detail/CVE-2026-42010) — libgnutls30 NUL-character auth bypass
  - [CVE-2026-3833](https://nvd.nist.gov/vuln/detail/CVE-2026-3833) — libgnutls30 policy bypass (case sensitivity)
- **Affected package**: OS-level via `node:20-slim` base image (Debian bookworm)
- **Vector**: TLS/DTLS surface; both libraries used only through Node's TLS bindings
- **Why accept**:
  - Fixed versions are available in newer Debian point releases but not yet in the cached `node:20-slim` we build against.
  - We do NOT terminate TLS at the Node application layer — nginx terminates TLS on the droplet, so libgnutls30 is not on the customer request path.
  - We do NOT run privileged container operations that would exercise libcap2 in a security-sensitive way.
- **Compensating controls**:
  - TLS terminated at nginx, not Node; TLS attack surface bounded to nginx's OpenSSL.
  - Container runs as non-root (`USER node` in Dockerfile).
  - `no-new-privileges` in `docker-compose.yml` security_opt.
  - Weekly Trivy re-scan; drops off automatically when base image rebuilds.
- **Reconsider by**: 2026-10-04 (Q3 quarterly security review) — verify whether newer `node:20-slim` snapshot has picked up the Debian fixes.
- **Approver**: Dustin.
- **Trivy ignore entries**: added to `.trivyignore` with cross-reference here.

**Python-package CVEs (pdfminer.six) — still accepted:**

- **CVEs**:
  - [CVE-2025-64512](https://nvd.nist.gov/vuln/detail/CVE-2025-64512) — pdfminer.six < 20251107
  - [CVE-2025-70559](https://nvd.nist.gov/vuln/detail/CVE-2025-70559) — pdfminer.six < 20251230
- **Affected packages**: `server/pyextract` PDF ingest chain
- **Vector**: Malicious PDF or image uploaded by an authenticated tenant user
- **Why accept**:
  - The PDF pipeline is authenticated + tenant-scoped; a malicious upload can only impact the uploader's own account (no cross-tenant blast radius).
  - Bumping requires re-running the ingest golden-set eval (see memory `servicecycle-ingestion-hardening-2026-07-03`); scheduled for Q3 2026 pipeline refresh session.
  - Base rate: <5 PDFs/day at current scale; DoS blast radius is 1 tenant.
- **Compensating controls**:
  - AI budget rate limiter (`server/middleware/aiIpLimit.ts`) caps abuse.
  - PDF ingest jobs are async — a hung parser doesn't block user-facing routes.
  - Uploaded PDFs are size-capped at ingest time.
- **Reconsider by**: 2026-08-31, coinciding with next scheduled PDF-pipeline eval refresh.
- **Approver**: Dustin.
- **Trivy ignore entries**: added to `.trivyignore` with cross-reference here.

**Pillow CVEs — RESOLVED 2026-07-05 (no longer accepted-risk, actually fixed):**

- **CVEs** (previously accepted, now fixed):
  - [CVE-2026-25990](https://nvd.nist.gov/vuln/detail/CVE-2026-25990) — pillow < 12.1.1 out-of-bounds write via crafted image
  - [CVE-2026-40192](https://nvd.nist.gov/vuln/detail/CVE-2026-40192) — pillow < 12.2.0 decompression-bomb DoS
  - [CVE-2026-42311](https://nvd.nist.gov/vuln/detail/CVE-2026-42311) — pillow < 12.2.0, same batch
- **What changed**: `server/pyextract/requirements.txt`'s Pillow pin was
  `>=10.4.0,<12.0` — that upper bound was itself blocking these three fixes
  from ever being picked up on a `pip install`/Docker rebuild, even though
  the original acceptance rationale assumed a future bump would close them.
  Bumped to `>=12.2.0,<13.0`.
- **Verification**: `python scripts/eval_extraction.py` against the
  synthetic golden-set corpus — clean 100%/46%, partial 95%/0%, garbled
  45%/0%, identical to the pre-bump baseline (zero regression). The one
  version-sensitive Pillow API call in this codebase
  (`Image.BICUBIC` in `scripts/eval_extraction.py`) ran successfully as
  part of that same eval, confirming it's still valid under 12.2.0.
- **Removed from `.trivyignore`** — the scan should pass on these three CVE
  IDs outright now; if it doesn't, treat that as a real regression to
  investigate, not something to silently re-accept.
- **Approver**: Dustin (bump executed autonomously per standing "safe,
  solo-executable fix" authorization; flagging here for visibility).

**Dockerfile misconfiguration accepted:**

- **Trivy rule**: `DS-0002` — Dockerfile must specify a non-root `USER`.
- **Affected file**: `client/Dockerfile.prod`.
- **Why accept**: standard nginx official-image behavior — master process needs root to bind port 80; worker processes drop privileges to the `nginx` user automatically. Container is deployed behind Cloudflare + host nginx, so in-container port 80 is not customer-facing.
- **Compensating controls**:
  - Container runs as non-root worker (nginx drops privileges post-bind).
  - `no-new-privileges` in `docker-compose.yml` security_opt.
  - Cloudflare fronts every request; direct-to-origin is basic-auth'd for demo.
- **Reconsider by**: 2026-08-31 — switch to `nginxinc/nginx-unprivileged:1.25-alpine` (binds to 8080, runs as UID 101 by default) and update `docker-compose.yml` port mapping. Deferred until post-demo to avoid churn.
- **Approver**: Dustin.
- **`.trivyignore` entry**: `DS-0002` with cross-reference here.

**Suppressed classes (no CVE, redundant tooling):**

- Trivy fs-scan secret detection disabled via `scanners: vuln,misconfig`. Rationale: Gitleaks (`.github/workflows/gitleaks.yml`) is the authoritative secret scanner. Trivy fs was flagging a `serviceAccountEmail` form placeholder in `client/src/components/settings/CloudConnectorsSection.jsx` as a "gcp-service-account" secret — a documented false positive.
- Trivy image-scan `skip-files: 'usr/local/lib/node_modules/npm/**'`. Rationale: npm's own bundled node_modules ship with the `node:20-slim` base image and are not exercised by our application code. CVE tracking there is the responsibility of the Node.js image maintainers.

---

## Review cadence

- **Weekly (implicit)** — Dependabot PRs are triaged. Auto-merge is enabled for patch + minor updates in `docs/DEPLOY_RUNBOOK.md` where the risk model allows it (currently: none, all merges are manual for now).
- **Quarterly** — walk this file's accepted-CVE list; check whether fixes have shipped; remove `.trivyignore` entries for anything now patchable.
- **On any new tabletop drill (annual)** — verify none of the accepted CVEs have been superseded by an incident-triggering CVE.

## Cross-references

- SLA table for remediation: `docs/SOC2_CONTROLS.md` CC4.2.
- Where Dependabot is configured: `.github/dependabot.yml`.
- Where npm audit runs: `.github/workflows/ci.yml`.
- Where Trivy runs: `.github/workflows/trivy.yml`.
- Where accepted CVEs are actually ignored by tooling: `.trivyignore`.
