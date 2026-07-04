# AI Model Versioning & Rollback

**Version:** 1.0
**Effective date:** 2026-07-04
**Next review:** 2027-01-04
**Owner:** Dustin
**SOC 2 mapping:** CC5.2 (general controls over technology), CC7.1 (vulnerability posture — including AI model behavior changes).

Where `docs/SECURITY_TRUST_PACK.md` documents AI governance policy, this doc
focuses on the **operational discipline** around swapping, pinning, and rolling
back AI models.

**Companions:**
- `docs/security/SECURITY_DECISIONS.md` — where any model swap is recorded.
- `docs/security/ENVIRONMENT_INVENTORY.md` — where model IDs are pinned via env.
- `server/lib/ai.ts` — the cascade + provider selection code.

---

## Why versioning matters for LLM providers

Unlike traditional dependencies, LLM APIs can change behavior even when the
model ID is stable — providers periodically retune, adjust rate limits, alter
tokenizers, or ship new thinking-token behaviors. Two documented SC examples:

- 2026-07-04 nameplate regression — `gemini-2.5-flash` billed thinking tokens
  against `maxOutputTokens`, truncating multi-field JSON. Root cause + fix in
  memory: `servicecycle-nameplate-fix-2026-07-04`.
- 2026-07-03 — `gemini-2.0-flash` was shut down mid-cascade; SC's fallback
  code was updated to handle 404.

Model-version discipline is what makes those incidents recoverable.

## Pin models by ID, not "latest"

Every model reference in `server/lib/ai.ts` and downstream call sites uses a
specific version identifier — never `latest`, never a floating alias.

Current pinned models (as of 2026-07-04; verify against `server/lib/ai.ts`):

| Purpose | Provider | Model ID | Pinned via |
|---|---|---|---|
| Free-tier nameplate OCR | Google Gemini | `gemini-2.5-flash` | Code constant + admin AI-caps whitelist |
| Free-tier LLM fallback | Groq | `<model id>` | Code constant |
| Paid-tier default suggestion | Anthropic Claude | `claude-<version>` | Customer's own key + code default |
| Paid-tier fallback | OpenAI | `gpt-<version>` | Customer's own key + code default |

## When a model swap happens

Every model swap goes through this procedure:

1. **Reason for swap.** Log the reason in `SECURITY_DECISIONS.md` with today's date and the specific problem (deprecation, quality drop, cost, feature availability, availability incident).
2. **Contract check.** Confirm the new model matches on: tokenizer, output format, thinking-token accounting, image support if applicable. Delta drives test coverage below.
3. **Feature-flag rollout.** Introduce the new model as an opt-in via env var:
   ```
   AI_NAMEPLATE_MODEL=gemini-2.5-flash            # current
   AI_NAMEPLATE_MODEL_CANARY=gemini-3.0-flash     # canary
   ```
   Route a small percentage (or specific test accounts) to the canary via an admin flag.
4. **Regression-lock tests.** For every user-facing AI path (nameplate scan, test-report vision, arc-flash device, arc-flash one-line, photo-inspect), the regression tests must run against a golden set of images/prompts with the new model and pass at ≥ the previous model's success rate.
   - See `server/__tests__/nameplateOcrContract.test.ts` for the regression-lock pattern.
5. **Live spot-check.** Run one live production request per user-facing path against the new model; verify the audit chain records the correct provider + model + tokens.
6. **Promote.** Once canary sits stable for 48h, swap the pinned constant in code, remove the canary env var, and rebuild.
7. **Document.** Update this file's table above and `ENVIRONMENT_INVENTORY.md`.

## Rollback

If a swap misbehaves in production:

1. **Detect** — the fastest signal is a spike in AI-related activity chain events with high `errorCount`, an anomaly in the monthly metrics, or a customer report.
2. **Revert the code constant** to the previous pinned model ID (git revert the swap commit; deploy).
3. **Bump `tokenEpoch`** — only if the misbehavior involved auth or MFA-related model output (unlikely for OCR; likely for a customer-facing chat feature).
4. **Communicate** — if any customer had a failed request that they saw as a bug, use the `INCIDENT_RESPONSE.md` P2 comms template.
5. **Log** — write an incident record in `docs/compliance/incidents/`. Note the failure mode + evidence + rollback timing.

Because model IDs are pinned in code, "rollback" = "revert the commit that changed the constant" — this is fast and reversible.

## Deprecation handling

When a provider announces a model deprecation:

1. Note the deprecation date in this file with owner + deadline.
2. Choose the replacement model + run the swap procedure above, targeting completion at least 30 days before the deprecation date.
3. Verify the fallback cascade still works if the deprecated model is the primary for a path.
4. Delete the old model from any code default once past the deprecation date.

## Metadata logged per AI call

The activity chain event `api_v1_call` (and per-feature equivalents) records:

- Provider (gemini | groq | anthropic | openai | customer BYO).
- Model ID (pinned).
- Prompt purpose (nameplate_scan | test_report | arc_flash_device | ...).
- Token counts (input, output, thinking).
- Cost cents (SC-owned keys) or "byo" (customer keys).
- Success / error class.

This log is the raw material for:
- Monthly metrics rollup.
- Vendor review at quarter close (has any provider silently changed behavior?).
- Incident forensics (what model was running when this bug happened?).

## When NOT to swap

- Don't swap in response to a single anomaly; investigate first.
- Don't swap during a customer-facing incident recovery; stabilize first.
- Don't swap during a SOC 2 audit window without explicit evidence discipline (the swap must land AFTER the audit's cut-off date or be included as an in-scope change).

## Cross-references

- `docs/SECURITY_TRUST_PACK.md` — AI governance policy.
- `docs/security/SECURITY_DECISIONS.md` — where swap decisions are logged.
- `server/lib/ai.ts` — the cascade + pinned constants.
- Memory: `servicecycle-nameplate-fix-2026-07-04` (thinking-token truncation postmortem).
