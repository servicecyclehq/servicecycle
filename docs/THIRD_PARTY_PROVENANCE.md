# Third-Party Code Provenance & Attribution

**Purpose.** ServiceCycle's exit plan is an asset/IP sale with a clean carve-out. An acquirer's counsel will
run license diligence. This document records every place third-party code or a third-party component
influenced this repo, the verified upstream + license, and the obligation each carries — so there are no
surprises in diligence.

**Why this exists separately from the SBOM.** `.github/workflows/license-check.yml` and the SBOMs
(`server/sbom/cyclonedx.json`, `spdx.json`) only track **declared dependencies from package manifests**. They
do **not** detect source code copied and pasted into our own files. Closing that specific gap is the point of
this audit. A green license-check is not evidence about anything below.

**Method (2026-07-19 audit).** (1) Git archaeology on the full history (repo starts 2026-06-06): earliest
commits, files added fully-formed in a single commit, `git log -S`. (2) Repo-wide marker sweep for `@author`,
`SPDX-License-Identifier`, `Copyright`, "Licensed under", "copied/ported/adapted from", and upstream names/URLs.
(3) Style-discontinuity analysis of the auth/SSO/crypto layer. (4) Upstream **license verification against
primary sources** (the actual upstream LICENSE files), not from memory.

---

## Headline finding

**No third-party source code is vendored (copy-pasted) into ServiceCycle's own source.** The repo-wide sweep
found **zero** `SPDX-License-Identifier`, `@author`, `@license`, "Licensed under", or "copied/ported/adapted
from `<external>`" markers in `server/`, `client/`, or `sdk/` source; **no** `vendor/`, `third_party/`, or
`vendored/` directories; and the only third-party copyright banners in the tree are standard bundler-retained
notices inside **minified build artifacts** (`client/dist-verify/assets/*.js` — React / TanStack Query /
React Router), which are npm dependencies, not vendored source.

**The "SSO starter repo" you remember is Ory Polis (formerly BoxyHQ "SAML Jackson").** The SSO feature is an
**integration against that project, run as a self-hosted container** (`boxyhq/jackson:26.2.0`) — ServiceCycle
talks to it over HTTP. Our SSO code (`server/lib/ssoPolis.ts`, `scim.ts`, `server/routes/sso*.ts`) is
original integration code written in the repo's own house style; what was "borrowed" is the **wire-protocol
shapes and behavior**, which the code comments state were *verified against the upstream source*
(`server/routes/sso.ts` explicitly cites reading `boxyhq/jackson … npm/src/controller/oauth.ts`). That is
knowledge-derivation from an Apache-2.0 project, not a code lift — but it is exactly what should be attributed.

**No copyleft exposure found.** No GPL / AGPL / SSPL / BUSL anywhere. Every third-party component below is
Apache-2.0 or MIT (permissive). Apache-2.0 carries an attribution/NOTICE obligation, addressed by the new
root `NOTICE` file and the per-file provenance headers.

---

## Findings

| # | Component / where it lives | Upstream + URL | License (verified) | Confidence | Retained vs. rewritten | Obligation |
|---|---|---|---|---|---|---|
| 1 | **Ory Polis / BoxyHQ SAML Jackson** — run as container `boxyhq/jackson:26.2.0` (`docker-compose.polis.yml`); integrated by `server/lib/ssoPolis.ts`, `scim.ts`, `server/routes/sso.ts`, `ssoScim.ts`, `ssoAdmin.ts` | github.com/ory/polis (redirect of github.com/boxyhq/jackson) | **Apache-2.0**, © Ory Corp | CONFIRMED* | No source vendored. Wire shapes + protocol behavior derived/verified against upstream; integration code is original | Retain Apache-2.0 attribution (NOTICE + headers). No source redistribution occurs (image is pulled, not rebundled). OEL enterprise add-ons are **not** used |
| 2 | **jose** (panva) — `server/lib/ssoIdToken.ts` (JWKS + id_token validation), used across the SSO callback | github.com/panva/jose | **MIT**, © 2018 Filip Skokan | CONFIRMED | Declared npm dep (`jose ^5.10.0`); standard library usage, no source copied | Retain MIT copyright notice (NOTICE) |
| 3 | **SheetJS Community Edition** via `@e965/xlsx` — `server/lib/xlsParse.ts` (legacy .xls reader) | npm `@e965/xlsx` (mirror of SheetJS CE); github.com/e965/sheetjs-npm-publisher | **Apache-2.0**, © SheetJS LLC | CONFIRMED | Declared npm dep (`@e965/xlsx` 0.20.3); wrapper module, no source copied | Retain Apache-2.0 attribution (NOTICE). CVE rationale already documented in the file |
| 4 | **AES-256-GCM envelope / TOTP / JWT-rotation idioms** — `server/lib/crypto.ts`, `totp.ts`, `backupCrypto.ts`, `jwtSecrets.ts` (born in the initial commit `33a812d`, 2026-06-06) | none identified | n/a | UNRESOLVED | Textbook `node:crypto` / `otplib` / `jsonwebtoken` patterns; no markers, no specific upstream evident | None identified. Flagged for your memory — see Open Items |

