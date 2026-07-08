# ServiceCycle — IP Ownership Statement

**Classification:** Confidential / Diligence  
**Owner:** ForgeRift LLC  
**Prepared:** 2026-06-25

This document addresses intellectual property ownership questions that
arise during acquisition due diligence.

---

## Original code

All original source code in this repository was authored by Dustin [Founder],
sole member of ForgeRift LLC. No third parties — employees, contractors,
or sub-licensees — have contributed code to this codebase under terms
that would create IP claims against ServiceCycle or its acquirer.

The full authorship record is reflected in the Git commit history
(`git log --all --oneline`).

---

## No prior-employer IP claims

The founding engineer has had no prior employment or consulting agreements
that would give a former employer a claim over any part of the ServiceCycle
codebase. The software was conceived and developed entirely after and
independent of any prior employment relationship.

---

## Third-party open-source components

ServiceCycle uses npm packages (server and client) under overwhelmingly
permissive open-source licenses (MIT, Apache 2.0, BSD, ISC — none of which
impose copyleft obligations that would affect a proprietary distribution),
with one disclosed exception below (LGPL, dynamically linked, no obligation
attaches for an unshipped SaaS product).

**To generate a complete bill of materials:**

```bash
cd server && npm ls --all --json > server-bom.json
cd client && npm ls --all --json > client-bom.json
```

Notable licenses in use:
- Express, Prisma, React, Vite — MIT
- PDF.js — Apache 2.0
- OpenAPI tooling — MIT / Apache 2.0
- No GPL or AGPL components in production dependencies. Eight LGPL-3.0-or-later
  components are present (`@img/sharp-libvips-*`, the prebuilt native-image
  binaries that ship as optional platform variants of the `sharp` image-processing
  library — see `server/sbom/cyclonedx.json`). These are dynamically linked shared
  libraries, and ServiceCycle is operated as a hosted SaaS product, not distributed
  to end users — the standard basis on which LGPL's copyleft (source-availability/
  relinking) obligations do not attach for object-code recipients. No LGPL source
  is modified in this repository.

A periodic `npm audit` confirms no known vulnerabilities in the current
dependency tree (see `.github/workflows/ci.yml`).

---

## AI-generated code

Portions of this codebase were produced with the assistance of large
language model (LLM) tools (Anthropic Claude). Under the terms applicable
at the time of generation, AI-assisted code output is not independently
copyrightable by the LLM provider and ownership vests in the human
author directing and reviewing the output. The founding engineer
reviewed, modified, tested, and is solely responsible for all code
in this repository regardless of generation method.

---

## Domain and trademark

- **servicecycle.app** — domain registered and owned by ForgeRift LLC
- **ServiceCycle** — trademark registration not yet filed; the name
  is in use in commerce. An acquirer may wish to file a USPTO application
  post-close; no conflicting prior registrations were identified as of
  the preparation date of this document.

---

## Data rights

Customer data uploaded to the platform (inspection PDFs, arc-flash
studies, equipment records) is owned by the customer account that
uploaded it. ServiceCycle holds a processing license only, as described
in the Privacy Policy (`/legal/privacy`). No customer data is retained
by ForgeRift LLC for training AI models or for any purpose beyond
delivering the product.

---

## Clean chain of title

| Item | Status |
|---|---|
| All original code authored by ForgeRift LLC sole member | ✅ |
| No employee/contractor with IP assignment rights | ✅ (no prior contributors) |
| No prior-employer IP claims | ✅ |
| No outside equity holders or IP licensors | ✅ |
| Third-party deps: permissive licenses only | ✅ (MIT/Apache/ISC) |
| No GPL/AGPL in production dependencies | ✅ |
| LGPL in production dependencies | ⚠️ 8x `@img/sharp-libvips-*` (LGPL-3.0-or-later, dynamically linked, unshipped SaaS — no copyleft obligation attaches; see above) |
| Domain registered to ForgeRift LLC | ✅ |
| Trademark: not yet filed | ⚠️ (recommended post-close) |
| AI-assisted code: ownership vests in human author | ✅ |

---

*This statement is provided for diligence purposes and does not
constitute a legal opinion. Prospective acquirers should conduct
their own independent IP review with qualified counsel.*
