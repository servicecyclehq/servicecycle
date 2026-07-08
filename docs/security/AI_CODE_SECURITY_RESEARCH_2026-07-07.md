# AI-assisted code security — what's real, what's hype, what to do

**Date:** 2026-07-07 · **Method:** 5 parallel research passes (empirical vuln-rate studies, package hallucination/"slopsquatting", AI-codebase targeting/fingerprinting, stack-specific patterns, concrete mitigations), cross-checked against ServiceCycle's actual code where relevant.

Dustin's question: since ServiceCycle was built almost entirely by directing AI coding agents rather than hand-writing code, is there a *specific* exposure from that origin — patterns attackers know to look for in AI-generated code — and what's actually worth doing about it.

## Bottom line

Two different questions got asked together and they have different answers:

1. **"Is AI-generated code measurably less secure than hand-written code?"** — Yes, and this is now backed by a lot of independent, reproducible research (not just one vendor's marketing). This is real and worth acting on.
2. **"Do attackers specifically fingerprint 'this was built by AI' and target it for that reason?"** — No direct evidence of that as a deployed attacker technique. What's real instead is a subtler version: AI models make *the same mistakes*, so once an attacker finds one exploitable pattern in one AI-generated codebase, it's cheap to scan for that exact pattern across many others. The practical effect is similar (don't ship the common footguns), but the mental model of "they're hunting for the AI smell" isn't quite right — it's "they're hunting for the specific bugs models keep making, and AI-generated code is where those bugs concentrate."

Neither answer means panic. It means: the same handful of concrete patterns are worth checking for, on a real cadence, with real tools — not vibes-based code review.

## 1. How real is this, really

**Well-evidenced (peer-reviewed or large-scale, reproducible):**
- Stanford/ACM CCS 2023 (Perry, Boneh et al.): developers with AI assistant access wrote *measurably less secure* code, especially SQL injection and crypto — and rated their own code *more* confident-secure than the control group did. The inverse correlation between trust-in-AI and actual security was statistically significant.
- Veracode's 2025 GenAI Code Security Report (100+ models, 80+ tasks): 45% of AI-generated samples failed security tests. Newer/bigger models did **not** score better — functional correctness improved, security did not.
- Pearce et al. (IEEE S&P 2022), the original Copilot study: ~40% of generated programs had vulnerabilities from MITRE's Top 25 CWE list.
- Shukla/Joshi/Syed (IEEE-ISTAS 2025): running AI-directed *iteration* on the same code (asking for more features, more fixes) increased critical vulnerabilities 37.6% after just 5 rounds — even when the prompt explicitly said "fix security issues." This is the single most relevant finding for how you actually work — long unsupervised agent-iteration chains are empirically associated with *compounding* risk, not just static risk.
- GitGuardian's 2026 State of Secrets Sprawl report: commits co-authored by Claude Code leaked hardcoded secrets at **roughly double** the general GitHub baseline rate (3.2% vs 1.5%). This is the most concrete, most relevant-to-you data point in the whole research pass.

**Real but with a live disclaimer attached:**
- Apiiro's Fortune-50 telemetry (10x more security findings, 322% more privilege-escalation paths in AI-assisted commits) — real data, but Apiiro sells the detection tool that produced it, so treat the exact multipliers as directional, not audited.
- The Tea dating-app breach (72K images leaked via an open Firebase backend) gets cited constantly as "proof vibe coding causes breaches" — it's a real breach, but the "caused by AI coding" attribution is commentary, not Tea's own confirmed root-cause finding. An exposed Firebase backend is a generic misconfiguration that predates AI tools entirely. Don't repeat this one as if it's proven; it isn't.

**Real, but a different risk than "AI writes bad code" — the tooling itself:**
- Named CVEs in the *coding agents themselves*: CVE-2025-54135/54136 (Cursor), CVE-2025-8217 (Amazon Q supply-chain compromise), the "Rules File Backdoor" (hidden Unicode in `.cursorrules`/Copilot config silently injecting instructions). Mozilla's 2026 research documented indirect prompt injection against Claude Code specifically — a malicious package that fails on first use, then tricks the agent into running a command that fetches and executes attacker code with the developer's full privileges. This is a genuinely new attack surface that doesn't exist for hand-written code, because it depends on an agent autonomously executing things.

**Thin / not demonstrated (the specific idea you asked about):**
- No honeypot study, incident report, or attacker-side tool was found that fingerprints "this repo was AI-generated" as a targeting signal on its own. Academic stylometric detectors exist (67-97% accuracy in lab settings) but they're research/audit tools, not attacker tooling. The one concrete "detection" mechanism that's real and already usable against you is dumb: **Claude Code / Copilot commit co-authorship trailers and bot emails are directly visible in git history** if you ever go public or get breached and someone looks. That's not a sophisticated fingerprinting technique, it's just metadata.

## 2. Patterns specific to your stack — checked against your actual code

I spot-checked several of the research findings against ServiceCycle's code rather than leaving this abstract.

**Already good, no action needed:**
- **CORS** (`server/index.ts:626`) uses an explicit allowlist function, not the naive `cors()`-with-no-args or wildcard-plus-credentials pattern the research flags as the #1 AI-default footgun for Express apps (multiple 2026 writeups specifically call out Cursor/Copilot/Claude Code reproducing this because it's the first result in every Express tutorial). Yours isn't doing that.
- **JWT** (`lib/jwtSecrets.ts`, `lib/ssoIdToken.ts`) explicitly pins `algorithms: ['HS256']` / `ALLOWED_ALGS`. This directly avoids the "algorithm confusion" bug class (attacker sets `alg: none` or flips RS256→HS256) that's a documented real CVE pattern elsewhere (CVE-2026-23993, the LiteLLM incident).
- **Webhook signing** (`lib/webhook.ts`) — you're outbound-only right now (ServiceCycle signs and sends webhooks to partners; nothing currently verifies an *incoming* signature). The classic footgun here — comparing signatures with `===` instead of `crypto.timingSafeEqual` — is a receive-side bug, so it doesn't apply yet. Worth remembering the first time you build an inbound webhook receiver (a payment provider, an IdP callback that isn't already OIDC-library-handled): use `timingSafeEqual`, bind a timestamp into what's signed, and reject stale timestamps.

**Worth a deliberate look (not confirmed broken, just the documented risk class for your exact tools):**
- **Prisma raw queries.** `$queryRawUnsafe`/`$executeRawUnsafe` accept plain string concatenation with zero escaping — Prisma's own docs and community discussions confirm this is a real footgun, and the research flags it as the kind of thing an LLM reaches for when a tagged template can't easily express something (dynamic table/column names, dynamic `ORDER BY`). Worth a one-time `grep -rn "queryRawUnsafe\|executeRawUnsafe" server/` sweep to confirm every usage is either absent or has manually-verified safe inputs (not user-controlled strings).
- **Multi-tenancy/authorization.** No single "AI caused a multi-tenant leak" incident was found, but the pattern-level evidence is strong: LLMs given a prompt without explicit tenant-boundary instructions default to code with no access control at all in lab and real-world testing (Endor Labs, 2025). This is exactly the bug class today's session found twice already this week in a different form — Prisma queries with wrong/missing filters that silently no-op or crash rather than leak data, but the same *root cause* (the model doesn't have an innate model of your tenant boundary unless the schema/prompt encodes it every time). Your existing discipline of "every prisma query filters accountId" is the right mitigation; the risk is a future query someone (you, an agent) writes without that discipline being top of mind.
- **SAML/SCIM.** The general SAML failure mode (separating signature verification from assertion parsing, letting an attacker splice a forged assertion next to a legitimately-signed one) is well-documented (CVE-2025-47949 in a popular SAML library, OWASP's SAML cheat sheet, PortSwigger's "Fragile Lock" research) and is exactly the kind of subtle, whole-document-signature-scoping detail an LLM is likely to get wrong if asked to implement or modify SAML/SCIM validation from scratch. Not a confirmed issue in your code — just flagging it as the area where "looks right, isn't" risk concentrates if this code path ever gets touched again.

## 3. Supply chain: package hallucination ("slopsquatting")

This is the most concrete, most attacker-actionable finding, and it applies to you directly given how much of your dependency tree was likely added by an agent running `npm install`/`pip install` on its own suggestion.

- The definitive study (Spracklen et al., USENIX Security 2025): **~20% of AI-suggested packages don't exist.** Worse, ~43-58% of hallucinated names are the *same* name every time the same prompt is re-run — meaning the fake names are predictable and cheap for an attacker to pre-register once, then wait. A 2026 follow-up found 127 package names that 5 different frontier models (including Claude) all hallucinate identically; 53 of those were still registrable after responsible disclosure.
- Real-world proof the mechanism works (not yet a documented live attack via package name, to be precise about the evidence): a security researcher registered an empty, harmless package under a name LLMs kept hallucinating for `huggingface-cli` — it got 30,000+ downloads in 3 months. Wikipedia's own slopsquatting entry, as of when this was researched, states there's no confirmed case yet of this being used as an actual live attack (as opposed to a proof-of-concept) — so take the more dramatic 2026 blog claims of "already exploited in the wild" with real skepticism; they weren't independently verifiable in this pass.
- Your `server/package.json` currently uses `^`-range versions on all 49 checked dependencies (not exact-pinned). `npm audit`/`pip-audit` **cannot catch this attack class at all** — a squatted hallucinated package has no CVE, it's a "legitimate" new publish. That's a real, structural gap in the tooling you might assume covers this.

**Concrete, free, low-effort mitigations** (all directly actionable, no new paid tools required):
- `npm ci` in deploy/CI, never `npm install` — only exact lockfile versions install.
- `save-exact=true` in `.npmrc` going forward so new adds pin exact versions.
- `ignore-scripts=true` in `.npmrc` — blocks `postinstall` payloads, the most common actual malware execution vector regardless of whether the package name was hallucinated or typosquatted.
- Turn on Dependabot (per earlier session notes, it's currently off on this repo — free, GitHub-native, near-zero setup).
- Whenever an agent suggests installing a new package by name, verify it actually exists with real download history before letting the install through — treat it exactly like a link in a phishing email.

## 4. Concrete mitigations, ranked by effort

**Do this week (free, <1 hour total):**
1. Turn on Dependabot for the repo.
2. Add `save-exact=true` and `ignore-scripts=true` to `server/.npmrc`.
3. Add `npm audit`/`pip-audit` as a CI gate if not already present (catches known-CVE drift, not slopsquatting, but it's free and you don't have it confirmed as automated yet).
4. One-time grep sweep for `queryRawUnsafe`/`executeRawUnsafe` usage — confirm each call site's inputs aren't user-controlled strings.

**Do this month (free-to-cheap, a few hours setup):**
5. Add Semgrep (free/OSS) to CI — `p/owasp-top-ten` + `p/nodejs` + `p/python` rulesets cover both halves of your stack in one GitHub Actions workflow. Independent benchmarks put single-tool SAST coverage well under half of real issues, so this isn't a silver bullet, but it's free and catches a real, distinct slice from what jest/tsc catch.
6. Add CodeQL via GitHub Advanced Security (free for how this repo is likely configured) as a second, differently-tuned scanner alongside Semgrep — the research consistently says no single SAST tool is enough, and these two catch different things.
7. Build a genuinely-separate "security reviewer" Claude subagent with Edit/Write excluded from its tool list (so it can only critique, never fix) — forces an actual second pass instead of the same agent grading its own homework. You already have an `engineering-guidelines` skill; this is a natural sibling. Claude Code also ships a built-in `/security-review` slash command that does something similar out of the box — worth invoking as a standard pre-merge gate on anything auth/tenancy/webhook/secrets-adjacent, the same way tonight's overnight prompt already calls for a security-review pass.

**Ongoing practice, no cost:**
8. Prompting alone is a weak control — one 2026 formal-verification study found explicit "follow security best practices" instructions in the prompt reduced vulnerability rate by only ~4 percentage points. Don't rely on asking nicely; rely on the scanners above plus point 9.
9. Given the iteration-degradation finding (vulnerabilities compound over repeated agent-directed rounds on the same code), the single highest-leverage habit is exactly what today's session already did by instinct: gate every real code-path change behind a concrete, automated check (tsc + jest + the golden-set eval, in today's case) before the next round of changes stacks on top, rather than letting iteration run long without a checkpoint.

## Sources

Full source lists with dates/confidence notes live in each research pass; the load-bearing ones repeated across passes:

- Perry, Srivastava, Kumar, Boneh (Stanford, ACM CCS 2023) — https://arxiv.org/pdf/2211.03622
- Veracode 2025 GenAI Code Security Report — https://www.veracode.com/blog/genai-code-security-report/
- Pearce et al., "Asleep at the Keyboard?" (IEEE S&P 2022)
- Shukla, Joshi, Syed, "Security Degradation in Iterative AI Code Generation" (IEEE-ISTAS 2025) — https://arxiv.org/pdf/2506.11022
- GitGuardian, "The State of Secrets Sprawl 2026" — https://blog.gitguardian.com/the-state-of-secrets-sprawl-2026/
- Apiiro, "4x Velocity, 10x Vulnerabilities" — https://apiiro.com/blog/4x-velocity-10x-vulnerabilities-ai-coding-assistants-are-shipping-more-risks/
- Spracklen et al., "We Have a Package for You!" (USENIX Security 2025) — https://www.usenix.org/publications/loginonline/we-have-package-you-comprehensive-analysis-package-hallucinations-code
- Socket.dev, "The Rise of Slopsquatting" — https://socket.dev/blog/slopsquatting-how-ai-hallucinations-are-fueling-a-new-class-of-supply-chain-attacks
- Endor Labs, "The Most Common Security Vulnerabilities in AI-Generated Code" — https://www.endorlabs.com/learn/the-most-common-security-vulnerabilities-in-ai-generated-code
- Endor Labs, "CVE-2025-47949 Reveals Flaw in samlify" — https://www.endorlabs.com/learn/cve-2025-47949-reveals-flaw-in-samlify-that-opens-door-to-saml-single-sign-on-bypass
- DEV Community, "Why Cursor Keeps Generating Wildcard CORS" — https://dev.to/c_k_fb750e731394/why-cursor-keeps-generating-wildcard-cors-and-how-to-fix-it-3ef
- Georgia Tech, "Bad Vibes: AI-Generated Code Vulnerable, Researchers Warn" — https://news.research.gatech.edu/2026/04/13/bad-vibes-ai-generated-code-vulnerable-researchers-warn
- Mozilla 0DIN prompt-injection research on Claude Code — https://cybernews.com/security/claude-code-attack-prompt-injection-mozilla/
- Semgrep CI docs — https://semgrep.dev/docs/deployment/add-semgrep-to-ci
- Claude Code security docs + subagents — https://code.claude.com/docs/en/security, https://code.claude.com/docs/en/sub-agents
- "Broken by Default" formal-verification study on prompt-based security instructions (2026) — arXiv:2604.05292
