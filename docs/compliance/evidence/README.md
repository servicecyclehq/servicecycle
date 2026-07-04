# Compliance Evidence — Folder Convention

**Purpose:** central archive of dated evidence artifacts that a SOC 2 auditor (or acquirer's diligence team) would ask to see.

## Structure

```
docs/compliance/evidence/
  YYYY-MM/
    access-review-YYYY-MM-DD.md
    log-review-YYYY-MM-DD.md
    restore-test-YYYY-MM-DD.md
    tabletop-drill-YYYY-MM-DD.md
    vendor-review-YYYY-MM-DD.md
    security-metrics-YYYY-MM.md
    quarterly-security-review-YYYY-QN.md
    endpoint-security-YYYY-MM-DD.md   # includes BitLocker + screen-lock screenshots
    dependency-scan-YYYY-MM-DD.json   # attached scan artifacts
```

## Rules

1. **File name always leads with date** so `ls` / `git log` produces a chronological view.
2. **Every evidence file has a frontmatter block** with: `date`, `reviewer`, `scope`, `outcome`, `next-review`.
3. **Attach the raw artifact if it exists** (JSON scan output, screenshot, exported CSV) alongside the summary markdown.
4. **Never delete evidence** — supersede with a new dated file if the fact changes.
5. **One monthly rollup** (`security-metrics-YYYY-MM.md`) summarizes counts across all evidence in that month.

## Frontmatter template

```markdown
---
date: 2026-07-04
reviewer: Dustin
scope: <what was reviewed>
outcome: <pass / issues-found / n/a>
next-review: 2026-10-04
artifacts:
  - filename.png
  - scan.json
---

## Summary

<what was checked, what was found, what was decided>

## Actions

- <followup 1, or "none">
```

## What lives here vs. in `docs/`

- **`docs/`** — the policies and design docs (the *what we say we do*).
- **`docs/compliance/evidence/`** — dated proof we did it (the *proof we did it*).

An auditor's question is almost always "show me evidence that X happened on Y date." That question should be answerable by one `ls` command in this folder.
