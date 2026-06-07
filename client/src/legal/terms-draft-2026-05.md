> **DISCLAIMER — DRAFT, NOT YET COUNSEL-REVIEWED.**
>
> Drafted by AI on 2026-05-04 to give a startup attorney a structured
> starting point. Pending counsel review before publication. Do not link
> to or rely on this draft until it has been reviewed and approved by a
> licensed attorney qualified in your jurisdiction. The provider makes
> no representation that this draft is legally sufficient, complete, or
> appropriate for any particular use.

# LapseIQ Terms of Service

**Effective Date:** *To be set on publication.*
**Version:** Draft v1 — 2026-05-04
**Provider:** ForgeRift LLC, a Wisconsin limited liability company ("ForgeRift," "we," "us," "our").
**Service:** LapseIQ — software-asset and contract-renewal management software, distributed in self-hosted form and made available in a public sandbox at demo.lapseiq.com (the "Service").

These Terms of Service (the "Terms") govern your access to and use of the Service. By accessing the Service, downloading the Service software, or completing the LapseIQ first-run setup wizard on your own infrastructure, you agree to be bound by these Terms. If you do not agree, do not access or install the Service.

If you are accepting these Terms on behalf of an organization, you represent that you have authority to bind that organization, and "you" refers both to you individually and to that organization.

---

## 1. Beta status; provided AS-IS

The Service is currently offered as a **public beta**. The Service may contain bugs, undocumented behaviors, incomplete features, and changes between versions that are not backward-compatible. We may modify, suspend, or discontinue any part of the Service at any time, with or without notice.

THE SERVICE AND ALL SOFTWARE, DOCUMENTATION, AND CONTENT MADE AVAILABLE THROUGH OR IN CONNECTION WITH THE SERVICE ARE PROVIDED **"AS IS" AND "AS AVAILABLE,"** WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE. TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, FORGERIFT DISCLAIMS ALL WARRANTIES, INCLUDING WITHOUT LIMITATION THE IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, AND THOSE ARISING FROM A COURSE OF DEALING OR USAGE OF TRADE. WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, SECURE, OR THAT IT WILL MEET YOUR REQUIREMENTS.

> **AI-output notice — read before relying on AI features.**
>
> The Service's optional AI features — including but not limited to PDF extraction, signature reading, renewal-brief generation, and the "Ask LapseIQ" chat — produce outputs from probabilistic models. **AI-generated outputs may be inaccurate, incomplete, fabricated, or misleading.** They are estimates, not authoritative determinations. You agree that you will independently verify any AI-generated output before relying on it for any business decision, contract action, regulatory filing, or other consequential purpose. ForgeRift is not responsible for any decision, action, or omission you take in reliance on an AI-generated output. This notice is in addition to the warranty disclaimers in Sections 1 and 8.

---

## 2. License grant

Subject to your compliance with these Terms, ForgeRift grants you a worldwide, non-exclusive, non-transferable, non-sublicensable, royalty-free license to install, run, and use the Service software on infrastructure you own or control, solely for your internal business purposes during the term of these Terms.

This license does not grant you any rights to the source code repositories, build pipelines, or non-public artifacts maintained by ForgeRift, except to the extent ForgeRift makes those rights available under a separate written agreement (such as the Apache 2.0 license accompanying any open-source release).

You may not, and may not permit any third party to: (a) sublicense, sell, lease, or rent the Service or access to it; (b) remove or alter any proprietary notices, branding, or attributions; (c) reverse-engineer, decompile, or attempt to derive the source code or models underlying any non-open-source component, except to the extent that applicable law expressly prohibits such restriction; (d) use the Service to develop a competing product; or (e) use the Service in violation of any applicable law or these Terms.

---

## 3. Your account and your data

### 3.1 Account responsibility

You are responsible for all activity that occurs under your installation of the Service, including the activity of users you grant access to. You agree to (a) keep credentials, encryption keys (including the LapseIQ `MASTER_KEY`), and API tokens confidential; (b) promptly notify us if you discover any unauthorized access; and (c) maintain accurate registration information.

