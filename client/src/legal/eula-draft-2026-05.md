> **DISCLAIMER — DRAFT, NOT YET COUNSEL-REVIEWED.**
>
> Drafted by AI on 2026-05-04 to give a startup attorney a structured
> starting point. Pending counsel review before publication. Do not link
> to or rely on this draft until it has been reviewed and approved by a
> licensed attorney qualified in your jurisdiction. The provider makes
> no representation that this draft is legally sufficient, complete, or
> appropriate for any particular use.

# LapseIQ — End-User License Agreement (EULA)

**Effective Date:** *To be set on publication.*
**Version:** Draft v1 — 2026-05-04
**Licensor:** ForgeRift LLC, a Wisconsin limited liability company ("ForgeRift," "we," "us," "our").
**Software:** The LapseIQ self-hosted contract-renewal management application, including the server, client, container images, scripts, and accompanying documentation distributed by ForgeRift (collectively, the "Software").

---

## How this differs from the Terms of Service

The Terms of Service (ToS) at [lapseiq.com/terms](https://lapseiq.com/terms) govern your use of services that ForgeRift operates — the marketing site at lapseiq.com and the demo sandbox at demo.lapseiq.com. **This EULA governs your use of the Software you install on infrastructure you own or control.** You may be bound by both: the ToS while you're evaluating the demo, this EULA the moment you install. Where the two overlap, this EULA controls for the installed Software, and the ToS controls for the hosted services.

---

## 1. Acceptance

You accept this EULA when you do any of the following: (a) run `scripts/install.sh` and answer "yes" to the EULA prompt; (b) start the LapseIQ first-run setup wizard at `/setup` and check the "I accept the EULA, Terms of Service, and Privacy Policy" box on the account-creation step (the setup wizard presents this EULA in a scrollable region and requires affirmative acknowledgment before the wizard can complete; ForgeRift records the timestamp and document-set version of acceptance on the User row); or (c) register a user account via the `/api/auth/register` API endpoint **with an explicit `acceptedEulaVersion` field in the request body**. Programmatic registrations without an `acceptedEulaVersion` field are rejected by the API as non-compliant electronic-signature events. If you do not agree, do not install or operate the Software.

Earlier drafts of this EULA listed `docker pull` from GitHub Container Registry and `git clone` of the LapseIQ source repository as acceptance events. Those events have been removed because (1) `docker pull` does not reliably surface this EULA to the operator at the CLI, and (2) the source repository is private under Section 2; access to clone it is granted only under a separate written agreement.

If you are accepting on behalf of an organization, you represent that you have authority to bind that organization, and "you" refers both to you individually and to that organization.

Each of the acceptance events in this Section 1 constitutes an electronic signature with the same legal force as a handwritten signature under the federal Electronic Signatures in Global and National Commerce Act (15 U.S.C. § 7001 et seq.) and the Wisconsin Uniform Electronic Transactions Act (Wis. Stat. ch. 137, more specifically Wis. Stat. §§ 137.11–137.26).

---

## 2. License grant

Subject to your continuous compliance with this EULA, ForgeRift grants you a worldwide, non-exclusive, non-transferable, non-sublicensable, royalty-free license to:

- (a) install and run the Software on infrastructure you own or control, in object-code form, solely for your internal business operations;
- (b) make a reasonable number of copies of the Software for backup and disaster-recovery purposes;
- (c) make modifications to the configuration of the Software (e.g., environment variables, theme overrides) for your internal use, **except** that you may not make modifications inconsistent with Sections 3, 4, or 5 of this EULA.

**No source-code license is granted by this EULA.** The Software repository is currently private. Where ForgeRift makes any portion of the Software available under a separate open-source license (e.g., the Apache 2.0 license accompanying any open-source release), the terms of that separate license control for those portions; this EULA continues to apply to all other portions.

---

## 3. Restrictions

You may not, and may not permit any third party to:

- **Resell or sublicense.** Sublicense, sell, lease, rent, distribute, or otherwise make the Software available to any third party as a commercial offering, including under a "managed hosting" or "white-label" model.
- **Affiliates and subcontractors.** You may permit (i) your affiliates that are under common ownership and control with you and (ii) third-party service providers acting solely on your behalf and bound by confidentiality obligations no less protective than this EULA, to access and use the Software solely to support your internal business operations. You remain fully responsible for their compliance with this EULA. This is not a permitted "managed hosting" or "white-label" arrangement under the preceding bullet.
- **Reverse-engineer.** Reverse-engineer, disassemble, decompile, or otherwise attempt to derive the source code of the Software, except to the extent that applicable law expressly prohibits such restriction (e.g., interoperability rights under EU Directive 2009/24/EC).
- **Build a competing product.** Use the Software's non-public features, performance characteristics, or confidential information disclosed by ForgeRift to develop, or to assist a third party in developing, a product that offers substantially similar functionality to the Software's core contract-renewal-management features, as described in the then-current LapseIQ documentation. This restriction does not prohibit ordinary internal benchmarking, learning from publicly documented features, or developing software that addresses adjacent or different use cases.
- **Remove notices.** Remove, alter, or obscure any proprietary notices, copyright legends, brand marks, or third-party-license attributions in the Software, the Software's container images, or the SBOM shipped at `/app/sbom/` inside the runtime image.
- **Run a benchmark.** Publish benchmarks, comparisons, or performance evaluations of the Software without our prior written consent. (You may run benchmarks for internal purposes.)
- **Circumvent technical controls.** Circumvent any rate limit, license check, or security control implemented in the Software.

---

## 4. Updates and versioning

ForgeRift may release updates, patches, and new versions of the Software from time to time. You are not obligated to install any update, but ForgeRift's support obligations (such as they exist under a separate written commercial-support agreement) apply only to the most recent stable release and the immediately preceding stable release.

Where an update materially changes the license terms (e.g., changes to Sections 3 or 5), the new license terms apply only to versions installed after the update; your existing installation continues to be governed by the version of this EULA that was in effect when you installed it.

ForgeRift may discontinue the Software at any time on at least **90 days' written notice** (which may be by email to your registered admin address, by GitHub Release notes, or by a notice in the LapseIQ documentation site). Discontinuation does not retroactively revoke your license to operate any version of the Software installed before the notice date.

---

## 5. Telemetry and outbound network calls

The Software is **telemetry-free by default**. In its default configuration, the Software does not transmit any data to ForgeRift or to any third party. Specifically, the Software does not contain "phone home" beacons, license-validation callbacks, anonymous-usage analytics, or any similar mechanism in its default state.

The following outbound calls happen **only when you opt in** by setting the corresponding environment variable:

- AI extraction / renewal briefs / chat / news classification — only when `AI_ENABLED=true` and an `AI_PROVIDER` + key are configured. The Software supports the following provider values: `cloudflare` (Cloudflare Workers AI — production-permitted free tier), `anthropic` (Anthropic Claude — paid commercial API), `openai` (OpenAI — paid API), `azure_openai` (Azure OpenAI Service — paid), `gemini_vertex` (Google Vertex AI — paid tier), `mistral` (Mistral La Plateforme — paid Scale plan), or `ollama` (self-hosted local model). Calls go to the provider you select, not to ForgeRift. **You are responsible for selecting a provider tier that permits production / commercial use.** Free tiers of Google AI Studio, Mistral Experiment, Cerebras, and Groq are not recommended for production use (their terms restrict free tier to evaluation/prototyping only); Cloudflare Workers AI is the only widely-available free tier that explicitly permits production use.
- Outbound transactional email — only when `EMAIL_MOCK=false` and a provider key is set. Recommended: `BREVO_API_KEY` (Brevo SAS). Legacy: `RESEND_API_KEY` (Resend, Inc.) is supported only for older installations; configuring `RESEND_API_KEY` without `BREVO_API_KEY` emits a deprecation warning at boot.
- Vendor-news web-search enrichment — only when `TAVILY_API_KEY` is set. Calls go to Tavily Research, Inc. and include the category slug + product type only (no vendor name, product, or contract details).
- News scanner — only when `NEWS_SCANNER_ENABLED=true`. Calls go to the configured RSS feeds.
- Slack / Teams webhook digests — only when the corresponding webhook URL is configured.
- Cloud storage / backup — only when `STORAGE_DEST=s3` or `BACKUP_DEST=s3` is set with credentials for an external S3-compatible store you control.

The in-product feedback feature is **disabled by default on self-hosted installations** (`FEEDBACK_ENABLED=false`). To enable it, set `FEEDBACK_ENABLED=true` and configure `SUPPORT_EMAIL` to the address where you want feedback delivered. When enabled, feedback submissions are delivered to the address you configure — ForgeRift does not receive a copy unless the operator routes feedback to a ForgeRift-controlled address.

**Email subject-line bypass disclosure.** The Software's email module contains a narrow debug bypass: emails whose subject line begins with `[LapseIQ Feedback]` will be transmitted via the configured email provider even when `EMAIL_MOCK=true` is set. This bypass is included to support feedback collection on managed demo environments where `EMAIL_MOCK=true` is otherwise the default. On self-hosted installations, this bypass has no effect unless (a) you have configured `EMAIL_MOCK=true`, AND (b) an in-product feedback feature is invoked with a subject containing the bypass prefix, AND (c) you have explicitly configured `SUPPORT_EMAIL` to a ForgeRift-controlled address. The Software does not preset `SUPPORT_EMAIL` to a ForgeRift-controlled address in any default configuration.

ForgeRift does not receive a copy of any data sent through any of the integrations above. If a future version of the Software introduces any outbound call to a ForgeRift-controlled endpoint, that change will be (a) opt-in by default, (b) called out explicitly in the release notes for the version that introduces it, *and (c) limited to operational telemetry that does not include customer-uploaded content, document text, or extracted contract data unless you separately and expressly opt in*.

Where the Software transmits data to a third-party AI provider under the AI-extraction or renewal-brief features, you (not ForgeRift) select the provider, contract with the provider, and supply the API credentials. The Software functions only as a conduit at your direction; ForgeRift is neither a party to your relationship with the provider nor a processor of any data so transmitted.

---

## 6. Your data

The Software runs on your infrastructure. ForgeRift does not host, store, or have routine access to any data you process through the Software. You are the sole controller of all data you upload, store, or process through the Software, and you are responsible for the lawfulness, accuracy, and integrity of that data, including obtaining all necessary consents and complying with any applicable data-protection laws.

ForgeRift retains all right, title, and interest in and to the Software, including all intellectual property rights. You retain all right, title, and interest in and to your data.

ForgeRift is not a "processor" or "service provider" of any data you process through the Software within the meaning of GDPR, CCPA, or any analogous data-protection law solely by virtue of licensing the Software to you. Where the Software transmits data to a third-party AI provider, messaging service, or storage destination, those transmissions occur at your direction and under credentials and configuration you control; ForgeRift is not in that data path. If you voluntarily provide ForgeRift with logs, screenshots, database extracts, or other materials in connection with support, you represent that you have the right to do so, you will redact information you do not wish ForgeRift to see, and any such materials will be handled solely to provide the requested support.

---

## 7. Third-party components

The Software incorporates third-party open-source components, each of which is licensed under its own license terms. The complete list, with version numbers and license identifiers, is shipped inside every container image at `/app/sbom/` and is also available on request from support@lapseiq.com.

Nothing in this EULA limits or restricts your rights under the licenses of any third-party open-source component, with respect to that component.

---

## 8. Term and termination

This EULA takes effect on the date you accept it under Section 1 and continues until terminated.

You may terminate at any time by uninstalling the Software and destroying all copies in your control.

ForgeRift may terminate this EULA on written notice (delivered in accordance with the Notices provision of Section 12; cure periods begin on the date the notice is sent) if (a) you materially breach Sections 2, 3, or 5 and fail to cure within 30 days of notice, **except that ForgeRift may terminate this EULA effective immediately on written notice for breach of Section 3 (Restrictions) or Section 12 (Export controls) where, in ForgeRift's reasonable judgment, the breach is incurable or threatens irreparable harm**; or (b) you become insolvent, file for bankruptcy, or undergo a similar event affecting your ability to perform.

On termination by ForgeRift, you must promptly cease using the Software, uninstall it, and destroy all copies in your control. Sections 3 (Restrictions), 6 (Your data — to the extent it limits ForgeRift's involvement), 9 (Warranty disclaimer), 10 (Liability), 11 (Indemnification), and 12 (General) survive termination.

---

## 9. Warranty disclaimer

THE SOFTWARE IS PROVIDED **"AS IS" AND "AS AVAILABLE,"** WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE. TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, FORGERIFT DISCLAIMS ALL WARRANTIES, INCLUDING WITHOUT LIMITATION THE IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, AND THOSE ARISING FROM A COURSE OF DEALING OR USAGE OF TRADE.

WITHOUT LIMITING THE FOREGOING, FORGERIFT DOES NOT WARRANT THAT (i) THE SOFTWARE WILL BE UNINTERRUPTED, ERROR-FREE, OR FREE OF HARMFUL COMPONENTS; (ii) ANY DATA STORED IN OR PROCESSED BY THE SOFTWARE WILL BE ACCURATE, COMPLETE, OR PRESERVED; (iii) THE SECURITY CONTROLS IMPLEMENTED IN THE SOFTWARE WILL PREVENT EVERY ATTACK; OR (iv) THE OUTPUTS OF THE SOFTWARE'S AI FEATURES (FIELD EXTRACTION, RENEWAL BRIEFS, NEWS CLASSIFICATION) WILL BE ACCURATE OR SUITABLE FOR ANY DECISION-MAKING PURPOSE.

AI-GENERATED OUTPUTS ARE ESTIMATES PRODUCED BY A PROBABILISTIC MODEL AND REQUIRE HUMAN REVIEW BEFORE USE. THE SOFTWARE'S DEFAULT CONFIGURATION SURFACES CONFIDENCE SCORES ON EVERY EXTRACTED FIELD; YOU AGREE TO REVIEW THESE BEFORE ACTING ON ANY EXTRACTED VALUE.

AS BETWEEN THE PARTIES, YOU BEAR ALL RISK ARISING FROM USE OF THE SOFTWARE'S AI-GENERATED OUTPUTS, INCLUDING ANY OUTPUT RELATING TO CONTRACT DATES, AMOUNTS, RENEWAL DEADLINES, OR PARTY IDENTIFIERS. CONFIDENCE SCORES ARE INFORMATIONAL ONLY; FORGERIFT MAKES NO REPRESENTATION THAT A HIGH-CONFIDENCE SCORE INDICATES ACCURACY OR THAT A LOW-CONFIDENCE SCORE INDICATES INACCURACY. FORGERIFT IS NOT A LEGAL, FINANCIAL, OR PROFESSIONAL ADVISOR, AND THE SOFTWARE IS NOT A SUBSTITUTE FOR PROFESSIONAL REVIEW. FORGERIFT HAS NO DUTY TO MONITOR YOUR USE OF THE SOFTWARE, TO ALERT YOU TO LOW-CONFIDENCE OUTPUTS, OR TO NOTIFY YOU OF MISSED RENEWALS.

---

## 10. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW:

**(a) Cap.** FORGERIFT'S TOTAL CUMULATIVE LIABILITY ARISING OUT OF OR RELATED TO THIS EULA OR THE SOFTWARE WILL NOT EXCEED THE GREATER OF (i) USD $100 OR (ii) THE AMOUNTS PAID BY YOU TO FORGERIFT FOR A LICENSE TO THE SOFTWARE IN THE 12 MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM. BECAUSE THE SOFTWARE IS PROVIDED FREE OF CHARGE DURING BETA, THIS CAP WILL TYPICALLY RESOLVE TO USD $100.

Notwithstanding the foregoing, the limitations in this Section 10(a) do not apply to: (i) either party's indemnification obligations under Section 11 (including ForgeRift's IP-infringement indemnity under Section 11(b) and your indemnity under Section 11(c)); (ii) your breach of Section 3 (Restrictions); (iii) your breach of Section 12 (Export controls); or (iv) either party's fraud, willful misconduct, or gross negligence. For each of (i) through (iv), liability is uncapped to the maximum extent permitted by applicable law.

Without limitation, all claims arising out of or related to the Software's AI-generated outputs (including field extraction, renewal briefs, news classification, and any confidence score) are subject to the limitations and exclusions in this Section 10.

**(b) Exclusions.** IN NO EVENT WILL FORGERIFT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUES, DATA, GOODWILL, OR BUSINESS OPPORTUNITY, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES AND EVEN IF A LIMITED REMEDY FAILS OF ITS ESSENTIAL PURPOSE.

The exclusions in this Section 10(b) do not apply to: (i) either party's indemnification obligations under Section 11; (ii) your breach of Section 3 (Restrictions); or (iii) either party's fraud or willful misconduct. To the extent applicable law prohibits the exclusion of liability for gross negligence, this Section 10(b) does not exclude such liability.

**(c) Allocation.** YOU ACKNOWLEDGE THAT THE LIMITATIONS IN THIS SECTION 10 ARE A FUNDAMENTAL ELEMENT OF THE BARGAIN BETWEEN YOU AND FORGERIFT AND THAT FORGERIFT WOULD NOT MAKE THE SOFTWARE AVAILABLE TO YOU ABSENT THESE LIMITATIONS.

Some jurisdictions do not allow the exclusion of certain warranties, the limitation of liability for certain damages, or the disclaimer of liability for gross negligence, willful misconduct, or fraud. Nothing in this EULA excludes or limits any liability that cannot be excluded or limited under applicable law. To the extent any limitation in this Section 10 is held unenforceable, ForgeRift's liability is limited to the maximum extent permitted by that law.

---

## 11. Indemnification

**(a) Definitions.** As used in this Section 11, an "IP Claim" means any third-party claim alleging that the Software, as distributed by ForgeRift and used by you in accordance with this EULA and the documentation, infringes a valid United States patent, registered copyright, registered trademark, or trade secret of the third party.

**(b) ForgeRift's IP-infringement indemnity.** ForgeRift will defend you against any IP Claim and will pay any damages or settlement amount finally awarded by a court of competent jurisdiction or agreed by ForgeRift in settlement. For clarity, ForgeRift's obligations under this Section 11(b) are not subject to the limitations in Section 10, consistent with the carve-out in Section 10(a)(i); the procure-modify-replace-terminate options below, together with the sole-remedy sentence at the end of this Section 11(b), define ForgeRift's exposure on an IP Claim. ForgeRift's obligations under this Section 11(b) are conditional on you (i) promptly notifying ForgeRift in writing of the IP Claim, (ii) giving ForgeRift sole control of the defense and settlement, and (iii) cooperating reasonably at ForgeRift's expense. ForgeRift's obligations under this Section 11(b) do not apply to any IP Claim arising from or relating to (A) your modification of the Software, (B) your combination of the Software with hardware, software, services, or content not provided by ForgeRift where the claim would not have arisen but for the combination, (C) your use of the Software after ForgeRift has notified you to discontinue use, or (D) content, configurations, or data you supply. If an IP Claim is brought or, in ForgeRift's reasonable judgment, is likely to be brought, ForgeRift may at its option (1) procure for you the right to continue using the Software, (2) modify the Software so it is non-infringing, (3) replace the Software with substantially equivalent non-infringing software, or (4) terminate the affected license and refund any unearned prepaid license fees you paid for the affected portion of the Software. THIS SECTION 11(b) STATES YOUR SOLE AND EXCLUSIVE REMEDY, AND FORGERIFT'S ENTIRE LIABILITY, FOR ANY THIRD-PARTY CLAIM ALLEGING INFRINGEMENT BY THE SOFTWARE.

**(c) Your indemnity.** You agree to indemnify, defend, and hold harmless ForgeRift, its officers, members, employees, and agents from and against any third-party claims, liabilities, damages, losses, and expenses (including reasonable attorneys' fees) arising out of or related to (i) your use of the Software in violation of this EULA, (ii) any data you process through the Software, or (iii) your violation of any law or the rights of any third party.

Your obligations under this Section 11(c) do not extend to claims to the extent caused by ForgeRift's fraud, willful misconduct, or gross negligence. Where a claim arises from both parties' conduct, indemnification responsibility is apportioned according to comparative fault under applicable law.

---

## 12. General

**Governing law.** This EULA is governed by the laws of the **State of Wisconsin, USA**, without regard to its conflict-of-laws principles. The United Nations Convention on Contracts for the International Sale of Goods does not apply.

**Informal resolution required first.** Before commencing any arbitration or court proceeding, you and ForgeRift agree to attempt in good faith to resolve any dispute by sending a written notice describing the dispute, the relief sought, and your contact information to **support@lapseiq.com** (for notices to ForgeRift) or to the email address registered with your installation (for notices to you). The parties will attempt resolution for at least **30 days** before either party commences a formal proceeding. The 30-day period tolls any applicable limitations period.

**Mandatory binding arbitration.** Except as provided in the "Carve-outs" paragraph below, any dispute, claim, or controversy arising out of or relating to this EULA, the Software, or the relationship between you and ForgeRift (a "Dispute") that is not resolved through the informal-resolution process will be resolved by **binding individual arbitration** administered by JAMS under its Streamlined Arbitration Rules and Procedures then in effect. The arbitration will be seated in **Milwaukee, Wisconsin**, conducted in English, and decided by a single arbitrator. The arbitrator's award is final and may be entered in any court of competent jurisdiction. **The Federal Arbitration Act, 9 U.S.C. §§ 1 et seq., governs the interpretation and enforcement of this arbitration agreement.**

**Class-action and jury-trial waivers.** YOU AND FORGERIFT EACH WAIVE ANY RIGHT TO PARTICIPATE IN A CLASS ACTION, COLLECTIVE ACTION, CONSOLIDATED ACTION, OR REPRESENTATIVE ACTION, AND EACH WAIVE ANY RIGHT TO A JURY TRIAL, IN CONNECTION WITH ANY DISPUTE. The arbitrator may award relief only on an individual basis. If a court determines that this waiver is unenforceable as to a particular Dispute, then that Dispute (and only that Dispute) will be severed from arbitration and resolved in court under the "Court fallback; venue" paragraph below; the remaining Disputes will continue in arbitration.

**Carve-outs.** Either party may bring an individual claim in small-claims court if the claim qualifies for that forum. ForgeRift may seek injunctive or other equitable relief in any court of competent jurisdiction to protect its intellectual property rights, confidential information, or to prevent unauthorized access to the Software. Nothing in this arbitration agreement limits ForgeRift's ability to seek the remedies described in Section 11(b) on an IP Claim brought against you.

**Court fallback; venue.** For any Dispute that the "Carve-outs" paragraph excludes from arbitration, or any Dispute the arbitrator declines to hear, the parties consent to the **exclusive jurisdiction and venue of the state and federal courts located in Milwaukee County, Wisconsin**.

**EU/UK consumer carve-out.** If you are a consumer (as defined under the consumer-protection laws of your country of habitual residence) resident in the European Union, the European Economic Area, the United Kingdom, or Switzerland: (i) the arbitration agreement and class-action waiver above do not apply to you; (ii) you may bring a claim in the courts of your country of habitual residence as permitted by mandatory consumer-protection law; and (iii) nothing in this EULA limits any non-waivable rights granted to you by mandatory consumer-protection law of your country of habitual residence.

**Export controls.** You will not export, re-export, or transfer the Software in violation of US export-control laws or the export-control laws of any other applicable jurisdiction.

**US Government rights.** If the Software is licensed by or on behalf of the US Government, the Software is "commercial computer software" and "commercial computer software documentation" as defined in FAR 12.212 and DFARS 227.7202. The Government's rights to use, modify, reproduce, release, perform, display, or disclose the Software are governed solely by this EULA.

**Entire agreement; severability; assignment; force majeure.** This EULA, together with the Privacy Policy (which governs the marketing site and demo sandbox only) and any separate written agreement between you and ForgeRift (including any Master Services Agreement and any signed order form), is the entire agreement between the parties regarding the Software. In the event of conflict, a signed Master Services Agreement controls over a signed order form, which controls over this EULA, which controls over the Privacy Policy with respect to the installed Software. If any provision is held unenforceable, the remaining provisions remain in effect. You may not assign this EULA without our prior written consent; we may assign freely. Neither party is liable for delay or failure caused by events beyond its reasonable control.

**Notices.** Notices to ForgeRift may be sent to **support@lapseiq.com**. Notices to you may be sent to the email address you provided at install time or in any later support correspondence. The parties agree that electronic notices, including by email to the address each party most recently provided to the other, satisfy any legal-notice requirement under this EULA. A notice is effective on the date sent unless the sender receives a delivery-failure response, in which case the notice is effective only upon successful re-delivery to an updated address.

**Contact.** Questions about this EULA? Email **support@lapseiq.com**.
