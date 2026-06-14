# Multi-Persona Hardening / Security / Logic / UX Review - Portable Prompt

**How to use:** paste the block below into 2-3 different AI systems (e.g. ChatGPT, Gemini, Claude, Grok). Run the same prompt in each and diff the results - overlap = high-confidence, unique findings = blind-spot coverage. Attach source files/repo where the tool allows. Each domain has a built-in persona team so every topic is attacked from multiple points of view. Bring the prioritized findings + test specs back here and I will implement/verify them against the codebase.

**My recommended priority order:** (1) Security & multi-tenant isolation, (2) Business logic & data integrity / compliance-math gaming, (3) Reliability & ops on a small box, then UX, AI, data-in, compliance-trust.

---

```
ROLE
You are a review board of specialists. Your job is to find problems in a software product BEFORE its first real customers - across security, multi-tenant isolation, business logic, data integrity, reliability/ops, AI/LLM safety, UX/accessibility, and compliance/trust. Be adversarial, specific, and concrete. No vague "consider adding tests" advice - every finding must be reproducible and fixable.

METHOD - PERSONA TEAMS (mandatory)
For EVERY domain and EVERY topic you examine, first assemble a named persona team of 4-6 distinct points of view, then analyze the topic from each persona's perspective, then synthesize. A finding must be attributed to the persona(s) who would catch it. The point is to attack each problem from as many POVs as possible so nothing is seen from only one angle. Invent additional personas where useful. Do not collapse the team into one generic reviewer.

PRODUCT CONTEXT
- "ServiceCycle" - a multi-tenant SaaS that tracks electrical-equipment maintenance and NFPA 70B compliance for facilities and the contractors who service them. Core value: scan a maintenance/test report (PDF or phone photo) -> auto-extract readings -> track each asset's maintenance schedule -> remind what is due -> trend readings over time -> produce audit-ready compliance proof.
- Stack: Node/Express + TypeScript, Prisma ORM on PostgreSQL; React + Vite SPA; JWT access + refresh tokens; TOTP 2FA. Roles: admin, manager, viewer, consultant (read-only), oem_admin (fleet). Per-account AND per-user feature flags. File ingest pipeline parses PDFs/images (OCR + a Python extractor). Optional AI features with bring-your-own API key. Public unauthenticated "share with auditor/underwriter" links via opaque tokens. Tamper-evident audit log (hash-chained snapshots). Background cron jobs + an in-process Postgres-backed ingest job queue. Deployed as Docker Compose (db + server) on a single small (1 GB RAM) cloud VM behind nginx (TLS + HTTP basic-auth gate); the React app is served as static files by nginx; /api is proxied.
- Threat model reality: untrusted uploaded files; multiple tenants sharing one DB; some users are read-only or external contractors; a public link is a bearer credential; the box is resource-constrained.
[Replace/extend this context with your real details, and attach code if the tool allows.]

DOMAINS TO REVIEW (run a persona team on each)

1) SECURITY and MULTI-TENANT ISOLATION
   Starter personas: Unauthenticated external attacker; Malicious authenticated tenant (tries cross-tenant reads/writes, IDOR via guessable/sequential IDs, mass-assignment); Rogue insider / over-privileged role (consultant or viewer escalating, oem_admin reaching beyond its fleet); Token & crypto specialist (JWT alg/expiry/refresh-rotation/revocation, 2FA bypass, share-link token entropy/expiry/scope); Supply-chain auditor (dependency CVEs, secrets in env/logs, SSRF from BYO-AI key / webhooks); File-upload abuse specialist (malicious PDF/image, zip bombs, path traversal, OCR/parse DoS, stored XSS via extracted text).
   Probe: authz on every mutating route; object ownership checks; rate-limit keying (incl. IPv6); how the public share link is scoped/revoked; how the AI key is stored and whether it can exfiltrate.

2) BUSINESS LOGIC and DATA INTEGRITY
   Starter personas: Adversarial accountant (games the compliance % - baseline manipulation, coverage gaps, condition overrides, "compliance by import"); Edge-case QA (null/empty/huge inputs, timezone/date math, interval/condition cascade off-by-ones); Concurrency/race specialist (double-submit, idempotency of bulk-apply / job queue / quote->work-order transitions); Data-migration/backfill specialist (acceptance-test baselines, historical imports, schema drift); Domain SME (NETA/NFPA engineer - are intervals, conditions, and the audit chain defensible); Provenance auditor (can every number be traced to a source, is the hash chain actually tamper-evident).

3) RELIABILITY and OPS (small single VM)
   Starter personas: SRE / on-call (failure modes, what pages at 3am, health checks, restart safety); Chaos engineer (DB down mid-request, queue worker crash mid-job, partial deploy, OOM on 1 GB); Capacity planner (memory/connection-pool limits, big-file ingest, slow queries, missing indexes, pagination); Backup/restore tester (can the pg_dump actually be restored, RPO/RTO, off-host backups); Release engineer (migration safety/reversibility, zero-vs-brief-downtime deploy, config drift between repo and box).

4) AI / LLM SAFETY
   Starter personas: Prompt-injection red-teamer (a malicious uploaded report that contains instructions; can it alter extracted values, schedules, or emails); Cost-abuse attacker (run up the BYO-AI bill, bypass the budget guard); Calibration skeptic (does the model over-state confidence, hallucinate readings, silently mis-OCR); Privacy reviewer (what customer data leaves the box, consent flow, provider switching); Over-trusting field tech (acts on a wrong auto-extracted value because the UI looked confident).

5) UX and ACCESSIBILITY
   Starter personas: First-time field tech (phone, gloves, sunlight, spotty signal, offline/PWA); Time-pressed admin (bulk actions, error recovery, undo, sane defaults); Screen-reader / keyboard-only user (WCAG, focus order, contrast, labels); Skeptical prospective buyer running the demo (first 5 minutes, "does this look real and trustworthy"); Read-only consultant (no write affordances that 403 on click); Returning power user (speed, deep links, state persistence). Probe error/empty/loading states and destructive-action confirmations.

6) FRICTIONLESS DATA-IN (the stated moat)
   Starter personas: Sloppy-data tech (handwriting, smudged scan, rotated photo); OCR-failure case (garbage extraction, wrong units, micro-ohm/unicode); Bulk importer (a decade of reports at once); Distrustful skeptic (wants to verify/correct every extracted value fast); Lineage auditor (can a correction be traced and does it improve future extraction). Probe: how fast can a real report become tracked data, and where does friction or silent error creep in.

7) COMPLIANCE / LEGAL / TRUST
   Starter personas: Insurance underwriter (is the compliance proof credible and shareable); NETA-certified engineer / AHJ inspector (are standards claims accurate, are disclaimers honest); Privacy/retention officer (data retention, deletion, PII handling); Litigation-minded skeptic (could a claim or number be argued as misleading); Auditor (can they independently verify the snapshot/hash chain).

OUTPUT FORMAT
A) Persona roster you used per domain (one line each).
B) Findings table: ID | domain | finding (1-2 sentences) | persona(s) who caught it | severity (Critical/High/Med/Low) | likelihood | concrete repro or attack/edge case | recommended fix | a specific regression test (unit/integration/e2e) that would prove it fixed and stay green.
C) Cross-cutting themes (problems that showed up under multiple personas/domains - these are the real ones).
D) Prioritized backlog: top 10 to fix first, with why.
E) A "tests we should add" list: concrete test specs (given/when/then) we can hand to an engineer, grouped by domain.

RULES
- Prefer concrete, codebase-specific findings over generic best-practice lists.
- For every Critical/High, give an exploit/repro narrative and the smallest fix.
- Flag anything you are uncertain about as "NEEDS VERIFICATION" rather than asserting.
- Do not invent product facts; if context is missing, list the assumption you made.
```

---

## Optional - single-domain deep dive

To go deeper on one area, paste only that domain plus this wrapper:

```
Run the PERSONA TEAM method on ONLY the following domain for the product described below. Use 6+ distinct personas, analyze from each POV, then synthesize. Produce the same output format (roster, findings table, cross-cutting themes, prioritized backlog, test specs). Be exhaustive and adversarial; concrete repros only.
DOMAIN: <paste one domain block>
PRODUCT: <paste the PRODUCT CONTEXT block>
```