\* **CONFIRMED, with one verification caveat:** the upstream LICENSE was read directly and is Apache-2.0
(© Ory Corp) on `github.com/ory/polis` `main`; the project README confirms the model is an Apache-2.0
open-source core plus a separate **Ory Enterprise License (OEL)** covering enterprise-only add-ons that the
OSS `boxyhq/jackson` image does not include. The LICENSE blob at the exact `26.2.0` tag could not be fetched
directly because the org rename (boxyhq → ory) breaks old tag-pinned raw URLs; the license is Apache-2.0 with
high confidence given the `main` LICENSE, the README dual-model, the running image being the OSS distribution,
and the existing internal `docs/security/POLIS_ATTRIBUTION.md`. If counsel wants the exact-tag artifact,
`git show 26.2.0:LICENSE` inside a clone of the upstream (or the Docker image's bundled license) will produce it.

### Notes per finding

1. **Ory Polis.** `docker-compose.polis.yml` runs `image: boxyhq/jackson:26.2.0` as a separate container
   (`servicecycle-polis`) and its comments already flag "OSS Apache-2.0 (NOT the Ory Enterprise License)."
   `server/lib/ssoPolis.ts` and `scim.ts` headers already note "LIVE/SOURCE-verified against
   ory/polis@v26.2.0." `server/routes/sso.ts:178–186` cites reading the upstream `oauth.ts` to verify
   tenant-resolution behavior — this documents *how the integration was validated*, and the surrounding code
   is ServiceCycle's own tenant-isolation check, not a copy of upstream code. An existing
   `docs/security/POLIS_ATTRIBUTION.md` already declared Apache-2.0; this audit adds the root `NOTICE` and the
   per-file provenance headers that were missing.
2. **jose.** Already credited in `ssoIdToken.ts` ("Uses `jose` (panva, MIT)"). Added to `NOTICE`.
3. **SheetJS / @e965/xlsx.** `xlsParse.ts` already carries a thorough security/CVE rationale and names
   SheetJS; the license (Apache-2.0) is now stated explicitly in the header and `NOTICE`.
4. **Crypto/2FA idioms.** These landed in the initial commit as part of the app skeleton. The build history
   shows nearly every file lands fully-formed in one feature commit (an AI-assisted build pattern), so
   "born whole" is not by itself a copy signal here. No upstream markers were found. They read as generic
   textbook implementations. Left as UNRESOLVED rather than guessing an upstream — see Open Items.

### What was checked and found clean
- No `SPDX-License-Identifier` / `@author` / `@license` / "Licensed under" / "copied/ported/adapted from
  `<external>`" in first-party source (the only "copied from" hits are internal file cross-references).
- No `vendor/` `third_party/` `vendored/` directories; no pre-existing `NOTICE` / `THIRD_PARTY*` files.
- Third-party copyright banners appear only in minified `client/dist-verify/assets/*.js` build artifacts
  (React / TanStack / React Router) — expected bundler behavior for npm deps, not vendored source.
- SSO dependencies are hand-rolled HTTP/JWT clients using `jose`; **no** SAML/OIDC library
  (`@boxyhq/saml-jackson`, `openid-client`, `@node-saml/*`, `passport-saml`, `samlify`) is imported.

---

## Obligations status

- **Apache-2.0 (Ory Polis, SheetJS/@e965/xlsx):** attribution + license reference now carried in the root
  `NOTICE` and in per-file provenance headers. Upstream Ory Polis ships **no** `NOTICE` file at `main`
  (verified 404), so there is no upstream NOTICE content to reproduce under Apache-2.0 §4(d). No source is
  redistributed, so §4(a)–(c) redistribution obligations are not triggered; the attribution is best-practice
  for a clean carve-out.
- **MIT (jose):** copyright + permission notice retained in `NOTICE`.
- **Copyleft (GPL/AGPL/SSPL/BUSL):** none present.

---

## Open items — need Dustin to decide or confirm

1. **Crypto/2FA idioms (finding #4).** Do you recall pulling `crypto.ts` / `totp.ts` / `backupCrypto.ts` /
   `jwtSecrets.ts` (or their pattern) from a specific tutorial, gist, or repo? No marker or upstream was
   found; they look like generic textbook code. If a specific source exists, name it and it gets attributed;
   otherwise this stays "in-house / generic, no upstream identified."
2. **Initial-commit starter skeleton.** The app skeleton landed fully-formed in commit `33a812d`
   (2026-06-06). Brand commits reference deliberately distinguishing from **LapseIQ**, suggesting the skeleton
   shares lineage with your *own* LapseIQ codebase (first-party), not a third party. Confirm the starter was
   your own code (or an internal boilerplate), not an external template — if it was an external template,
   that template's license needs the same treatment.
3. **Exact-tag Polis license artifact.** Apache-2.0 is confirmed on `main` + README; if counsel wants the
   license file pinned to `26.2.0` specifically, pull it from a clone of the upstream at that tag or from the
   Docker image's bundled license (see the caveat above).
4. **Scope of attribution headers.** Headers were added to the files that integrate with / derive behavior
   from Ory Polis plus the jose and SheetJS wrappers. `ssoPkce.ts` (RFC 7636), `ssoRoleMap.ts`, and
   `ssoConfig.ts` were treated as original / standards-based and left unheadered — confirm that's the line
   you want.

_Audit performed 2026-07-19. Upstream licenses verified by reading the actual upstream LICENSE files
(ory/polis, panva/jose) and the npm registry metadata (@e965/xlsx). Repo evidence: git history + a
repo-wide marker sweep on the device working copy._
