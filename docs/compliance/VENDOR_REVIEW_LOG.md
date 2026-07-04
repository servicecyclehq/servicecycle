# Vendor Review Log

**Purpose:** dated record of when each sub-processor was last reviewed. SOC 2 auditors ask "when did you last verify DigitalOcean's SOC 2 status?" and want a table.

**Owner:** Dustin
**Cadence:** annually per vendor, or on any material change (vendor SOC 2 lapses, adds a subprocessor, changes DPA).
**Companion:** `docs/VENDOR_SECURITY_REVIEW.md` (the substantive review per vendor).

---

## Log

| Vendor | Purpose | Last reviewed | Reviewer | Findings | Next review | Evidence file |
|---|---|---|---|---|---|---|
| DigitalOcean | Compute + backup storage (droplet + optional Spaces) | 2026-06-25 | Dustin | SOC 2 Type II current; DPA on file | 2027-06-25 | `docs/VENDOR_SECURITY_REVIEW.md` §DigitalOcean |
| Cloudflare | DNS + CDN + WAF | 2026-06-25 | Dustin | SOC 2 Type II current | 2027-06-25 | `docs/VENDOR_SECURITY_REVIEW.md` §Cloudflare |
| Brevo (Sendinblue) | Transactional email | 2026-06-25 | Dustin | ISO 27001; SOC 2 not yet | 2027-06-25 | `docs/VENDOR_SECURITY_REVIEW.md` §Brevo |
| Resend | Inbound email webhook | 2026-06-25 | Dustin | SOC 2 Type II in progress | 2027-06-25 | `docs/VENDOR_SECURITY_REVIEW.md` §Resend |
| Backblaze B2 (or configured S3 target) | Encrypted backup archives | 2026-06-25 | Dustin | Varies by target; ciphertext-only stored regardless | 2027-06-25 | `docs/VENDOR_SECURITY_REVIEW.md` §Backup |
| Google Gemini (free tier) | Nameplate OCR trickle (PII-scrubbed) | 2026-07-04 | Dustin | Provider policies checked; free-tier retention documented in vendor review | 2027-07-04 | `docs/VENDOR_SECURITY_REVIEW.md` §AI providers |
| Groq (free tier) | LLM fallback | 2026-07-04 | Dustin | Provider policies checked | 2027-07-04 | `docs/VENDOR_SECURITY_REVIEW.md` §AI providers |
| GitHub | Repo + CI + Actions + secrets | 2026-06-25 | Dustin | SOC 2 Type II current | 2027-06-25 | `docs/VENDOR_SECURITY_REVIEW.md` §GitHub |
| Better Stack | Uptime + heartbeat | 2026-07-04 | Dustin | Provider security posture checked; low data sensitivity (health-check probe data only) | 2027-07-04 | `docs/VENDOR_SECURITY_REVIEW.md` §BetterStack |
| Customer BYO AI providers (Anthropic / OpenAI / Gemini paid) | Paid-tier LLM per customer | Continuous — customer owns DPA | Customer | Customer's responsibility | Customer's cadence | N/A |

## What each annual review checks

For each SC-owned vendor:

1. **Trust page status** — does the vendor's SOC 2 Type II report still show current-year coverage?
2. **DPA** — is the current DPA on file? Any material updates since last review?
3. **Sub-processor list** — has the vendor added or removed sub-processors? If added, do we accept them?
4. **Data region** — has the vendor changed default data region?
5. **PII scope** — has the vendor changed what they process on our behalf?
6. **Incident notification SLA** — same or changed?
7. **Any breaches disclosed publicly** since last review?
8. **Contract term / auto-renewal** — is there a renewal decision to make?

## Change events (out-of-cadence)

Log here when a vendor triggers a material event:

| Date | Vendor | Event | Action taken |
|---|---|---|---|
| _(none logged yet)_ | | | |

## When to add a new vendor

1. Substantive review row in `docs/VENDOR_SECURITY_REVIEW.md`.
2. Row in this log with initial review date + next review date.
3. Row in `SECRETS_INVENTORY.md` if the vendor issues us a credential.
4. Row in `ASSET_INVENTORY.md`.
5. Row in `DATA_FLOW.md` if data flows to them.

## When to remove a vendor

1. Note removal date + reason here.
2. Rotate the credentials at that vendor (`SECRETS_INVENTORY.md`).
3. Confirm no residual references in code or `.env`.
4. Add a `SECURITY_DECISIONS.md` entry explaining the removal.
5. Keep the row for historical reference (do not delete).
