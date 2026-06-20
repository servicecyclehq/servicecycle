# Third-party attribution — Ory Polis (SSO broker)

ServiceCycle's enterprise SSO + SCIM (branch `feature/sso-polis`) is brokered by
**Ory Polis** (formerly BoxyHQ "SAML Jackson"), run as a **separate container**
(`boxyhq/jackson:26.2.0`). We use ONLY the public open-source distribution.

- **Project:** Ory Polis — https://github.com/ory/polis
- **Version pinned:** 26.2.0 (verified 2026-06-20 from the repo `LICENSE` and
  `package.json` `version`/`license` fields).
- **License:** **Apache License 2.0** — https://www.apache.org/licenses/LICENSE-2.0
  (the upstream `LICENSE` is the standard Apache-2.0 text). The full text is
  reproduced upstream at https://github.com/ory/polis/blob/main/LICENSE.
- **Ory Enterprise License (OEL):** **NOT used.** No OEL component is pulled,
  bundled, configured, or depended upon. Only the Apache-2.0 core (SAML/OIDC
  SSO, SCIM 2.0 Directory Sync, OAuth 2.0 flows, admin portal, DB drivers).

## Integration boundary (why Polis deps aren't in our SBOM)

Polis runs as its own process/container with its own `node_modules`. ServiceCycle
talks to it over HTTP (OAuth + SCIM + admin API). We do **not** vendor, import,
or redistribute Polis or its transitive dependencies inside the ServiceCycle
artifact, so they are out of scope for our `license-checker --production` scan.
See [`SSO_DESIGN.md` §10](./SSO_DESIGN.md) for the app-side dependency-scan
results (the only new app-side dependency this work adds is `jose`, MIT).

## Apache-2.0 §4 redistribution note

If a ServiceCycle distribution ever ships the Polis image or its source, retain
the upstream `LICENSE` (Apache-2.0) and this attribution alongside it, and
include a `NOTICE` if/when upstream adds one (none exists upstream as of 26.2.0).
