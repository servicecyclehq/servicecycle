> **DISCLAIMER — DRAFT, NOT YET COUNSEL-REVIEWED.**
>
> Drafted by AI on 2026-05-04 to give a startup attorney a structured
> starting point. Pending counsel review before publication. Do not link
> to or rely on this draft until it has been reviewed and approved by a
> licensed attorney qualified in your jurisdiction. The provider makes
> no representation that this draft is legally sufficient, complete, or
> appropriate for any particular use.

# ServiceCycle Privacy Policy

**Effective Date:** *To be set on publication.*
**Version:** Draft v1 — 2026-05-04
**Provider:** ForgeRift LLC, a Wisconsin limited liability company ("ForgeRift," "we," "us," "our").

This Privacy Policy explains what personal information we collect, how we use it, and the choices you have. This policy applies to:

1. The marketing site at **servicecycle.app**, including the early-access form;
2. The public demo sandbox at **servicecycle.app**; and
3. Any direct support communication you send to us.

**Geographic scope.** ServiceCycle's demo sandbox and marketing site are currently offered to US-based businesses only. We do not market to, target, or otherwise direct our services to data subjects in the European Union, European Economic Area, United Kingdom, or Switzerland. Demo registration includes a country gate that restricts new account creation to US-based businesses. If you access the marketing site from outside the United States, no personal data is collected beyond strictly-necessary security cookies and aggregate edge metadata (see §2.3). If you nonetheless register a demo account from outside the United States, ForgeRift will process your account as described in this Policy and you may exercise the rights described in §6 and §8A; however, we do not maintain Article 27 EU representatives or UK ICO representatives because our scope is US-targeted. We will revisit this geographic scope when ServiceCycle has confirmed paying customers in EU/UK/Swiss jurisdictions and the corresponding compliance investments are appropriate.

This policy does **not** apply to ServiceCycle instances you install on your own infrastructure. Those instances run entirely under your control; ForgeRift does not host them, does not have routine access to them, and does not see the data you process through them. You are the data controller for any data processed through a self-hosted installation, and you are responsible for the privacy practices that apply to that data. The "BYO-AI" (bring-your-own-AI) model means you select and pay your own AI provider directly; ForgeRift does not resell or bill for AI usage on self-hosted deployments.

---

## 1. The short version

- **The on-prem product is local-first by default.** No telemetry, no phone-home, no analytics beacons. When you self-host ServiceCycle, your data does not leave your infrastructure unless you explicitly enable an integration (see Section 4).
- **The marketing site has no analytics, no beacons, no tracking scripts of any kind.** The only automated source of visit data is Cloudflare's standard edge logs (network metadata only, retained on Cloudflare's product schedule -- see Section 2.2). Cloudflare also sets strictly-necessary security cookies as described in Section 2.3.
- **The demo sandbox stores whatever you put into it for up to 5 days of inactivity, then deletes it.** Don't put anything there you can't afford to lose, and never put real customer data there — the Terms of Service forbid it.
- **We send transactional email only.** Password resets, invites, alerts, your early-access auto-reply. We do not run a marketing list and do not share your email with anyone.

---

## 2. Information we collect

### 2.1 Information you give us directly

- **Early-access form (servicecycle.app):** name, email, company (optional), and how soon you want to install. We use this only to send you the install instructions and to follow up if you ask.
- **Demo sandbox registration (servicecycle.app):** the company name, full name, email address, and password you supply at registration. The password is stored as a salted bcrypt hash; we never see the cleartext.
- **Demo sandbox activity:** any contracts, vendors, documents, and notes you create in the sandbox while exploring. Subject to the deletion schedule in Section 5.
- **Support requests:** the contents of any email or message you send to support@servicecycle.app or via the in-product feedback form.

### 2.2 Information we collect automatically

