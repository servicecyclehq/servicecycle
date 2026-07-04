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

*(No accepted CVEs or new adds recorded yet — future entries append below.)*

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
