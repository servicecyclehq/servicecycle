# GitHub Admin Setup — one-time SOC 2 config

**Purpose:** the SOC 2 workflows are live but a few org-owner GitHub settings still need to be flipped by an account with admin on `servicecyclehq/servicecycle`. This runbook is the operator's paste list.

**Owner:** Dustin (only account with admin on `servicecyclehq/servicecycle`).
**When to run:** one-time, at your convenience. None of these are demo-blocking.
**Companion:**
- `docs/security/BETTER_STACK_ACTIVATION.md`
- `docs/security/SIGNED_COMMITS.md`
- `docs/SOC2_READINESS_CHECKLIST.md` (items B5, B7, B11, C7)

---

## 1. Branch protection on `main` — closes B5

**Via UI** (Settings → Branches → Add rule):
- Branch name pattern: `main`
- ✅ Require status checks to pass before merging
  - Required checks: `Scan for secrets`, `Analyze (javascript-typescript)`, `Filesystem scan (package manifests)`
  - Do NOT require: `Check signature on all new commits` (warn-only until GPG configured), `Container image scan` (only runs on main + weekly)
- ✅ Require linear history
- ✅ Do not allow force pushes
- ✅ Do not allow deletions
- ❌ Do not require PR reviews (solo-dev; would block self-merges)
- ❌ Do not enforce for admins (leave emergency-fix path open at solo stage; flip to enforced when a second dev joins)

**Via gh CLI** (run as an admin):
```bash
gh api --method PUT repos/servicecyclehq/servicecycle/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": false,
    "contexts": [
      "Scan for secrets",
      "Analyze (javascript-typescript)",
      "Filesystem scan (package manifests)"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
EOF
```

## 2. Enforce signed commits — closes B7

Prereq: `docs/security/SIGNED_COMMITS.md` §Setup done locally first (SSH commit signing is the simplest path).

**Via UI:** Settings → Variables → Actions → New repository variable:
- Name: `REQUIRE_SIGNED_COMMITS`
- Value: `true`

**Via gh CLI:**
```bash
gh variable set REQUIRE_SIGNED_COMMITS --body true --repo servicecyclehq/servicecycle
```

Once set, `.github/workflows/verify-signed-commits.yml` switches from warn-only to fail-on-unsigned. Also add `Check signature on all new commits` to the required-status-checks list from step 1.

## 3. DAST target for OWASP ZAP — closes C7

`dast-zap.yml` skips itself unless `DAST_TARGET_URL` is set.

**Via UI:** Settings → Variables → Actions → New repository variable:
- Name: `DAST_TARGET_URL`
- Value: your demo endpoint (e.g. `https://servicecycle.app` for baseline against prod, or a dedicated staging URL). Avoid pointing at live customer routes until the baseline is triaged.

If the target is basic-auth'd, also add a secret `DAST_AUTH_HEADER` with value `Authorization: Basic <base64>`. See `dast-zap.yml` header for context.

**Via gh CLI:**
```bash
gh variable set DAST_TARGET_URL --body "https://servicecycle.app" --repo servicecyclehq/servicecycle
```

## 4. Environment approval gate for deploys — closes B11

`deploy.yml` currently triggers on push to main with no approval gate.

**Via UI:** Settings → Environments → New environment:
- Name: `production`
- ✅ Required reviewers: add yourself
- ✅ Wait timer: 0 minutes (or a small number if you want a "cool off")
- Update `.github/workflows/deploy.yml` to add `environment: production` to the deploy job.

The self-approval loop feels silly at solo stage but produces the audit artifact SOC 2 CC8.1 asks for. Skip if you'd rather leave B11 yellow.

## 5. Fix the pre-existing `Deploy to ServiceCycle droplet` workflow

Not SOC 2 scope but has been failing since 2026-07-03. Needs the following repo secrets:

- `SC_SSH_KEY` — the private SSH key content that grants access to the droplet
- `SC_SSH_HOST` — droplet IP or DNS name (`198.211.99.45`)
- `SC_SSH_USER` — usually `root`

**Via gh CLI:**
```bash
gh secret set SC_SSH_KEY --repo servicecyclehq/servicecycle < ~/.ssh/id_ed25519
gh secret set SC_SSH_HOST --body "198.211.99.45" --repo servicecyclehq/servicecycle
gh secret set SC_SSH_USER --body "root" --repo servicecyclehq/servicecycle
```

## Verification

After each of the above, push a trivial commit to `main` and confirm the workflow behavior matches the intended gate. Nothing here is destructive.

## After running

Update the checklist:
- B5 🟡 → 🟢 (after step 1)
- B7 🟡 → 🟢 (after step 2 + local GPG setup)
- C7 🟡 → 🟢 (after step 3)
- B11 🟡 → 🟢 (after step 4)
