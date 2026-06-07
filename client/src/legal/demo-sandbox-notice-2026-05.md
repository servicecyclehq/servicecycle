> **DISCLAIMER — DRAFT, NOT YET COUNSEL-REVIEWED.**
>
> Drafted by AI on 2026-05-04. Pending counsel review before
> publication. Do not link to or rely on this draft until it has been
> reviewed and approved by a licensed attorney. The provider makes no
> representation that this draft is legally sufficient, complete, or
> appropriate for any particular use.

# LapseIQ — Demo Sandbox Notice

**This Demo Sandbox Notice is a binding agreement and a supplement to the Terms of Service and Privacy Policy linked below. By clicking "Create Account" you affirmatively agree to (a) the four points in this notice and (b) the linked Terms of Service and Privacy Policy. If you do not agree, do not click "Create Account."**

---

## What this is

LapseIQ's demo sandbox is a public, shared environment for evaluating the product. It runs the same code as the on-prem release, pre-populated with sample contracts, vendors, and renewal scenarios.

## What you're agreeing to

By creating a sandbox account, you confirm you understand:

1. **No real data.** Don't upload, paste, or type real contracts, customer data, financial credentials, personally identifiable information about third parties, or anything else that's confidential, regulated, or under NDA. The demo is for clicking around — not for actual contract management. If you want to use LapseIQ on real data, install it on your own infrastructure (the auto-reply email after our signup form ships you a one-line installer). We may delete or suspend any sandbox we reasonably believe contains data prohibited above; we are not obligated to notify you before doing so.

2. **Your sandbox auto-deletes after 5 consecutive calendar days of inactivity.** Each visitor gets their own isolated workspace. We do not access sandbox content as a matter of course, but we may access, scan, or delete it where reasonably necessary to investigate abuse, respond to a security incident, comply with law, or enforce these terms. If you don't log in for 5 consecutive calendar days, the entire sandbox — vendors, contracts, documents, password — is permanently deleted. There is no recovery, no backup we can restore from, and no warning email.

3. **No support, no warranty, no SLA.** The demo is provided AS-IS. It might be down. It might be slow. It might have bugs we haven't seen yet. If something breaks, we'll fix it when we notice — but you can't open a support ticket against the demo, and we don't owe you uptime. The on-prem product carries the same AS-IS warranty disclaimer; commercial support is a separate conversation.

4. **AI features run on the demo's shared AI infrastructure, with strict per-user caps.** All AI features are capped per user, per day, on the demo. As of v0.35.0 (2026-05-17):

   - **PDF / image contract extraction** capped at **1 extraction per day per user**.
   - **Renewal brief generation** capped at **3 briefs per day per user**.
   - **Ask LapseIQ chat queries** capped at **10 per day per user**.
   - **News classification** is cron-driven (not user-initiated); subject to a system-wide daily ceiling, not a per-user cap.

   **AI providers on the demo:** Primary provider is **Cloudflare Workers AI** (Mistral Small 3.1 24B for contract extraction and renewal briefs; Llama 3.1 8B for Ask LapseIQ chat and news classification). Fallback providers, used only when Cloudflare is rate-limited or temporarily unavailable, are **Hugging Face Inference API** and **Groq Cloud** (chat / classification only). Cloudflare's Workers AI terms prohibit use of customer inputs or outputs to train models. The demo's AI spend is hard-capped at $25 per month under a server-side budget guard.

   **Self-hosted installations use a "bring-your-own-AI" (BYO-AI) model** — operators connect their own AI provider's API key (Cloudflare, Anthropic, OpenAI, Azure OpenAI, Google Vertex AI, Mistral paid Scale plan, or self-hosted Ollama). The operator pays their AI provider directly; ForgeRift does not resell or bill for AI usage on self-hosted deployments. See the LapseIQ Settings → AI screen and the install guide at https://lapseiq.com/install#step-3-ai for provider selection guidance.

   You'll see "Daily AI limit reached — self-host LapseIQ to remove all caps" if you exceed any per-user cap. Caps exist for sustainable-demo cost protection and to keep the demo within "light production use" thresholds on free-tier-eligible providers; they are not feature limits and may be adjusted.

   **Web-search enrichment of the Market section:** capped at the renewal-brief generation cap above (you cannot exceed the brief cap to trigger searches). Only the category slug and product type are sent to Tavily — no vendor name, no contract details.

   **Per-session AI consent prompt:** the first time you use any AI feature in a browser session, an acknowledgment modal appears naming the active AI provider for that task (Cloudflare Workers AI on the demo, by default). You can silence the per-session prompt in Settings → AI (your acknowledgment is still recorded server-side after the first click). The acknowledgment records the EULA version number you accepted, which provides the electronic-signature audit trail for AI-feature usage.

   **In-product feedback on AI brief sections:** the renewal brief shows thumbs-up/down + an optional free-text comment under each of its four sections (Situation, Market, Tactics, Watch For). On the demo, those rows are stored in the demo's own database, viewable only to admins in Settings → Template Feedback, and reset when the demo sandbox is pruned (5-day inactivity TTL). An opt-in upstream sync to a Cloudflare Worker for cross-instance template improvement is planned for v0.4.1; that's an explicit operator opt-in, not on by default.

---

## What we collect from you

Just enough to operate the sandbox: the name, email, and password you choose, plus standard server logs (IP, request paths, timestamps) for 30 days. No third-party trackers, no marketing pixels, no behavioral analytics. Full details in the [Privacy Policy](/privacy).

If you submit feedback through the in-product form, that message goes to a real human and we may reply.

## Need to delete your account before the TTL fires?

Email **support@lapseiq.com** from the address you registered with and we'll wipe your account in accordance with applicable law (typically within 30 days; sooner where required by GDPR, CCPA/CPRA, or other applicable data-protection law). See the Privacy Policy for the formal data-subject-request mechanism.

---

*If any of the above is a problem for your use case, don't create a sandbox account — install LapseIQ on your own infrastructure instead. The [install guide](https://lapseiq.com/install.sh) is one command.*

## Feedback collection on the demo

This demo deployment has the in-product feedback button enabled by default
(equivalent to `FEEDBACK_ENABLED=true` on a self-hosted install). When you
submit feedback through the button:

- The submission is emailed to the LapseIQ team.
- The email contains your feedback text, the page URL where you triggered
  the button, your demo account name, and the time of submission.
- Submissions are used to improve LapseIQ. They are not shared with third
  parties beyond the email service operator (Brevo) handling delivery.

Self-hosted production deployments of LapseIQ have this feature **off by
default** - operators must affirmatively set `FEEDBACK_ENABLED=true` in
their environment to enable. Customer instances therefore do not transmit
feedback unless the operator has chosen to.

