> **DISCLAIMER — DRAFT, NOT YET COUNSEL-REVIEWED.**
>
> Drafted by AI on 2026-05-04. Pending counsel review before
> publication. Do not link to or rely on this draft until it has
> been reviewed and approved by a licensed attorney.

# ServiceCycle — Sub-processor List

**Last updated:** 2026-05-04 (draft)
**Notification commitment:** ForgeRift LLC will publish updates to this list at `https://servicecycle.app/sub-processors` and notify customers' designated contacts at least **30 days** before any new sub-processor begins processing Customer Personal Data.

---

## Important context

ServiceCycle is **self-hosted by default**. When you install ServiceCycle on infrastructure you own or control:

- ForgeRift is **not in the data path**. We don't host, store, or have routine access to anything you process through your installation.
- The sub-processors below are services that **your installation** may transmit data to **only when you opt in by configuring the corresponding integration**. Each is disabled in the default configuration.
- ForgeRift is the data Controller (not Processor) for the limited categories of data we collect directly through `servicecycle.app` and `servicecycle.app` — those are governed by our [Privacy Policy](/privacy), not by the sub-processor obligations below.

When ForgeRift is engaged as a Processor under a Master Services Agreement (e.g., for a managed-cloud deployment we operate on your behalf), the sub-processor list below is incorporated into the [Data Processing Addendum](/legal/dpa).

---

## Tier 1 — Infrastructure ForgeRift operates directly

These sub-processors handle the marketing site, the demo sandbox, and (when applicable) any ForgeRift-managed instances.

| Sub-processor | Service provided | Hosting region | Data they may see | Last verified |
| --- | --- | --- | --- | --- |
| **Cloudflare, Inc.** | TLS termination, edge caching, DDoS protection, email routing for `*@servicecycle.app` | Global edge | Network metadata (IP, request paths, response codes), edge-cached static assets, in-flight inbound email contents during routing | 2026-05-17 |
| **DigitalOcean, LLC** *(or equivalent IaaS provider)* | Compute hosting for the demo sandbox at `servicecycle.app` and any ForgeRift-managed instance | NYC1 region (US East), or as disclosed in the relevant order form | Application data at rest on encrypted block storage, network traffic in flight | 2026-05-17 |
| **Brevo SAS** (formerly Sendinblue) | Transactional email delivery for all outbound mail: alert digests, password resets, demo notifications, early-access auto-reply, in-product feedback, and beta-program correspondence. Replaced Resend, Inc. as the sole transactional email provider in v0.36.x. | France (with EU-region storage) | Recipient email address, message subject, message body | 2026-05-19 |
| **Cloudflare, Inc. — Workers AI** | Primary AI provider on `servicecycle.app` as of v0.35.0 (2026-05-17). Mistral Small 3.1 24B for contract extraction and renewal-brief generation; Llama 3.1 8B for Ask ServiceCycle chat and news classification. Replaces prior Anthropic / Gemini configurations. | Global edge | Contract metadata (product name, vendor, dates, pricing, internal notes, tags, renewal history); raw uploaded document text at extraction time; Ask ServiceCycle question text. **Cloudflare Workers AI terms prohibit use of Customer Content to train models** and prohibit sharing Customer Content across other Cloudflare customers. The free tier (10,000 Neurons/day) explicitly permits production use; overage billed at $0.011/1,000 Neurons. Budget guard enforced at $25/month maximum (see EULA §5). | 2026-05-17 |
| **Hugging Face, SAS** | Fallback AI provider for Ask ServiceCycle chat and news classification when Cloudflare Workers AI is unavailable (rate-limit, 5xx, or temporary outage). | France (EU main establishment regulated by CNIL); Inference Endpoints can be configured for specific regions | Chat queries and news headline text only. Hugging Face does NOT retain user data for training; short-term (minutes-scale) cache for repeated requests is the only retention. SOC 2 Type 2 certified on Inference Endpoints. | 2026-05-17 |
| **Groq, Inc.** | Secondary fallback for Ask ServiceCycle chat when both Cloudflare and Hugging Face are unavailable. | United States (GCP) | Chat queries only. Groq does NOT train on customer inputs by default; retention limited to system reliability and abuse monitoring per its published DPA. EU/UK representatives appointed (Hamburg, Germany / London, UK). | 2026-05-17 |
| **Tavily Research, Inc.** | Web-search enrichment for the Renewal Brief's Market section. The demo enables this; self-host installs omit `TAVILY_API_KEY` to disable. | United States | Category slug + product type only (e.g. "B2B SaaS renewal pricing benchmarks"). No vendor name, no product name, no contract details. | 2026-05-17 |
| **Better Stack (BetterStack Inc.)** | Uptime monitoring + log ingestion for the demo droplet at `servicecycle.app`. Outbound HTTP probes (every ~60s) and one-way structured log shipping. | United States | HTTP probe responses (status code, latency, body bytes), structured server log lines (may include user-agent + IP at the edge level). Customer document content is NEVER shipped. | 2026-05-22 |
| **Stripe, Inc.** *(provisioned; billing not yet active in production)* | Payment processing for the future paid tiers. ForgeRift uses Stripe Checkout in redirect mode so payment-card data is collected directly by Stripe — ForgeRift never sees PAN/CVV (SAQ-A scope). | United States | Billing-contact name, billing email, last-4 of card, Stripe customer ID | 2026-05-17 (config provisioned; first live charge not yet executed) |
| **GitHub, Inc. (GHCR)** | Source-code repository (private) and Container Registry (public images at `ghcr.io/forgerift/servicecycle-server`, `ghcr.io/forgerift/servicecycle-client`) | United States | Pull metadata (we do not log who pulls images) | 2026-05-17 |