### 3.2 Your data, your responsibility

The Service runs on infrastructure that you own or control. ForgeRift does not host, store, or have routine access to data you process through the Service. You are the sole controller of all data you upload, store, or process through the Service ("Your Data"), and you are responsible for the lawfulness, accuracy, and integrity of Your Data, including obtaining all necessary consents, complying with applicable data-protection laws, and meeting any sector-specific requirements (HIPAA, FERPA, PCI DSS, GDPR, CCPA, and any other framework that applies to you).

### 3.3 IP ownership

You retain all right, title, and interest in and to Your Data. ForgeRift retains all right, title, and interest in and to the Service, the LapseIQ software, the LapseIQ name and brand, and all underlying technology and intellectual property. No rights are granted to you except as expressly set out in Section 2.

---

## 4. Demo sandbox at demo.lapseiq.com

The Service includes a publicly accessible demo sandbox hosted at `demo.lapseiq.com` (the "Demo"). The Demo is provided **for evaluation purposes only**.

### 4.1 No real data

You agree not to upload, enter, or otherwise submit to the Demo any data that is sensitive, confidential, regulated, or otherwise non-public. This includes, without limitation: real customer or vendor contracts, financial account credentials, personally identifiable information of third parties, health information, payment-card data, and any data subject to a non-disclosure obligation.

### 4.2 No persistence guarantee

Demo accounts are subject to automatic deletion after **5 consecutive calendar days of inactivity**. The shared `admin@demo.local`, `manager@demo.local`, `viewer@demo.local`, and `consultant@demo.local` accounts are reset to documented default credentials each night at approximately 03:30 UTC. We may also delete demo data at any time without notice. **Do not rely on the Demo to store anything you cannot afford to lose.**

### 4.3 No support obligation

The Demo is provided AS-IS with no support obligation. We do not guarantee uptime, response time, or any service level for the Demo.

---

## 5. Acceptable use

You agree not to (and not to permit any third party to):

- Use the Service for any unlawful, fraudulent, or harmful purpose;
- Attempt to gain unauthorized access to any system, account, or data not your own;
- Probe, scan, or test the vulnerability of the Service or any related infrastructure without our prior written permission (responsible-disclosure reports under the policy in `SECURITY.md` are welcome and exempt from this restriction);
- Introduce malware, ransomware, or other malicious code into the Service;
- Interfere with or disrupt the Service or any servers or networks connected to it;
- Use the Service to harass, defame, or harm any person or organization;
- Circumvent any rate limits, access controls, or technical restrictions intended to protect the Service or other users;
- Use the Service or any AI feature output to develop, train, fine-tune, or improve any machine learning model, large language model, or other artificial-intelligence system, except for an internal model used solely within your organization and not made available to any third party;
- Share, distribute, or publish credentials for the Demo (including the shared `admin@demo.local`, `manager@demo.local`, `viewer@demo.local`, and `consultant@demo.local` accounts) to any person who is not a current employee or authorized contractor of your organization;
- Conduct automated scraping, data harvesting, or systematic extraction of content from the Service or the Demo other than via documented APIs and within applicable rate limits;
- Bypass or attempt to bypass any captcha, rate limit, IP block, or other access control;
- Use the Service or the Demo to mine cryptocurrency or perform other compute-intensive workloads unrelated to evaluation of the Service.

We reserve the right to suspend or terminate access for any user or installation that we reasonably believe is violating this Section 5.

---

## 6. Sub-processors and third-party services

The canonical, version-controlled list of sub-processors that ForgeRift engages on its operated services (the marketing site at `lapseiq.com` and the demo sandbox at `demo.lapseiq.com`) is published at **https://lapseiq.com/sub-processors** and is incorporated into these Terms by reference. The list there is the authoritative source; previous versions of these Terms included an inline table that could drift from the canonical list and that table has been removed in favor of the single source of truth.

