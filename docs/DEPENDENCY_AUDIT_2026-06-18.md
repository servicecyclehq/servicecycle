# Dependency Audit — 2026-06-18

`npm audit` on `server/` and `client/`. Non-breaking fixes (`npm audit fix`,
semver-compatible, lockfile-only) were applied and the suites/builds re-verified
green. Breaking bumps (`npm audit fix --force`) were NOT applied — they are
reported below for a scheduled, code-aware upgrade.

## Applied this session (non-breaking, lockfile only)

**Server** — prod-relevant advisories cleared (4 → 1):
- `form-data` CRLF injection (GHSA-hmw2-7cc7-3qxx) — patched to ≥4.0.6 in the
  lockfile (node_modules already had it; `npm ci` in the Docker build now matches).
- `multer` DoS advisories — already satisfied by the installed `multer@2.2.0`
  (advisory range 1.0.0–2.1.1); the lockfile was realigned by `npm audit fix`.

**Client** — prod-relevant advisories cleared (4 → 2):
- `form-data` CRLF injection (high) — patched.
- `@babel/core` arbitrary file read via sourceMappingURL (build-time) — patched.

Verification after the fixes: `tsc` clean, integration suite **258/258**, client
`vite build` clean.

## Reported — needs a breaking upgrade (NOT applied)

### Server: `js-yaml` 3.14.2 — moderate — exposure negligible
Quadratic-complexity DoS on hostile YAML merge keys (GHSA-h67p-54hq-rp68). Fix is
`js-yaml@4.x`, a major bump (API change: `safeLoad` removed, `load` safe by
default). **Real exposure is effectively nil:** the only runtime use is
`lib/openapiRegistry.ts` parsing our **own bundled** OpenAPI spec files — never
untrusted input — and that call site already falls back to the 4.x-safe `load()`
(`yaml.safeLoad ? yaml.safeLoad(...) : yaml.load(...)`), so the upgrade is
forward-compatible there. Recommend bumping `js-yaml` to 4.x when convenient;
not urgent.

### Server dev-toolchain: 18 moderate (jest / babel chain) — not shipped
`babel-jest` → `@jest/transform` → `babel-plugin-istanbul` → `js-yaml`, etc. These
are **devDependencies only** and are stripped from the production image by
`npm prune --omit=dev` in the Dockerfile, so they are not in the deployed
artifact. Clearing them needs major jest/babel bumps; defer to a tooling-upgrade
pass.

### Client: `esbuild` ≤0.24.2 / `vite` ≤6.4.2 — moderate/high — dev-server only
`esbuild` dev-server request vuln (GHSA-67mh-4wv8-2f99). Fix is `vite@8`, a major
bump from the current v6. **Not exploitable in production:** the deployed client
serves a static `vite build` (preview), not the dev server the advisory concerns.
Schedule a focused `vite 6 → 8` upgrade (verify the build + PWA plugin) rather
than forcing it unattended — a major Vite bump can move Rollup/PWA behavior.

## Test coverage added this session
- `__tests__/routes/inboundEmail.test.ts` (NEW, 7 tests): #6 email-in webhook —
  shared-secret auth accept/reject, to-address→account routing, attachment→
  auto-commit `IngestJob` fan-out, and the auto-acknowledgement path including
  the no-reply / mail-loop suppression. Also fixed the shared email mock
  (`__tests__/helpers/setup.ts`) to export `reportReceivedHtml`, which
  `inboundEmail.ts` imports (the prior omission would have thrown in any test
  that hit the ack path).