## Tier 2 — Optional integrations your self-hosted installation may use

These appear in the sub-processor list **only because you might enable them in your `.env`**. ForgeRift never receives a copy of any data sent through these integrations from your installation.

| Sub-processor | Triggers when... | What your installation sends | Free-tier production-use permission |
| --- | --- | --- | --- |
| **Cloudflare, Inc. — Workers AI** | `AI_ENABLED=true` and `AI_PROVIDER=cloudflare` | Contents of contract documents and renewal-brief prompts you submit through AI features | **YES** — Cloudflare's Workers AI free tier (10K Neurons/day) explicitly permits production use. No training on prompts. |
| **Anthropic, PBC** | `AI_ENABLED=true` and `AI_PROVIDER=anthropic` | Contents of contract documents and renewal-brief prompts you submit through AI features | Paid tier only. Free trial credits are for prototyping. |
| **OpenAI, Inc.** | `AI_ENABLED=true` and `AI_PROVIDER=openai` | Same as above | Paid tier only. |
| **Microsoft Corporation (Azure OpenAI)** | `AI_ENABLED=true` and `AI_PROVIDER=azure_openai` | Same as above; remains within your Azure tenant if so configured | Paid tier only (per Azure customer agreement). |
| **Google LLC (Gemini via paid Vertex AI)** | `AI_ENABLED=true` and `AI_PROVIDER=gemini_vertex` | Same as above | Paid Vertex AI tier permits production. **The free Google AI Studio tier is for prototyping only and is NOT recommended for production use** (its terms permit Google to use prompts for model improvement). |
| **Mistral AI (paid Scale plan)** | `AI_ENABLED=true` and `AI_PROVIDER=mistral` | Same as above | Paid Scale plan only. **The free Experiment tier is for prototyping only and is NOT recommended for production use** (Mistral's own ToS restricts free tier to evaluation/prototyping). |
| **Self-hosted Ollama / vLLM / equivalent** | `AI_ENABLED=true` and `AI_PROVIDER=ollama` | Stays on your own hardware. No third-party transmission. | n/a — your hardware, your control. |
| **Brevo SAS** | `EMAIL_MOCK=false` and `BREVO_API_KEY` set | Recipient address, subject, body of outbound transactional email |
| **Slack Technologies, LLC** | A Slack incoming-webhook URL is configured for an account | Alert digest payloads for that account |
| **Microsoft Corporation (Teams)** | A Teams webhook URL is configured | Same as above |
| **Amazon Web Services, Inc. / S3-compatible providers** | `STORAGE_DEST=s3` or `BACKUP_DEST=s3` with credentials | Uploaded documents and/or `pg_dump.gz` backups, depending on which is configured |
| **The set of RSS news feeds enumerated in `server/lib/newsScanner.js`** | `NEWS_SCANNER_ENABLED=true` | Outbound HTTP fetches only — no data leaves your installation |
| **Healthchecks.io** | `HEALTHCHECKS_PING_URL` is set | Outbound heartbeat pings only (cron timing metadata: success / failure / duration). No customer data. |
| **AWS / Azure / GCP cloud-marketplace connectors** | `CLOUD_CONNECTOR_<provider>=true` with operator-supplied credentials | License-grant metadata + billing-event metadata pulled FROM the provider. No customer data transmitted TO the provider. |

You can find the operative configuration variables in `server/.env.example` and the canonical source-of-truth list in [`docs/install.md`](https://servicecycle.app/docs/install).

---

## How we evaluate sub-processors

Before adding a sub-processor that may receive Customer Personal Data on a ForgeRift-managed deployment, we:

1. Review the provider's current published **Data Processing Agreement** (or equivalent terms) for protections consistent with our obligations under applicable data protection law.
2. Where the provider publishes a **SOC 2 Type II** report or equivalent independent audit covering the service tier we use, we review it before adoption. Where no such audit is published for the relevant service tier, we document the gap and the compensating controls considered.
3. Confirm the provider's standard contractual transfer mechanism for international data flows (Standard Contractual Clauses, UK IDTA, or applicable adequacy decision).
4. Document the integration in the table above before flipping the feature flag in production.

For Tier 2 integrations on self-hosted installations, the same evaluation is the **operator's responsibility** because ForgeRift is not in the data path. We list them above so operators can perform that evaluation with the right starting information.

---

## Notification of changes

We will give existing customers **at least 30 days' written notice** before adding or replacing a Sub-processor that may process their Personal Data, by:

- Updating this page (the public source of truth);
- Notifying the designated contact on the customer's order form, MSA, or DPA by email; and
- Where applicable, posting an in-product banner.

Customers may object to a new Sub-processor on reasonable data-protection grounds within the notice period. If we cannot resolve the objection in good faith, the customer's sole remedy is to terminate the affected Services on written notice without further liability — see DPA Section 4(d).

---

## Contact

Questions about this list, or to register a designated contact for sub-processor change notifications: **support@servicecycle.app**.

For security-specific questions, see [`SECURITY.md`](https://github.com/forgerift/servicecycle/blob/main/SECURITY.md) or email **security@servicecycle.app**.
