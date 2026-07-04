# Signed Commits Policy

**Version:** 1.0
**Effective date:** 2026-07-04
**Owner:** Dustin
**SOC 2 mapping:** CC1.4 (accountability), CC8.1 (change management).

---

## Requirement

Every commit landing on `main` must be signed with a key associated with a
GitHub-verified identity. This makes the audit trail cryptographically
attributable to a specific developer, not just to whoever holds a git config.

## Enforcement

Two layers:

1. **Repo branch protection** — GitHub UI → Settings → Branches → rule for `main`:
   - Require signed commits ✅
   - Require status checks to pass: `verify-signed-commits` ✅
2. **CI workflow** — `.github/workflows/verify-signed-commits.yml` verifies
   every commit's `verification.verified` via the GitHub API and fails the
   build if any commit is unsigned.

For SC's solo-founder stage, the CI signal is the primary enforcement; branch
protection is the belt-and-suspenders (turn on when a second developer joins).

## Setup — SSH commit signing (recommended, simplest)

Runs off the same SSH key already used for git push. No GPG keyring to manage.

```bash
# Tell git to sign with SSH.
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub

# Sign every commit and tag by default.
git config --global commit.gpgsign true
git config --global tag.gpgsign true
```

Then in GitHub → Settings → SSH and GPG keys:

1. Click "New SSH key".
2. Set **Key type** to `Signing key` (this is a separate slot from the auth key,
   even if it's the same underlying key value).
3. Paste the public key.

Verify locally:

```bash
git commit --allow-empty -m "test signed commit"
git log --show-signature -1
# Should print: "Good "ssh" signature for <you>"
```

Push and verify on GitHub: the commit view should show a green "Verified" badge.

## Setup — GPG (traditional, more portable)

Use this if you already have GPG configured, or if you'll be signing releases
across multiple machines and want a portable key.

```bash
# Generate a key (choose RSA 4096 or ed25519).
gpg --full-generate-key

# List keys and grab the key ID (looks like ABC123DEF456).
gpg --list-secret-keys --keyid-format=long

# Configure git.
git config --global user.signingkey <KEY-ID>
git config --global commit.gpgsign true
git config --global tag.gpgsign true

# Export the public key and paste into GitHub → Settings → SSH and GPG keys.
gpg --armor --export <KEY-ID>
```

## Handling exceptions

If a commit legitimately cannot be signed (e.g., merged via GitHub web UI —
those commits ARE signed by GitHub automatically, so this is not usually a
problem), record the exception in `docs/security/SECURITY_DECISIONS.md`.

## Failure mode

If `verify-signed-commits` fails:

1. Confirm you have `commit.gpgsign true` in local git config.
2. Confirm the signing key is registered in GitHub → SSH and GPG keys.
3. Amend the offending commit: `git commit --amend --no-edit -S` then
   force-push (only safe on feature branches, never rewrite `main`).

## Related

- Branch protection docs: <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches>
- SSH commit signing: <https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification>