- **Server logs (servicecycle.app and servicecycle.app):** IP address, user-agent string, request path, response status, and timestamp. We configure our infrastructure to retain server logs for no more than 30 days; deletion is enforced by automated log rotation (Docker logging driver `max-size` / `max-file`). Logs may be retained beyond 30 days only where required to investigate a specific, documented security incident or to comply with a legal obligation, and in those cases will be deleted promptly once the reason no longer applies.
- **Cloudflare edge metadata:** Cloudflare logs the same fields plus geolocation derived from IP, in its capacity as our edge provider. Retention is governed by Cloudflare's product-specific retention schedule (see Cloudflare's Data Processing Addendum and applicable service terms). For the products we use at our plan tier, Cloudflare retains aggregated edge analytics for approximately 30 days; detailed per-request HTTP logs are not retained at our tier (Cloudflare's Logpush feature, which would extend this, is not enabled on our account). If our Cloudflare plan changes in a way that materially alters this retention, we will update this Privacy Policy.
- **Audit log (servicecycle.app only):** authentication events (successful and failed logins), permission-denied events, and document-access events under your demo account. Audit-log rows are deleted when the underlying demo account is deleted under the schedule in Section 5; any rows that would otherwise persist longer are subject to a 365-day application-level cap.

### 2.3 What we do not collect

- We do not use third-party advertising trackers, marketing pixels, session-replay scripts, fingerprinting libraries, or behavioral analytics.
- We do not use browser cookies on servicecycle.app other than (a) a session cookie required for the demo sandbox login on servicecycle.app, and (b) Cloudflare's strictly-necessary security and performance cookies — specifically `__cf_bm` (Cloudflare's bot-management cookie, expires after 30 minutes of inactivity) and `cf_clearance` (set after a successful JavaScript challenge, where applicable) — which are set by our edge provider for security and which we treat as strictly necessary under PECR Regulation 6(4)(b) and the ICO's 2019 guidance on the cookies and similar technologies exemption, and consistent with EDPB Guidelines 5/2020 on consent. Additional Cloudflare cookies (`__cflb`, `_cfuvid`, `__cfwaitingroom`, `__cfruid`, `cf_ob_info`, `cf_use_ob`, `__cfseq`) are set only when the corresponding Cloudflare product (Load Balancer, Rate Limiting Rules with unique-visitor mode, Waiting Room, legacy Rate Limiting, Always Online, or Sequence Rules) is enabled on our account; none of these is enabled today. We do not deploy a tracking-cookie banner because no non-essential cookies are set on either site; if that ever changes, we will deploy an appropriate consent mechanism.
- We do not collect data from children under the age of 13. The Service is not directed to children, and we do not knowingly collect personal information from anyone under 13. If we learn that we have, we will delete it. Parents or legal guardians who believe a child under 13 has provided personal information to us may contact support@servicecycle.app; we will delete the information and disable any associated account promptly upon verification.

---

## 3. How we use information

We use the information described in Section 2 to:

- Provide, operate, and maintain the marketing site and the demo sandbox.
- Send you the install instructions you requested via the early-access form.
- Respond to your support requests.
- Diagnose technical problems, investigate abuse, and protect the security of our systems and our users.
- Comply with our legal obligations.

We do not sell or share personal information, as those terms are defined under the California Consumer Privacy Act / California Privacy Rights Act (CCPA/CPRA). We do not share personal information with third parties for their own marketing purposes, do not engage in cross-context behavioral advertising, and do not run a marketing-email program. The transfers to sub-processors described in Section 4 are made only for the operational purposes described in this policy and are governed by service-provider / processor terms.

For users in the EEA / UK, the legal bases on which we process personal information are: (i) **consent** for early-access form submissions and for processing demo-sandbox content you upload; (ii) **performance of a contract** (or steps prior to entering one) for responding to support requests and providing access to the demo sandbox; and (iii) **legitimate interests** for operating, securing, and preventing abuse of our marketing site and demo sandbox (Article 6(1)(f) GDPR), where the processing is limited to what is necessary for those interests and does not override your rights and freedoms.

---

## 4. Sub-processors and third-party services

When you choose to enable optional integrations on a self-hosted installation, your installation transmits data to the corresponding third party on your behalf. ForgeRift is not in that data path; we have no visibility into what your installation sends.

For the marketing site and demo sandbox that we operate directly, the following sub-processors handle infrastructure or transactional functions. The transfers described below are made to service providers and processors acting on our behalf under contractual restrictions; they are not "sales" or "shares" as defined under the CCPA/CPRA, and they are not disclosures for the recipients' own marketing or independent business purposes.

