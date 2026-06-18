# Free-Tier AI Options for ServiceCycle Parser Fallback (2026-06-12)

**Scope.** Two low-volume fallback jobs (the deterministic pdfplumber+tesseract parser handles the bulk):

1. **Text -> structured extraction** — when deterministic coverage is low, send extracted report text + JSON schema, get measurements/fields back. Needs reliable JSON output, decent context window.
2. **Vision -> fields** — nameplate photo -> equipment type / manufacturer / model / serial / ratings. Needs image input.

Expected volume: a handful to a few dozen calls/day. Hard requirements: commercial use allowed on the free tier, enough quota, vision, JSON output, and a paid tier to graduate to. **Key sensitivity: customer test-report data — "free = trains the model" is a real liability.**

Research done 2026-06-12 via web search; free-tier terms change often (Google just tightened theirs April 2026) — re-verify before wiring anything in.

---

## Comparison table

| Provider | Best free model(s) | Vision? | JSON? | Free limits | Commercial use OK? | Data-training risk | Notes |
|---|---|---|---|---|---|---|---|
| **Google Gemini API** | Gemini 3 Flash (preview) / 2.5 Flash / Flash-Lite | Yes (excellent) | Yes — native `responseSchema` structured output | Flash ~10 RPM / 250–1,500 RPD; Flash-Lite 15 RPM / ~1,000 RPD; ~250K TPM; resets midnight PT. Pro models removed from free tier Apr 2026. | **Yes** (free tier allows commercial use; EEA/UK/CH end-users require paid) | **HIGH on free tier** — unpaid-services data may be used to improve Google models, incl. human review. Paid tier (Tier 1, just link billing) = no training. | Limits are **per GCP project, not per key/account** — a dedicated ServiceCycle project gets its own free quota, no collision with the sharpedge project. 1M-token context. Smoothest paid graduation (Flash-Lite is pennies). |
| **Mistral (La Plateforme)** | Mistral Small 3.x (vision), Pixtral, **Mistral OCR** (Document AI) | Yes + dedicated OCR endpoint | Yes — `response_format` json_schema | Free "Experiment" plan: ~1 RPS, 500K tok/min, **~1B tokens/month**. Phone verification required, no card. | Free mode is "for evaluation and prototyping" — not formally banned for commercial, but framed as non-production. Scale (PAYG) plan = clean. | MEDIUM — historically free tier required allowing data use for model improvement; opt-out now reportedly available in Settings -> Privacy on all tiers. API data otherwise retained 30 days then deleted, not trained. **Verify the checkbox at workspace signup.** | Mistral OCR is purpose-built for exactly job 1+2 (doc -> structured markdown/fields). Biggest raw free volume of anyone. Tier upgrades automatic with spend. |
| **Groq** | Llama 4 Scout (vision, preview), Llama 3.3 70B (text) | Yes (Scout, 30K TPM; Maverick at half quota) | Yes — JSON mode; structured outputs on select models | Most models 30 RPM / 6K TPM / **1,000 RPD**; Maverick 15 RPM / 500 RPD. No card. | Yes — no non-commercial clause on free tier; limits are the only gate. | **LOW — Groq never trains on customer data; ZDR toggle available.** 30-day abuse/troubleshooting logs only. | Cleanest data story + very fast. Vision = open Llama models in "preview", noticeably weaker than Gemini on dense nameplate photos. Paid Developer tier exists. |
| **Cloudflare Workers AI** | Llama 3.2 11B Vision / Llama 4 Scout, 50+ models | Yes | Yes (JSON mode on supported models) | **10,000 neurons/day free** (roughly low-thousands of small-model calls; vision burns neurons faster). | Yes — normal product free allotment, no non-commercial clause. | **LOW — Cloudflare does not train on inference inputs/outputs; customer content stays private.** | REST API usable from anywhere (not just Workers). Paid overage $0.011/1K neurons. Small open models = mediocre nameplate accuracy. Solid #4 / second-key option. |
| **OpenRouter (:free variants)** | Rotating — DeepSeek, Llama, Gemma, occasional Gemini Flash :free | Some free vision variants (rotating) | Depends on underlying model | 20 RPM; **50 req/day** (<$10 credits) or **1,000 req/day** after a one-time $10 credit purchase. | Yes (OpenRouter itself doesn't restrict) | **VARIABLE/HIGH — :free endpoints route to providers that may log/train; per-endpoint policy. Opt-out of training-providers shrinks the free pool.** | Free models appear/vanish without notice — bad for a reliability fallback. Fine as an experiment sandbox, not as the production fallback for customer data. |
| **GitHub Models** | GPT-4.1/4o, Llama, Phi, etc. via Azure | Yes | Yes | Free tier very low (tens of req/day, small token caps per request). | **No — explicitly "not designed for production"; learning/PoC only.** Paid opt-in unlocks production limits. | Free-tier requests may be filtered/processed by Azure; not for prod data. | Disqualified for this use. |
| **Cohere** | Command A / Aya Vision (trial key) | Yes (Aya Vision) | Yes | Trial: **1,000 calls/month**, 20 RPM chat. | **No — trial keys explicitly not for production/commercial use.** | Trial data may be used for improvement. | Disqualified for free production use. Paid is fine but nothing differentiating here. |
| **Together.ai** | Llama 4, DeepSeek, etc.; some free endpoints | Yes (paid/credit) | Yes | One-time ~$25 intro credits (varies); a few free endpoints with undisclosed dynamic limits. | Yes once paying; free credits are one-time, not a tier. | LOW (no training by default) | One-time credits != sustainable free tier. Skip. |
| **Hugging Face Inference Providers** | Anything on HF | Yes | Varies | Free: ~$0.10/month in credits — effectively nothing. PRO $9/mo = $2 credits. | Yes | Per-provider | Free allotment too small to matter. Skip. |
| **Cerebras** (bonus) | Llama/Qwen text models | **No** | Yes | 1M tokens/day free, 30 RPM, 8K context cap on free. | Dev/testing only — sales contact for production. | LOW | No vision + 8K context cap + non-prod framing = out for this use case. |

---

## Ranked recommendation (for low-volume PDF-text + nameplate-vision fallback)

### 1. Google Gemini API — Flash / Flash-Lite (free tier, dedicated GCP project)
- **Why:** the only candidate that is top-tier at *both* jobs. Best-in-class vision for nameplate photos (stamped/embossed plates, weird angles), native JSON-schema structured output, 1M-token context swallows any test report whole. ~250–1,500 RPD free is 10–50x our fallback volume. Commercial use allowed on free tier. Paid graduation is trivial and nearly free at our volume (Flash-Lite).
- **Quota collision: none.** Gemini free limits are **per Google Cloud project** — create a `servicecycle` project with its own API key and it doesn't touch the sharpedge project's quota, even on the same Google account.
- **The caveat:** free-tier prompts/outputs may be used to improve Google models (human review possible). Mitigation: strip customer name/site identifiers before sending (measurements + schema only — the parser fallback doesn't need them), and plan to flip on billing (Tier 1 = no training, data-processing terms) once a paying customer's data flows through it.

### 2. Mistral La Plateforme — Mistral Small (vision) + Mistral OCR
- **Why:** the **Mistral OCR / Document AI endpoint is purpose-built for exactly this** (document -> structured output), vision models included, JSON schema supported, and the free Experiment plan's ~1B tokens/month is the largest free volume anywhere. 1 RPS is irrelevant at fallback volume.
- **Caveats:** free mode is framed as "evaluation and prototyping" (gray for production); data-improvement consent has historically been the price of the free tier — an opt-out now exists in Settings -> Privacy, **verify it applies to the Experiment plan during signup**. Scale (PAYG) plan is the clean graduation.
- **Collision:** if the sharpedge project doesn't use Mistral, this is a fully separate provider/key — zero quota overlap. Good as the "second, independent" fallback.

### 3. Groq — Llama 3.3 70B (text job) + Llama 4 Scout (vision job)
- **Why:** **cleanest data terms of the bunch** (never trains on customer data, ZDR toggle), 1,000 RPD free, no non-commercial clause, JSON mode, very fast. Ideal for job 1 (text -> JSON) where open models are plenty good.
- **Caveats:** vision = Llama Scout in preview — workable for clean nameplate shots, noticeably behind Gemini on hard ones. If founder already uses Groq for a sister product, free limits are per-account/org — that's a real quota collision; weigh against Mistral for slot #2.

**Honorable mention:** Cloudflare Workers AI — production-allowed free 10K neurons/day, no training on inputs, vision models available via plain REST. Best "third key in the drawer" if one of the above gets throttled.

**Avoid for this use:** GitHub Models and Cohere trial (free tiers explicitly non-production), OpenRouter :free (rotating models + per-provider training risk on customer data), Together/HF (no real sustained free tier), Cerebras (no vision).

### If I had to pick one today
**Gemini Flash-Lite/Flash free tier on a fresh, ServiceCycle-only GCP project — redact customer identifiers in prompts now, flip on Tier 1 billing the moment real customer data volume justifies it.**

---

## Sources (checked 2026-06-12)
- Gemini rate limits (official, per-project tiers): https://ai.google.dev/gemini-api/docs/rate-limits (updated 2026-05-28)
- Gemini pricing / free routes: https://ai.google.dev/gemini-api/docs/pricing
- Gemini Apr-2026 free-tier tightening: https://help.apiyi.com/en/google-gemini-api-free-tier-changes-april-2026-guide-en.html ; https://usagebox.com/articles/gemini-api-billing-free-tier-confusion
- Gemini unpaid-services training terms: https://ai.google.dev/gemini-api/terms ; https://docs.bswen.com/blog/2026-03-23-gemini-free-tier-data-privacy/
- Mistral tiers (official): https://docs.mistral.ai/admin/user-management-finops/tier
- Mistral training opt-out: https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training ; https://docs.mistral.ai/admin/security-access/privacy
- Mistral free-tier limits: https://pricepertoken.com/endpoints/mistral/free ; https://www.grizzlypeaksoftware.com/articles/p/mistral-ai-pricing-in-2026-pro-costs-free-tier-limits-and-api-rates-lx4o2n2v
- Groq rate limits / models (official): https://console.groq.com/docs/rate-limits ; https://console.groq.com/docs/models
- Groq data policy (official): https://console.groq.com/docs/your-data ; https://console.groq.com/docs/legal/services-agreement
- Groq free-tier breakdown: https://tokenmix.ai/blog/groq-free-tier-limits-2026
- Cloudflare Workers AI pricing (official): https://developers.cloudflare.com/workers-ai/platform/pricing/
- Cloudflare data usage (official): https://developers.cloudflare.com/workers-ai/platform/data-usage/
- GitHub Models responsible use / billing (official): https://docs.github.com/en/github-models/responsible-use-of-github-models ; https://docs.github.com/billing/managing-billing-for-your-products/about-billing-for-github-models
- Cohere rate limits / trial keys (official): https://docs.cohere.com/docs/rate-limits
- OpenRouter free-model limits (official): https://openrouter.ai/docs/api/reference/limits ; provider logging: https://openrouter.ai/docs/guides/privacy/provider-logging
- Together rate limits (official): https://docs.together.ai/docs/rate-limits
- HF Inference Providers pricing (official): https://huggingface.co/docs/inference-providers/pricing
- Cerebras rate limits (official): https://inference-docs.cerebras.ai/support/rate-limits
