# Asset Inventory

**Purpose:** flat table of everything that constitutes ServiceCycle's production surface. SOC 2 auditors ask for this in the first hour of a Type I engagement. Update on any material change.

**Owner:** Dustin
**Last updated:** 2026-07-04
**Review cadence:** quarterly

---

## Compute

| ID | Type | Purpose | OS / Runtime | Location | Owner | Backups | Notes |
|---|---|---|---|---|---|---|---|
| droplet-sc-prod | DO Droplet, 2 vCPU / 2 GB RAM | Production API + client + PG | Ubuntu 22.04, Docker Compose (node:20-slim server, PG18 db) | DigitalOcean NYC region, 198.211.99.45 | Dustin | Nightly encrypted pg_dump → S3 target | Also serves demo behind basic-auth |
| workstation-founder | Windows laptop | Dev + deploy origin | Windows 11 + WSL, BitLocker on | Milwaukee, WI | Dustin | Not backed up (source is in GH; secrets in password manager) | Endpoint policy: `ENDPOINT_SECURITY.md` |

## Networking

| ID | Type | Purpose | Owner | Notes |
|---|---|---|---|---|
| dns-servicecycle.app | Domain registered | Root domain + subdomains | Dustin | Registrar-lock on; MFA on registrar |
| cloudflare-proxy | Cloudflare Free plan | DDoS + CDN + DNS | Dustin | MFA on account; WAF at Free tier |
| tls-cert | Let's Encrypt via Cloudflare Origin CA | HTTPS termination | Dustin | Auto-renew via nginx / Cloudflare Origin CA |

## Data stores

| ID | Type | Data class | Encryption at rest | Encryption in transit | Backup | Retention |
|---|---|---|---|---|---|---|
| pg-prod | Postgres 18, docker network only | Customer data (all classes) | Volume-level (DO); field-level for `ENCRYPTED_KEYS` under `MASTER_KEY` | HTTPS to API only | Nightly pg_dump | 30 days rolling |
| backup-s3 | S3-compatible target (Backblaze / other) | Encrypted pg_dumps | Client-side AES-256-GCM via `BACKUP_ENCRYPTION_KEY` | HTTPS | N/A (is a backup) | 30 days rolling |

## SaaS accounts

| Account | Purpose | MFA | SSO to it? | Owner | Vendor risk row |
|---|---|---|---|---|---|
| GitHub — repo owner | Source, CI, secrets, Actions | ✅ | N/A (root) | Dustin | see `VENDOR_SECURITY_REVIEW.md` |
| DigitalOcean | Compute, backups | ✅ | N/A | Dustin | ✓ |
| Cloudflare | DNS, CDN, WAF | ✅ | N/A | Dustin | ✓ |
| Domain registrar | Domain ownership | ✅ + registrar lock | N/A | Dustin | ✓ |
| Brevo / Resend | Transactional email | ✅ | N/A | Dustin | ✓ |
| Backblaze (or other S3 target) | Backups | ✅ | N/A | Dustin | ✓ |
| Better Stack | Uptime + heartbeat | ✅ | N/A | Dustin | ✓ |
| Password manager | Secret storage | ✅ + recovery vault | N/A | Dustin | ✓ |

## Code + release artifacts

| Item | Where | Owner | Notes |
|---|---|---|---|
| `github.com/<org>/ServiceCycle` | Private repo | Dustin | Only account with write |
| CycloneDX SBOM | `server/sbom/cyclonedx.json` | Dustin | Regenerated via `npm run sbom:sync` |
| Container images | Built on the droplet during deploy | Dustin | No public registry |

## AI providers (external, no data at rest with provider)

| Provider | Use | Owner | Data sent | Data retention | BYO or SC-owned? |
|---|---|---|---|---|---|
| Gemini (Google) | Free-tier fallback (nameplate OCR trickle) | Dustin | PII-scrubbed image + prompt | Provider default (see vendor review) | SC-owned |
| Groq | Free-tier fallback | Dustin | PII-scrubbed text | Provider default | SC-owned |
| Anthropic / OpenAI / Gemini (customer BYO) | Paid-tier LLM | Customer | Customer-defined | Customer's DPA | Customer BYO |

## What is NOT in scope

- Personal cloud storage (Drive / iCloud).
- Personal password manager for non-SC accounts.
- Mobile devices — no production access from mobile is authorized.
- Local dev containers on the founder workstation — synthetic data only.

## Change procedure

Every addition, removal, or reclassification of an asset:

1. Update this doc in the same PR that introduces the change.
2. If it's a SaaS account, update `SECRETS_INVENTORY.md` too.
3. If it's a data store or trust boundary, revisit `THREAT_MODEL.md` (§ change triggers).
4. If it's a vendor, add a row to `VENDOR_SECURITY_REVIEW.md`.