| Provider | Role | Data they see |
| --- | --- | --- |
| **Cloudflare, Inc.** | TLS termination, edge caching, DDoS protection, email routing for `*@servicecycle.app` | Network metadata; for routed inbound email (e.g. `support@servicecycle.app` → operator inbox), the email contents transit Cloudflare in flight |
| **Brevo SAS** (replaced Resend, Inc. as the sole transactional email provider in v0.36.x) | Outbound transactional email from the demo sandbox and the early-access auto-reply | Recipient address, subject, message body |
| **Cloudflare, Inc. — Workers AI** | Primary AI provider on servicecycle.app (replaces prior Anthropic/Gemini configurations as of 2026-05-17). Mistral Small 3.1 24B for contract extraction and renewal-brief generation; Llama 3.1 8B for Ask ServiceCycle assistant queries and news classification. | Contract metadata you submit for brief generation (product, vendor, dates, terms, internal notes, tags, renewal history); raw text of uploaded documents during extraction; Ask ServiceCycle question text. Custom-field values, raw uploaded documents outside the extraction call, and Template Feedback rows are NOT sent to Cloudflare. Cloudflare's Workers AI terms prohibit use of customer inputs or outputs for model training, and Cloudflare does not share Customer Content across other Cloudflare customers. |
| **Hugging Face, SAS** | Fallback AI provider for Ask ServiceCycle chat and news classification when Cloudflare Workers AI is unavailable (rate-limit, 5xx, or temporary outage). | Same data categories as Cloudflare row above, scoped to the fallback subset (chat queries, news classification only). Hugging Face's Inference API does not retain user data for training; tokens may be cached short-term (minutes) to speed repeated requests. |
| **Groq, Inc.** | Secondary fallback AI provider for Ask ServiceCycle chat when both Cloudflare and Hugging Face are unavailable. | Same data categories as Cloudflare row, scoped to chat queries only. Groq retains customer data only for system reliability and abuse monitoring (not training) per its published data-processing addendum. |
| **Tavily Research, Inc.** | Web-search enrichment of the renewal brief's Market section (Phase 4 / v0.4.0+) when the operator has set `TAVILY_API_KEY`. The demo enables this; self-host installs omit the key to disable. | The category slug and product type only (e.g. "B2B SaaS renewal pricing benchmarks"). NO vendor name, NO product name, NO contract details, NO customer information. The per-template search query is a static string defined in `server/lib/aiBrief/templates/*.js`; it never interpolates contract fields. |
| **DigitalOcean, LLC** | Hosting of the demo sandbox VM (or equivalent infrastructure provider) | Network metadata; encrypted application data on disk |
| **GitHub, Inc.** | Distribution of the ServiceCycle software via GitHub Container Registry | None — outbound pull only; we do not log who pulls images |
| **Better Stack (BetterStack Inc.)** | Uptime monitoring + log ingestion for the demo droplet only | HTTP probe responses + structured server log lines (no customer document content) |
| **Healthchecks.io** | Cron heartbeat receiver for operator-observability on managed deployments only | Heartbeat pings + cron timing metadata only |

Each of these providers is bound by its own privacy policy, which you can review on their websites.

