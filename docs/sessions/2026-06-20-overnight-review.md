# Overnight review + hardening — 2026-06-20

Ran while you slept, with the "review + safe fixes + deploy" mandate. Everything
below kept green (tsc + 314-test suite + client build) and deployed via the MCP
loop. **No high-severity issues anywhere.**

## Scans — all clean
- **Dependency audit:** `npm audit --omit=dev` → **0 vulnerabilities** on BOTH
  server and client.
- **Live droplet:** healthy. Load avg ~0; server container booted clean, all
  crons scheduled, ingest worker polling, **zero errors/stack traces** in the
  container logs. Health endpoint OK.
- **Code review** (subagent, focused on IDOR / role-gating / null-safety / crash
  risk across all 8 features shipped this session): **tenant isolation is solid**
  — every query is accountId-scoped; the oem_admin cross-account proposal path
  correctly enforces same-partnerOrg and blocks non-oem callers. **Cost redaction
  is solid** — proposals hide all $ from non-oem callers and the priced PDF is
  contractor-only. Percentage/percentile math is divide-by-zero guarded; empty
  accounts return well-formed payloads; client cards all null-guard.

## Fixed + deployed (commit e2b0def)
1. **Maintenance Debt Ledger — per-site repair-asset count** (was the only real
   functional bug). Per-site `repairBacklog.assets` was hardcoded `0`; now reports
   the true count. Account-level total was already correct. Added a regression test.
2. **Proposal rep-email escaping.** `request-contact` now HTML-escapes the user
   name + company name in the email to the rep (the note was already escaped) —
   closes a minor self-XSS-into-email gap.
3. **proposals.ts character cleanup.** An earlier PowerShell re-encode had
   corrupted the file's non-ASCII (em-dashes, section dividers, and the curly
   quotes in the user-facing 403 message). Restored to clean ASCII; confirmed
   no BOM.

## Flagged for you — low priority, left untouched (judgment/convention calls)
- **changeBrief "assets removed" uses `archivedAt`.** If you ever retire assets
  via `inService = false` instead of `archivedAt`, those won't show as "removed"
  in the brief. Confirm your retirement convention; trivial to broaden if needed.
- **Non-Error logging nit.** A few new compliance route catch-blocks log
  `err.message`; if a builder ever rejected with a non-Error it'd double-throw
  inside the catch (Express still returns 500). Latent — all builders throw real
  Errors today. Skipped to avoid churn; easy `err?.message || err` if you want it.
- **Evidence/drift treat a null `nextDueDate` as "not overdue."** Defensible (an
  unbaselined schedule has no due date) — consistency note, not a bug.
- **Infra (pre-existing, your call):** droplet disk at **75%** (5.9 GB free) —
  worth a cleanup pass before it tightens; `BACKUP_DEST=local` and
  `HEALTHCHECKS_PING_KEY` unset are still the documented demo-box warnings.
- **Fleet "no partnerOrgId → all active accounts" demo fallback** on
  /dashboard + /portfolio-rank is oem_admin-only (contractor↔contractor), same
  as the existing fleet routes — flagging for awareness, not a new exposure.

Net: the night's 8 features are clean, audited, and hardened; the one functional
bug is fixed and live. Nothing is broken.