On a self-hosted installation, the Service transmits data to optional third-party providers (AI providers, email providers, storage providers, news feeds) **only when you opt in** by setting the corresponding environment variable. ForgeRift never receives a copy of data transmitted through those optional integrations. The opt-in providers are also listed at https://lapseiq.com/sub-processors as "Tier 2" so an operator evaluating which integrations to enable has a single place to review them.

**Sub-processor changes.** ForgeRift may add, remove, or replace sub-processors from time to time. ForgeRift will provide at least **30 days' prior notice** of any addition or replacement of a sub-processor that processes personal data on your behalf, by updating the table above and notifying registered admin contacts via email or in-product notice. A shorter notice period may apply where a change is required for security, legal, or operational continuity reasons. If you object to a new sub-processor on reasonable grounds, your sole remedy is to terminate these Terms under Section 7. **ForgeRift is not responsible for outages, errors, or other failures of any third-party sub-processor or integration provider listed above.**

---

## 7. Termination

You may terminate these Terms at any time by ceasing to use the Service and uninstalling the Service software from your infrastructure.

We may terminate or suspend your right to access the Service at any time, with or without cause, by giving you written notice (which may be by email or in-product). Suspensions for breach of Section 5 may be effective immediately. **The notice commitments in this Section 7 do not apply to access to the public beta or the Demo described in Section 4, which are governed by Section 1 and may be modified, suspended, or discontinued at any time without notice.**

**For paid customers under a separate written agreement** with ForgeRift, ForgeRift will provide at least **30 days' written notice** before discontinuing access to the Service for convenience-of-the-provider reasons (as opposed to breach, security, or legal-compliance reasons).

**Run-out license on full Service discontinuation.** If ForgeRift permanently discontinues the Service in its entirety, paid customers in good standing as of the discontinuation notice retain a perpetual, non-exclusive, royalty-free right under Section 2 to continue running the most recent version of the LapseIQ on-premises Software then-distributed to them, on their own infrastructure, for their internal business purposes, AS-IS and without any continuing right to support, updates, patches, hosted services, or third-party integrations. This run-out license is subject to all license restrictions in Section 2 and all surviving obligations under these Terms.

Upon termination, the licenses granted in Section 2 (other than any run-out license under this Section 7) immediately terminate. Sections 1, 2 (license restrictions), 3.3, 4.1, 5, 7, 8, 9, and 10–13 survive termination.

---

## 8. Warranty disclaimers (continued)

In addition to the disclaimers in Section 1, ForgeRift expressly disclaims any warranty that (a) the AI-generated outputs of the Service (including extracted contract fields, renewal briefs, and news classifications) will be accurate, complete, or suitable for any decision-making purpose, and (b) the security controls of the Service will prevent every form of attack. AI-generated outputs are estimates produced by a probabilistic model and require human review before use. Security controls reduce risk; they do not eliminate it.

---

## 9. Limitation of liability

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW:

**(a) Cap.** FORGERIFT'S TOTAL CUMULATIVE LIABILITY ARISING OUT OF OR RELATED TO THESE TERMS OR THE SERVICE WILL NOT EXCEED THE GREATER OF (i) USD $100 OR (ii) THE AMOUNTS PAID BY YOU TO FORGERIFT FOR THE SERVICE IN THE 12 MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM.

**(b) Exclusions.** IN NO EVENT WILL FORGERIFT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, **EXEMPLARY**, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUES, DATA, GOODWILL, OR BUSINESS OPPORTUNITY, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES AND EVEN IF A LIMITED REMEDY FAILS OF ITS ESSENTIAL PURPOSE.

**(b-1) Carve-outs from the cap and exclusions.** Notwithstanding subsections (a) and (b), the limitations in this Section 9 do not apply to: (i) either party's indemnification obligations under Section 10; (ii) your breach of Section 2 (license restrictions) or Section 5 (Acceptable Use); (iii) your payment obligations to ForgeRift; (iv) either party's fraud, willful misconduct, or gross negligence; (v) either party's breach of confidentiality obligations under any separate signed agreement between the parties; and (vi) any liability that cannot lawfully be limited or excluded under applicable law. For each of (i) through (vi), liability is uncapped to the maximum extent permitted by applicable law.