**AI provider training and retention.** Where the Service transmits data to a third-party AI provider on the demo sandbox: Cloudflare Workers AI does NOT use inputs or outputs to train models (Cloudflare's Workers AI terms), with Customer Content retention limited to operational and abuse-monitoring purposes per Cloudflare's published policy. Hugging Face Inference API does NOT retain user data for training; a short-term (minutes-scale) cache for repeated requests is the only retention. Groq does NOT train on customer inputs by default; retention is limited to system reliability and abuse monitoring per its DPA. Deletion of demo accounts under Section 5 deletes our copies and our access; it does not bind the provider's separately-disclosed retention. Tavily's data-handling policy applies to the per-template search queries submitted (category slugs only — no vendor name, product, or contract data); their public policy describes their retention.

**AI provider training and retention — for self-hosted installations.** In self-hosted deployments, the AI provider is selected by the operator under a "bring-your-own-AI" (BYO-AI) model. ForgeRift is not in that data path and does not see the customer's prompts or outputs. The operator's own contract with their AI provider governs training, retention, and data-handling. ForgeRift publishes a provider-selection matrix in the ServiceCycle Settings UI and at https://servicecycle.app/install#step-3-ai that identifies which provider tiers permit production use vs. development/prototyping only.

**California AB 2013 (Generative AI Training Data Transparency Act, effective 2026-01-01).** AB 2013 imposes training-data disclosure obligations on AI developers, not deployers. ForgeRift is a deployer of third-party AI; the AI developers (Cloudflare, Hugging Face's hosted models, Groq's hosted models, Anthropic, OpenAI, Google) are responsible for their own AB 2013 disclosures, which can be located on each developer's website.

**AI consent acknowledgment.** Before any AI feature is used in a browser session, an in-product modal names the active AI provider for the current task (Cloudflare Workers AI on the demo by default; the configured provider on self-host) and discloses the categories of data above. The first acknowledgment is recorded server-side on your user account along with the EULA version number accepted; the per-session re-prompt can be silenced in Settings → AI.

**Template Feedback widget.** The renewal brief presents per-section thumbs+free-text feedback under each of its four sections (Situation, Market, Tactics, Watch For). In v0.4.0 those rows are stored **only** in the customer's own database — they are NOT transmitted to ForgeRift, Anthropic, Tavily, or any other party. Free-text comments are capped at 1,000 characters; pre-submit UI advises users not to include vendor names or contract details. A future release (v0.4.1) will add an explicit opt-in toggle for an upstream cross-instance feedback sync to a ForgeRift-operated Cloudflare Worker; that sync is OFF by default on self-host and will be separately disclosed.

Before adding a new sub-processor that will process personal information described in this policy, we will provide at least 30 days' prior notice — either by email to addresses we hold for early-access requesters and demo users, or by an in-product notice on servicecycle.app — except where a faster change is required for security or legal reasons. The current list of sub-processors is the canonical list as of the Effective Date.

For self-hosted installations, the equivalent table is in your Terms of Service Section 6 — ForgeRift is **not** a sub-processor of your installation.

---

## 5. Retention and deletion

- **Early-access form submissions:** retained until you ask us to delete them, or until 36 months elapse, whichever is sooner.
- **Demo sandbox accounts and data:** automatically deleted within 24 hours after the 5th calendar day of account inactivity (the "Inactivity TTL"). Deletion cascades to all owned data: vendors, contracts, documents, notes, audit log rows, and the encrypted user record. The shared `admin@demo.local` / `manager@demo.local` / `viewer@demo.local` / `consultant@demo.local` accounts are reset to documented defaults each night at approximately 03:30 UTC; any changes you make to those accounts during a session do not persist past the next reset.
- **Server logs:** 30 days.
- **Support correspondence:** retained until you ask us to delete it, or until 36 months elapse after your last contact, whichever is sooner.

If you ask us to delete a demo account before its TTL expires, email **support@servicecycle.app** from the address registered with the account and we will delete it within 14 days (and as required by applicable law, sooner where required).

---

## 6. Your rights

Depending on where you live, you may have rights under data-protection laws such as the EU and UK GDPR, the California Consumer Privacy Act (CCPA / CPRA), and similar US state laws. These rights generally include:

- **Access** — to know what personal information we hold about you.
- **Rectification** — to correct inaccurate information.
- **Deletion** — to ask us to delete your information, subject to certain exceptions.
- **Portability** — to receive your information in a structured, commonly used format.
- **Objection / restriction** — to object to or restrict certain processing.
- **Withdraw consent** — where we rely on consent, to withdraw it at any time.
- **Non-discrimination** — to not be discriminated against for exercising your rights.
- **Right to limit use of Sensitive Personal Information** — California residents have the right to limit our use and disclosure of Sensitive Personal Information. We do not collect or use Sensitive Personal Information (as defined by the CCPA/CPRA) for purposes that would trigger a right to limit. The login credentials we collect for the demo sandbox are stored as a salted bcrypt hash and used solely to authenticate access; we do not use them to infer characteristics about you.

The only category of Sensitive Personal Information we collect is account log-in credentials for the demo sandbox (email + bcrypt-hashed password). We use these credentials solely to authenticate access. We do not collect precise geolocation, government identifiers, financial-account information, race or ethnicity, religious beliefs, union membership, genetic or biometric data, health information, or sex-life or sexual-orientation information.

To exercise these rights, email **privacy@servicecycle.app** from the address associated with the data you're asking about, or describe enough information for us to locate the relevant records, or use the online form at **https://servicecycle.app/privacy/request** (when available). We will respond within the timeframe required by applicable law (typically 30–45 days). We do not charge for a first request in any 12-month period.

**Right to rectification.** To correct inaccurate personal information we hold about you, email **privacy@servicecycle.app** with the correction you'd like us to make. We will respond within the same 30-day SLA.

**Right to restriction of processing.** GDPR Article 18 permits you to ask us to limit our processing of your personal information while a dispute about its accuracy or lawful basis is being resolved. We honor restriction requests via a manual account-freeze workflow; email **privacy@servicecycle.app** to request one.

**Global Privacy Control (GPC).** We recognize Global Privacy Control browser signals where present. Because we do not sell or share personal information as defined under the CCPA/CPRA or similar US state laws, the signal has no practical effect on our processing — but we honor it for completeness.

**Automated decision-making and profiling.** We do not engage in profiling that produces legal or similarly significant effects for any data subject. AI-generated outputs (renewal briefs, contract field extraction, vendor news classification) are informational summaries presented to a human user for review before any decision is made; they are not automated decisions affecting access to credit, insurance, employment, education, housing, or essential goods or services.

To verify your identity for a rights request, we will ask you to confirm control of the email address associated with the data — for example, by replying from that address or confirming a one-time code we send to it. For higher-sensitivity requests we may ask for additional information sufficient to match the request to records we hold.

California residents may use an authorized agent to submit a request on their behalf. We may require written proof of the agent's authorization (for example, a signed permission, power of attorney, or other documentation) and may verify the consumer's identity directly.

Residents of the EEA, the United Kingdom, and Switzerland may exercise their rights under the EU GDPR / UK GDPR by contacting support@servicecycle.app. We will respond without undue delay, and in any event within one month of receipt, subject to extension where permitted by applicable law. If you believe we have not adequately addressed your request, you may lodge a complaint with your local supervisory authority.

If you are in the EU, UK, or California and believe we have not adequately addressed your concern, you also have the right to lodge a complaint with your local data-protection authority.

---

## 6A. Notice at Collection — California Residents

In the preceding 12 months we have collected, and may continue to collect, the following categories of personal information from California consumers, for the purposes and retention periods shown. The table below corresponds to the twelve categories enumerated in California Civil Code §1798.140(v).

| # | CCPA Category (§1798.140(v)) | Examples in ServiceCycle context | Collected | Sources | Business / commercial purpose | Sub-processors / Recipients |
|---|---|---|---|---|---|---|
| A | Identifiers — name, email, mailing address, IP, account name, online identifier | Name, email, company name (early-access form); IP address, user-agent string, request path (server logs); demo registration email | **YES** | Directly from you (forms, registration, support); automatically (browser, server, edge) | Provide install instructions; operate the demo sandbox; respond to support; security and abuse prevention | Cloudflare (edge + Workers AI); DigitalOcean (origin); Brevo (transactional email); GitHub (no PII pulled by GHCR pulls) |
| B | Personal information categories from Cal. Civ. Code §1798.80(e) — name, signature, address, telephone, education, employment, financial, medical | Name + company captured at signup; password (bcrypt-hashed) | **YES** | Directly from you | Account creation and authentication for demo sandbox; early-access fulfilment | DigitalOcean (encrypted at rest); Cloudflare (TLS in transit) |
| C | Characteristics of protected classifications under CA or federal law (race, color, national origin, religion, age, sex, etc.) | None | **NO** | n/a | n/a | n/a |
| D | Commercial information — records of products/services purchased, obtained, or considered | Contracts, vendors, products, prices, terms uploaded to demo sandbox | **YES** | Directly from you (demo uploads) | Demonstrate product features; AI extraction; renewal-brief generation | Cloudflare Workers AI (primary AI provider on demo); Hugging Face Inference API and Groq (fallback AI providers for chat / classification only); Tavily (category slug only, no vendor name); DigitalOcean (storage) |
| E | Biometric information | None — bcrypt password hash is NOT a biometric | **NO** | n/a | n/a | n/a |
| F | Internet or other electronic network activity — browsing history, search history, interaction with website/app | IP, user-agent, request path, response code, timestamp; cookie metadata (`__cf_bm`, `cf_clearance` only — both strictly necessary) | **YES** | Automatically from your device/browser; Cloudflare as edge service provider | Operate the service; security; rate-limit and abuse prevention. ForgeRift does not run analytics on the marketing site; Cloudflare's standard edge logs (network metadata only) are the sole automated visit-data source. | Cloudflare, Inc. (edge service provider); DigitalOcean, LLC (origin host) |
| G | Geolocation data (coarse only — precise geo is SPI; coarse city/country IP-derived is general PI) | Coarse IP-derived country/region only (Cloudflare edge metadata, used for the US-only scope gate at signup). NO precise geolocation collected. | **YES (coarse only)** | Automatically (Cloudflare derives from IP) | Service operation; security; fraud and abuse detection; US-scope verification at signup | Cloudflare, Inc. |
| H | Audio, electronic, visual, thermal, olfactory, or similar information | None | **NO** | n/a | n/a | n/a |
| I | Professional or employment-related information | Company name, self-declared role on demo (admin/manager/consultant/viewer) | **YES** | Directly from you (early-access form, demo registration) | Tailor product demonstration; route support; identify enterprise prospects | None — stored in our own systems only |
| J | Education information | None | **NO** | n/a | n/a | n/a |
| K | Inferences drawn from any of the above to create a profile reflecting preferences, characteristics, predispositions, behavior, attitudes | AI-generated renewal-brief outputs (Situation/Market/Tactics/Watch For); AI-extracted contract fields; vendor-news classifications | **YES** | Created by ForgeRift's processing of your uploaded data via configured AI provider | Demonstrate AI features; assist user with renewal preparation | Inferences are generated and stored only in the customer's own demo workspace; the AI provider sees the prompt and response in flight per its retention policy described in §4 |
| L | Sensitive personal information (§1798.140(ae)) | Account log-in credentials (email + bcrypt-hashed password) for demo sandbox; used SOLELY for authentication. Authentication-only use qualifies for the §1798.121(d) carve-out from the right-to-limit. | **YES (authentication-only carve-out applies)** | Directly from you (demo registration) | Authenticate access. Does NOT trigger §1798.121 right to limit per §1798.121(d) authentication carve-out. | DigitalOcean (encrypted at rest); Cloudflare (TLS in transit) |

ForgeRift does NOT sell or share any of the above categories of personal information as those terms are defined under CCPA/CPRA. ForgeRift does NOT engage in targeted advertising or cross-context behavioral advertising. We disclose this information only to the sub-processors listed in Section 4, each acting as a service provider or processor on our behalf.

**California opt-out posture (CCPA §1798.135).** ForgeRift does NOT sell personal information. ForgeRift does NOT share personal information for cross-context behavioral advertising. ForgeRift does NOT engage in targeted advertising. ForgeRift does NOT use Sensitive Personal Information for purposes that would trigger the right under §1798.121 to limit the use and disclosure of SPI; the only SPI we collect — account login credentials for the demo sandbox — is used solely to authenticate access. Because we do not sell, share, or process SPI for non-authentication purposes, we are not required to display a "Do Not Sell or Share My Personal Information" link or a "Limit the Use of My Sensitive Personal Information" link under §1798.135(a). We nevertheless recognize and honor Global Privacy Control browser signals consistent with §1798.135(b) and CPPA regulation §7025.

---

## 7. Security

We implement administrative, technical, and physical safeguards designed to protect personal information against unauthorized access, disclosure, alteration, and destruction. Current technical measures include TLS in transit (with HSTS), bcrypt password hashing, opt-in AES-256-GCM encryption for documents at rest in the demo sandbox, JWT entropy validation at startup, role-based access controls, and an in-product audit log. A more detailed security overview is available on request to support@servicecycle.app.

No system is perfectly secure. If we become aware of a security incident affecting your information, we will notify you in accordance with applicable law.

---

## 8. International transfers

ForgeRift is based in the United States. Information you submit through our marketing site or demo sandbox will be processed in the United States and may be transferred to other countries where our sub-processors operate. Where personal information is transferred from the EEA, the United Kingdom, or Switzerland to the United States or to other jurisdictions outside the originating country, we rely on transfer mechanisms recognized under applicable law, which may include the EU Standard Contractual Clauses (Module 2, controller-to-processor, where applicable), the UK International Data Transfer Addendum to the EU SCCs (or the IDTA), the Swiss-US recognition of the SCCs, and — where a sub-processor is certified — the EU-US Data Privacy Framework (and the UK / Swiss extensions). Copies of the relevant terms can be requested at support@servicecycle.app.

---

## 8A. State-Specific Privacy Rights (US)

Residents of the following US states may exercise the rights granted by their state's privacy law in addition to the rights described in Section 6 above:

- **California** — CCPA / CPRA. Notice at Collection in §6A.
- **Virginia** — VCDPA (effective 2023-01-01). Appeal mechanism per Va. Code §59.1-577(C); see "Appeals" subsection below.
- **Colorado** — CPA (effective 2023-07-01). Universal Opt-Out signals honored; appeal mechanism per 4 CCR 904-3 Rule 4.06; see "Appeals" below.
- **Connecticut** — CTDPA (effective 2023-07-01). Appeal mechanism per Conn. Gen. Stat. §42-518(c); see "Appeals" below.
- **Utah** — UCPA (effective 2023-12-31). 30-day cure period.
- **Texas** — TDPSA (effective 2024-07-01). ForgeRift does NOT sell sensitive personal data within the meaning of Tex. Bus. & Com. Code §541.105. No §541.105 notice is required to be displayed.
- **Oregon** — OCPA (effective 2024-07-01). Oregon residents may request a list of the specific third parties to whom we have disclosed your personal data, in addition to the categories disclosed in Section 4 / §6A; email privacy@servicecycle.app.
- **Florida** — FDBR (effective 2024-07-01). The FDBR applies only to controllers meeting the statutory $1 billion global revenue threshold; ForgeRift does not currently meet that threshold. We nevertheless extend FDBR rights to Florida residents voluntarily.
- **Montana** — MCDPA (effective 2024-10-01). 45-day response; see "Appeals" below.
- **Delaware** — DPDPA (effective 2025-01-01).
- **Iowa** — ICDPA (effective 2025-01-01). 90-day response window.
- **New Hampshire** — NHDPA (effective 2025-01-01). See "Appeals" below.
- **Nebraska** — NDPA (effective 2025-01-01).
- **New Jersey** — NJDPA (effective 2025-01-15). See "Appeals" below.
- **Tennessee** — TIPA (effective 2025-07-01). See "Appeals" below.
- **Minnesota** — MCDPA (effective 2025-07-31). Minnesota residents have all of the rights enumerated above; in addition, Minn. Stat. §325M.14(1)(g) grants a right to question profiling that produces legal or similarly significant effects. As stated in Section 6, ForgeRift does NOT engage in such profiling. AI-generated outputs (renewal briefs, contract field extraction, vendor news classification) are informational summaries presented to a human user for review before any decision is made. Minnesota residents who nonetheless wish to question any AI-generated output may contact privacy@servicecycle.app. ForgeRift's founder serves as the compliance-responsible individual consistent with Minn. Stat. §325M.04 until headcount supports a dedicated CPO role.
- **Maryland** — MODPA (effective 2025-10-01; enforcement begins 2026-04-01). For Maryland residents, ForgeRift confirms: (i) our collection of personal data is limited to what is reasonably necessary and proportionate to provide the marketing site, the demo sandbox, or to respond to support requests, consistent with Md. Code Comm. Law §14-4607(a); (ii) we do NOT sell sensitive data as defined under MODPA §14-4607(b)(2), and we do not engage in any processing of sensitive data that would require opt-in consent under §14-4607(b)(1); (iii) we do not process consumer health data within the meaning of Md. Code Comm. Law §14-4604.
- **Indiana** — INCDPA (effective 2026-01-01). See "Appeals" below.
- **Kentucky** — KCDPA (effective 2026-01-01). See "Appeals" below.
- **Rhode Island** — RIDTPPA (effective 2026-01-01). ForgeRift does NOT sell personal information of Rhode Island residents to any third party. Should that change, R.I. Gen. Laws §6-48.1-4 requires us to identify in this Privacy Policy the specific categories of third parties to whom we sell personal data, and we will update this Policy and provide notice before any such sale begins.

In each case, the rights generally include access, correction, deletion, and portability, plus a right to opt out of (a) targeted advertising, (b) sale of personal information, and (c) profiling in furtherance of decisions producing legal or similarly significant effects. **We do not engage in any of (a), (b), or (c)**, so these opt-out rights are functionally available but have no practical effect on our processing.

Response windows vary by state (most are 45 days; Texas and Florida are 60; Iowa is 90). To exercise any state-specific right, email **privacy@servicecycle.app** or use the form at https://servicecycle.app/privacy/request (when available). We will route the request to the correct workflow based on the jurisdiction you identify.

**Appeals.** If we decline a privacy rights request, you may appeal by emailing privacy@servicecycle.app with subject line `[PRIVACY APPEAL — <state abbreviation>]` within 60 days of our decision. ForgeRift will respond within 60 days of receipt of the appeal (or sooner where required by your state's law). If the appeal is denied, you may also contact your state Attorney General. Appeals are honored regardless of whether your state's law requires us to provide one. This single appeal mechanism satisfies the appeal requirements of Virginia (Va. Code §59.1-577(C)), Colorado (4 CCR 904-3 Rule 4.06), Connecticut (Conn. Gen. Stat. §42-518(c)), Montana, Delaware, New Hampshire, Nebraska, New Jersey, Tennessee, Minnesota, Maryland, Indiana, Kentucky, and Rhode Island.

> *Counsel review pending — verify each state's specific notice and mechanism requirements before publication. State enforcement priorities and laws change frequently; this Section is maintained against the version effective on the Effective Date above.*

---

## 8B. Brazil — LGPD

For data subjects in Brazil whose data is processed by the demo sandbox at servicecycle.app:

- **Lawful bases (Art. 7 LGPD).** We process Brazilian personal data on the same lawful bases described in Section 3 (consent, performance of contract, legitimate interests).
- **Encarregado (DPO equivalent).** ForgeRift has not formally appointed an encarregado under LGPD Art. 41. For LGPD-related inquiries, contact **privacy@servicecycle.app**.
- **ANPD.** If you believe we have not adequately addressed your concern, you may lodge a complaint with the Autoridade Nacional de Proteção de Dados (https://www.gov.br/anpd/).

> *Counsel review pending — verify LGPD Article 23 / Article 33 obligations for non-Brazilian controllers.*

---

## 9. Changes to this policy

We may update this Privacy Policy from time to time. When we make material changes, we will update the Effective Date at the top of this document and provide reasonable notice (such as by email to addresses we hold for early-access requesters, or by an in-product notice on the demo sandbox). Continued use of the marketing site or demo sandbox after the new Effective Date constitutes acceptance of the updated policy.

---

## 10. Contact

Privacy questions, deletion requests, or anything else covered by this policy:

**ForgeRift LLC**
Email: **privacy@servicecycle.app**
General support: **support@servicecycle.app**
*Postal address: [Wisconsin DFI registered-agent address — to be inserted at publication. Do NOT use the founder's home address.]*

**Data Protection Officer.** ForgeRift has not appointed a Data Protection Officer. Our processing activities do not meet the criteria in Article 37(1) GDPR that would require appointment of a DPO (we do not engage in large-scale systematic monitoring of data subjects, and our processing of special categories of data is incidental and prohibited by our Acceptable Use Policy). For any data-protection matter, contact privacy@servicecycle.app and we will route the inquiry to the appropriate responder.

**EU and UK representatives.** ForgeRift's services are currently offered to US-based businesses only and are not marketed, targeted, or otherwise directed to data subjects in the EU, UK, EEA, or Switzerland. We have therefore not appointed Article 27 GDPR EU representatives or UK GDPR Article 27 UK representatives. Demo registration includes a country gate restricting new account creation to US-based businesses. If you access the demo sandbox from the EU/UK/EEA/Switzerland despite that gate, you may exercise the rights described in §6 and §8A via privacy@servicecycle.app. ForgeRift will revisit the Article 27 representative requirement when our services are intentionally extended to those jurisdictions.

**DMCA designated agent.** ForgeRift has designated an agent to receive notifications of claimed copyright infringement under 17 U.S.C. §512(c). Submit notices to **dmca@servicecycle.app**; valid notices must include the elements required by §512(c)(3). The current designation is on file with the US Copyright Office at https://www.copyright.gov/dmca-directory/.
