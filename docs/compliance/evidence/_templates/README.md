# Evidence Templates

Ready-to-copy templates for the dated evidence files that populate
`docs/compliance/evidence/YYYY-QN/` and `docs/compliance/evidence/YYYY-MM/`.

**How to use**: copy the appropriate template to the correct dated location,
fill in the frontmatter and body, commit.

## Available templates

| Template | Cadence | Use for | Copy to |
|---|---|---|---|
| `restore-test-template.md` | monthly (automated) | Monthly encrypted-backup restore verification | `docs/compliance/evidence/YYYY-MM/restore-test-YYYY-MM-DD.md` |
| `endpoint-security-template.md` | quarterly | BitLocker + screen-lock + AV verification with screenshots | `docs/compliance/evidence/YYYY-QN/endpoint-security-YYYY-MM-DD.md` |

## Also templated inline

- Access review — template is at the bottom of `docs/security/ACCESS_REVIEW.md`. Copy it to `docs/compliance/evidence/YYYY-QN/access-review-YYYY-MM-DD.md`.
- Log review (weekly + quarterly) — templates in `docs/security/LOG_REVIEW.md`.
- Quarterly security review — template in `docs/security/QUARTERLY_SECURITY_REVIEW.md`.
- Tabletop drill — see `docs/compliance/evidence/2026-07/tabletop-drill-2026-07-04.md` for the pattern.
- Incident record — template in `docs/compliance/incidents/README.md`.
- Privacy request evidence — described in `docs/security/PRIVACY_REQUESTS.md` §Evidence.
- Secure disposal (monthly) — template in `docs/security/SECURE_DISPOSAL_LOG.md`.

## Frontmatter contract

Every evidence file should carry:

```yaml
---
date: YYYY-MM-DD
reviewer: Dustin
scope: <what was reviewed>
outcome: pass | issues-found | out-of-cadence | n/a
next-review: YYYY-MM-DD
artifacts:
  - filename.ext
---
```

This makes evidence files greppable by date, reviewer, and outcome — auditor's
first move is usually `grep -l "outcome: pass" docs/compliance/evidence/`.