**(c) Allocation.** YOU ACKNOWLEDGE THAT THE LIMITATIONS IN THIS SECTION 9 ARE A FUNDAMENTAL ELEMENT OF THE BARGAIN BETWEEN YOU AND FORGERIFT AND THAT FORGERIFT WOULD NOT MAKE THE SERVICE AVAILABLE TO YOU ABSENT THESE LIMITATIONS.

**(d) Statutory exceptions.** Nothing in these Terms limits or excludes any liability that cannot lawfully be limited or excluded under applicable law, including but not limited to liability for: (i) death or personal injury caused by negligence; (ii) fraud or fraudulent misrepresentation; or (iii) any other liability that cannot be excluded by mandatory law of your country of habitual residence. Where the limitations in this Section 9 cannot be enforced as drafted, ForgeRift's liability is limited to the maximum extent permitted by applicable law.

Some jurisdictions do not allow the exclusion of certain warranties or the limitation of liability for certain damages. To the extent that those limitations cannot be enforced, ForgeRift's liability is limited to the maximum extent permitted by applicable law.

---

## 10. Indemnification

You agree to indemnify, defend, and hold harmless ForgeRift, its officers, members, employees, and agents from and against any third-party claims, liabilities, damages, losses, and expenses (including reasonable attorneys' fees) arising out of or related to (a) your use of the Service, (b) Your Data, (c) your violation of these Terms, or (d) your violation of any law or the rights of any third party.

Without limiting the foregoing, your indemnity expressly includes claims arising out of or related to: (a) your use of, or any decision or action you took in reliance on, AI-generated outputs from the Service; and (b) any data you uploaded, processed, or transmitted through the Service or any sub-processor.

ForgeRift provides no reciprocal indemnity to you during the public beta. Any indemnity from ForgeRift to you exists only if and to the extent expressly set out in a separate written agreement signed by an authorized representative of ForgeRift.

---

## 11. Governing law; informal resolution; arbitration

**(a) Governing law.** These Terms are governed by the laws of the State of Wisconsin, USA, without regard to its conflict-of-laws principles. The United Nations Convention on Contracts for the International Sale of Goods does not apply.

**(b) Informal resolution required first.** Before commencing any arbitration or court proceeding, you and ForgeRift agree to attempt in good faith to resolve any dispute by sending a written notice describing the dispute, the relief sought, and your contact information to **support@lapseiq.com** (for notices to ForgeRift) or to the email address registered with your installation (for notices to you). The parties will attempt resolution for at least **30 days** before either party commences a formal proceeding. The 30-day period tolls any applicable limitations period.

**(c) Mandatory binding arbitration.** Except as provided in subsection (e), any dispute, claim, or controversy arising out of or relating to these Terms, the Service, or the relationship between you and ForgeRift (a "Dispute") that is not resolved through the informal-resolution process will be resolved by **binding individual arbitration** administered by JAMS under its Streamlined Arbitration Rules and Procedures then in effect. The arbitration will be seated in **Milwaukee, Wisconsin**, conducted in English, and decided by a single arbitrator. The arbitrator's award is final and may be entered in any court of competent jurisdiction. **The Federal Arbitration Act, 9 U.S.C. §§1 et seq., governs the interpretation and enforcement of this arbitration agreement.**

**(d) Class-action and jury-trial waivers.** YOU AND FORGERIFT EACH WAIVE ANY RIGHT TO PARTICIPATE IN A CLASS ACTION, COLLECTIVE ACTION, CONSOLIDATED ACTION, OR REPRESENTATIVE ACTION, AND EACH WAIVE ANY RIGHT TO A JURY TRIAL, IN CONNECTION WITH ANY DISPUTE. The arbitrator may award relief only on an individual basis. If a court determines that this waiver is unenforceable as to a particular Dispute, then that Dispute (and only that Dispute) will be severed from arbitration and resolved in court under subsection (f); the remaining Disputes will continue in arbitration. **State Attorney General carve-out:** Nothing in this subsection (d), or in subsections (c) or (e), limits the authority of a State Attorney General or other governmental authority to bring an action — including a parens patriae action — on behalf of residents of that state under applicable state consumer-protection law, state privacy law, or other statute granting that authority.

**(e) Carve-outs.** Either party may bring an individual claim in small-claims court if the claim qualifies for that forum. ForgeRift may seek injunctive or other equitable relief in any court of competent jurisdiction to protect its intellectual property rights, confidential information, or to prevent unauthorized access to the Service.

**(f) Court fallback.** For any Dispute that subsection (e) excludes from arbitration, or any Dispute the arbitrator declines to hear, the parties consent to the **exclusive jurisdiction and venue of the state and federal courts located in Milwaukee County, Wisconsin**.

**(g) EU/UK consumer carve-out.** If you are a consumer (as defined under the consumer-protection laws of your country of habitual residence) resident in the European Union, the European Economic Area, the United Kingdom, or Switzerland: (i) the arbitration agreement in subsections (c)–(d) does not apply to you; (ii) you may bring a claim in the courts of your country of habitual residence as permitted by mandatory consumer-protection law; and (iii) nothing in these Terms limits any non-waivable rights granted to you by mandatory consumer-protection law of your country of habitual residence. In addition, the AS-IS warranty disclaimers in Sections 1 and 8 and the liability cap and exclusions in Section 9 apply only to the maximum extent permitted by mandatory consumer-protection law of your country of habitual residence; nothing in these Terms is intended to exclude or limit any non-waivable statutory warranty, remedy, or liability that applies to you as a consumer. Notices of material changes under Section 12 will be provided to you by email or in-product notice with a reasonable opportunity to reject the change before it takes effect, where required by mandatory consumer-protection law.

**(h) Export and territory.** The Service is controlled and operated from the United States and is offered to US-based businesses only. We do not market, target, or otherwise direct the Service to data subjects or businesses in the European Union, European Economic Area, United Kingdom, or Switzerland. The demo sandbox at demo.lapseiq.com includes a country gate restricting new account creation to US-based businesses. If you access the Service from outside the United States, you do so on your own initiative and are responsible for compliance with local laws. ForgeRift will revisit this geographic scope when it has confirmed paying customers in EU/UK/Swiss jurisdictions and the corresponding compliance investments (Article 27 representative appointments, expanded sub-processor DPA flow-downs, jurisdictional accountability infrastructure) are appropriate.

---

## 12. Changes to these Terms

We may update these Terms from time to time. When we make material changes, we will update the Effective Date at the top of this document and provide reasonable notice (such as by email to your registered admin address, or by an in-product notice). Continued use of the Service after the new Effective Date constitutes acceptance of the updated Terms. If you do not agree to the updated Terms, your sole remedy is to stop using the Service.

---

## 13. Miscellaneous

**Entire agreement; precedence.** These Terms (together with the Privacy Policy and any written agreement between you and ForgeRift) constitute the entire agreement between the parties with respect to the Service and supersede all prior or contemporaneous understandings. In the event of a conflict between these Terms and a separately signed Master Services Agreement (MSA) between you and ForgeRift, the MSA controls with respect to its subject matter. A signed order form controls over the MSA, which controls over these Terms, which control over the Privacy Policy with respect to the operated Service.

**No waiver; severability.** Our failure to enforce any provision of these Terms is not a waiver of that provision. If any provision is held unenforceable, the remaining provisions will remain in full force and effect.

**Assignment.** You may not assign or transfer these Terms without our prior written consent. We may assign these Terms freely, including in connection with a merger, acquisition, or sale of substantially all of our assets.

**Force majeure.** Neither party will be liable for any failure or delay in performance due to causes beyond its reasonable control.

**Notices.** Notices to ForgeRift may be sent to **support@lapseiq.com**. Notices to you may be sent to the email address registered with your installation or, in the case of the Demo, to the address used to create your demo account.

**Contact.** Questions about these Terms? Email **support@lapseiq.com**.
