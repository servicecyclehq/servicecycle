# Competitor & feature-ideation prompt (take this to several AIs)

> How to use: paste everything inside the `=== PROMPT ===` block into 3–4
> different AIs (e.g. ChatGPT, Gemini, Claude, Perplexity/Grok). Turn on each
> tool's "don't train on my data" setting where available. Collect all the
> outputs and bring them back to this chat — I'll dedupe them, vet against
> what's actually live vs. on the roadmap, and judge buildability.
>
> Note: this prompt deliberately does NOT name the product or explain how it
> works. It only feeds a bare "already covered, don't re-propose these" list so
> the ideas come back net-new, with minimal exposure.

=== PROMPT ===

You are a product strategist for B2B vertical SaaS in the electrical
maintenance / compliance space. Be specific, concrete, and skeptical — no
generic "add AI" filler. Tie every idea to real electrical-maintenance
workflows.

CONTEXT
The product category: software built around **NFPA 70B** (the standard requiring
a documented, condition-based electrical maintenance program). It serves two
audiences:
- The **buyer** = an electrical testing / maintenance contractor (the kind of
  firm that performs NETA-style testing and hands customers a report).
- The **customer** = the contractor's facility / industrial clients who own the
  electrical equipment and must stay compliant.

ALREADY COVERED — do not propose these, or anything functionally equivalent.
Assume they exist and are not needed as new ideas:
- Ingesting test reports as PDFs, photos of paper reports, emailed reports, and
  bulk archives — with automatic reading extraction + equipment matching
- Auto-generating a prioritized deficiency / fix list from failed or abnormal
  readings; human review queue for low-confidence extractions
- Equipment records with nameplate capture (incl. photo OCR) and NFPA 70B
  condition ratings (C1/C2/C3) that auto-downgrade after missed cycles
- Per-asset test history and year-over-year trending
- Condition-based maintenance schedules; due/overdue compliance calendar;
  overall compliance score; ranked "path to 100%" action list
- Account-wide deficiency triage by severity
- Site/location hierarchy; contractor technician-credential tracking
- Per-standard evidence packs; generated written 70B maintenance-program
  document; immutable point-in-time compliance snapshots; plain-language
  customer/exec summaries; time-boxed read-only auditor/insurer share links
- Tiered lead-time + overdue alerts; daily digest; Slack/Teams
- Phone field mode: nameplate scanning, QR equipment labels, on-site equipment
  add, declare-emergency
- A "request a quote" demand-capture flow that routes a pre-loaded
  equipment + deficiency dossier to a sales rep; emergency call path

YOUR TASK — produce three sections:

SECTION A — Competitor teardown.
Identify the **two strongest competitors besides Gimba** in this space
(electrical maintenance / NFPA 70B compliance / electrical asset & testing
management software). Name them and justify the picks. Then tear down all THREE
(Gimba + your two) across: target customer, core features, how they get data IN
(manual entry vs. ingest), pricing/positioning if known, biggest strengths, and
biggest weaknesses/gaps. Where you're unsure, say so.

SECTION B — Notable competitor capabilities NOT in the "already covered" list.
List any meaningful features the competitors have that are NOT in the
already-covered list above — i.e., capabilities a product in this category could
be missing. (This is a gap signal; don't restate covered items.)

SECTION C — Feature ideas + out-of-the-box "wow factors" (the main event).
Generate 10–15 ideas, **scoped to NFPA 70B maintenance compliance** (treat
arc-flash/70E, NETA testing methodology, IEEE battery/DGA, etc. as out of scope
— supporting context only). Mix realistic gap-fillers with a few genuinely novel
"wow" bets. Exclude anything functionally equivalent to the already-covered
list. For EACH idea give:
- Name + 1–2 sentence description (concrete, not vague).
- Value lens it serves: **BUYER** (does it generate pipeline / drive customer
  interactions?), **CUSTOMER** (does it save money, help pass audits, keep them
  compliant, keep equipment current and properly documented?), or **BOTH**.
- Why it's a "wow" / what makes it hard to copy.
- Rough build complexity: S / M / L.
- Does any competitor already do it? (yes / partial / no)
Prioritize ideas that do DOUBLE DUTY: pipeline for the buyer AND
money-saved / audit-ready / compliance for the customer.

Finish with: your single highest-conviction "wow" bet, and why you'd build it
first.

=== END PROMPT ===
