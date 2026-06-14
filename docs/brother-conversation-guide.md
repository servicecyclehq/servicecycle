# Brother Conversation Guide
Purpose: Product validation + strategic/acquisition setup
Last updated: 2026-06-11 — refreshed after the post-v2 build wave (geometry-based PDF test-report parser live, evidence-grade baselining, one honest compliance number, closed outage loop, trend advisories, "Inspector's here" button, fix-it-list-first dashboard, single Add-data door). Questions the build already answered are archived at the bottom with reasons.

He answers in short, casual, mobile bursts with limited time. One question per message. No preamble, no corporate phrasing. The top section is the whole game if time is short — everything else is gravy.

---

## How to Frame It

Don't pitch. Ask. You want him telling you about his world so the product can answer questions he didn't know he had. The acquisition conversation happens naturally at the end if it resonates — don't force it.

Open with: *"The app reads test reports now. I need two things from you: real PDFs to break it with, and ten minutes of straight answers."*

---

## ⭐ TOP PRIORITY — if you only get 10 minutes, ask these (in order)

Context for why: the PDF parser is live but it's only been tuned on reports **we wrote ourselves**. Multi-asset segmentation, OCR, and field-photo onboarding are all queued behind facts only he has. Q1 is an *ask*, not a question — it unblocks the #1 roadmap item.

**1. "Can you get me 5–10 real test reports — PowerDB, Megger, whatever actually leaves your shop? Black out customer names, I don't care. The app reads these now, but I've only tested it on samples we made ourselves. I need real ones to break it."**
→ The golden corpus. Single most valuable thing he can hand over. If he agrees, nail down the *how* (email? Drive folder?) before the call ends.

**1b. "Does your shop have licensed copies of the standards? If so, I need the actual PDFs/docs for four specific ones — the app estimates compliance against these and I want to calibrate it to the real tables instead of summaries."**
→ This unblocks getting the compliance math from "estimate" to "correct." We default to whatever he can send (PDF/doc); do NOT make him fill out a sheet. The four we need, in priority order:
  1. **NETA MTS-2023 — Appendix B** (the maintenance-test frequency matrix). Drives ~30 of our equipment-test intervals that are currently best-effort encodings.
  2. **IEEE C57.104-2019** — the DGA interpretation tables (status limits, the 90th/95th-percentile values, the O₂/N₂-ratio split, rate-of-change tables). *Easier alternative:* a couple of his oil lab's actual DGA reports (SDMyers/Doble usually print the exact thresholds they score against).
  3. **NFPA 70B-2023 — Table 9.2.2** (the condition-of-maintenance interval columns) — to verify our per-equipment C1/C2/C3 month values, incl. the grounding row we're holding.
  4. **NFPA 110-2022 — §8.4** testing intervals (confirms the load-bank profile fix).
→ Full provenance/error list is in docs/research/2026-06-14-standards-accuracy-review.md. With these in hand we do a second correction pass; without them, the DGA-2019 rebuild + the ~30 NETA App-B intervals stay flagged "estimate."

**2. "When PowerDB finishes a job, can you export the actual data — CSV, XML, the database file — or is the PDF the only thing that ever leaves the building?"**
→ Decides whether we keep hardening PDF extraction or build a structured-import side door that's 10× more reliable. (Same question for Doble/OMICRON if he mentions them.)

**3. "A typical annual report — is it one big PDF covering the whole facility, dozens of breakers and transformers in sections? Or separate reports per device? Roughly how many assets in one document?"**
→ Directly prices the multi-asset segmentation build (the biggest remaining data-in friction). If the real artifact is 200 pages / 60 assets, segmentation jumps the queue.

**4. "How many of those reports does your shop put out in a month — and on the customer side, who actually opens them? Anybody?"**
→ Validates the ingest moat (volume = funnel) AND the core thesis that nobody reads these reports. If customers actually read them, the pitch changes.

**5. "Picture this: you drag your own report into an app and it auto-builds the customer's equipment list, schedules, and compliance program. Would your company actually use that to onboard service customers? Would they pay for it, or bundle it into contracts?"**
→ The contractor-channel thesis in one question. His answer shapes who we sell to and the whole acquisition narrative.

**6. "Honest one: if the app asks your techs 'when was this last actually serviced?' — do they answer for real, or just click whatever makes the screen go green?"**
→ We just rebuilt baselining so green requires an asserted date, never a button-click. If techs lie anyway, evidence-grade compliance needs a different enforcement angle (manager sign-off? photo proof?).

**7. "If a customer's dashboard said 'do these 6 things and you're at 100% NFPA 70B' — does that land? Do facilities guys even want a 100% score, or do they not care until insurance or OSHA shows up?"**
→ Gut-checks the path-to-100% framing that now headlines the product. Also probes *when* compliance becomes urgent (renewal? audit? incident?).

---

## TIER 2 — gut-checks on what we shipped + open decisions (next 15 minutes)

**Shipped features that need a field reality check:**

8. "Our outage plan defaults to 'test everything that loses power, not just what's due' — you told us you'd test all of them for sure. Real-world check: does the customer actually *pay* for the extra ones, or does that get value-engineered out of the quote?"

9. "If a breaker's well-maintained (C1) we stretch its maintenance interval up to 2.5× the book number; if it's rough (C3) we cut it to a quarter. Would you really run a C1 breaker 7+ years between services, or is 2.5× nuts?"

10. "We now flag stuff that's still in-spec but trending the wrong way year-over-year — like C-phase contact resistance up 30% — as advisories. What numbers make YOU act? +20%? +50%? And does one phase drifting off scare you faster than all three rising together?"

11. "Of the reports floating around your world — yours and other contractors' — what share are clean digital PDFs vs. scans of printed pages?" → decides whether OCR is urgent or a someday.

12. "If a tech walking a new site could snap a photo of each nameplate and the app builds the asset + schedule on the spot — would your guys actually do that on a walkthrough, or is data entry office work no matter what?"

13. "Would standard LOTO procedure templates per equipment type be useful, or is LOTO always so site-specific that canned templates are noise?"

14. "Same breaker shows up as B36S01 and B36SO1 across years. How messy are device IDs really — can we trust serials to match year-over-year, or do we need an 'is this the same device?' confirm step?"

15. "Do your techs reliably record load % and temperature when they test — so year-over-year comparisons are apples-to-apples — or is that hit-or-miss in the field?"

**Open product decisions (I1–I3 — quick gut answers are fine):**

16. (I1) "Would an in-app 'ask the AI' help chat actually get used by your people or your customers, or is that gimmick?"

17. (I2) "We could grade contractors inside the tool — response time, quality, findings. Useful for the facility, or political suicide the day a contractor sees his grade?"

18. (I3) "We ship 6 equipment templates today. Rattle off the top equipment types your shop actually tests — what are we missing?"

---

## TIER 3 — the bigger conversation (only if there's real time, or split across follow-ups)

**Test taxonomy & standards (drives our defaults):**
19. For each equipment type you service most (LV/MV breakers, switchgear, transformers, cables, batteries, relays) — what's **standard annual maintenance** vs. **optional/advanced** (acceptance/troubleshooting only)?
20. Manufacturer recommended maintenance is "very hard to figure out" — where does that knowledge live? Anything we could ingest, or pure tribal knowledge?
21. Should we drop "NETA cert required" for a "qualified testing company" flag + optional cert tags? Has anyone ever actually asked your techs for a cert?
22. Beyond NFPA 70B, which standards do customers genuinely want *tracked* (70E/arc flash, NFPA 110 gensets, IEEE 450/1188 batteries)? Quick-fire: SFRA stays optional, right — anything else we should demote?
23. Should customers catalog **new** equipment too (acceptance test = year-0 baseline), or do they only care once it's on a service contract?
24. What YoY trend deliverable wins the renewal — per-asset cards, site rollup, exec "trending worse" summary?

**Test-tool ecosystem:**
25. Besides PowerDB — Doble, OMICRON, homegrown Excel? Rough split across your shop and customers?
26. Would anyone mid-stream on PowerDB ever *switch* tools — or is the play being the layer that consumes whatever they already run? (We're betting on consume.)

**Aging / RUL / money (next sprint's gut-checks):**
27. A 25-year-old switchgear lineup — how do you actually decide replace vs. another 10 years? What's the mental model?
28. IEEE base lives we use: liquid transformers 30y, MV switchgear 30y, LV breakers 25y, relays 20y. Field-real, or regularly off?
29. Would a facilities manager or CFO actually budget from a 3-year CapEx forecast ("2027: $180k–$340k across 4 assets")? And price-check: arc flash study $8–15k, switchgear modernization $12–45k, breaker retrofit $3.5–8k, transformer replacement $25–120k — right ballpark?

**Arc flash:**
30. What % of your customers actually have a current (≤5y) arc flash study? Is the 5-year clock tracked anywhere, or honored in the breach?
31. We auto-trigger an arc-flash-study quote when an IMMEDIATE relay-calibration deficiency is logged. Does that logic hold up in practice?

**Field & commercial:**
32. We built a leave-behind PDF — found / fixed / budget-for, with cost ranges. Would a field tech actually hand that over, or does the commercial conversation happen at a different level?
33. What's the #1 complaint customers have about the *service experience*? Ever lost a renewal because a competitor offered better equipment-health visibility?
34. What does your company use to track equipment/maintenance today? Your biggest customers? Anyone offering customer portals as a differentiator?
35. Gimba — your company almost bought them. What did they do well, where did they fall short, and what number was management willing to pay?
36. QEMW (ANSI/NETA EMW-2026, effective Jan 2026) — is anyone enforcing it yet, or theoretical?
37. What would the perfect service platform do that nothing on the market does?

**Strategic / exit (let these land naturally at the end):**
38. Is there a world where ServiceCycle becomes something your company *bundles into service contracts* — "you get the maintenance and the software"? What would that do to renewal rates?
39. Research keeps pointing at PE-backed contractors (Shermco/Blackstone, IPS, EMCOR, Quanta, RESA) as the real acquirers, not OEMs. Match what you see from the inside?
40. Who at your company would evaluate something like this, and what would need to be true — features, customers, revenue — for it to be a "we need to own this" conversation?

---

## What to Demo (refreshed order — every stop now ends in an action list)

1. **Dashboard** — one honest compliance number + the ranked fix-it list. "Here's everything wrong, in order."
2. **Add data → drop a test report PDF** — extraction preview with per-field confidence → measurements → auto-deficiencies → "view your fix-it list." **Best live moment: get a real report from him during the call and feed it in raw.** (Note: demo runs deterministic parsing, AI off — that's a feature, say so.)
3. **Date-first Outage Planner** — "your outage is July 18" → grouped plan with reasons (due / carry-over / while-de-energized) → commit → complete → **watch compliance visibly rise** (the loop closes now).
4. **"Inspector's here" button** — one click: EMP PDF + tamper-evident snapshot.
5. **Path to 100%** — "do these 6 things → 100%," each with points recovered and a one-click action.
6. **Field Mode / QR scan** — what the tech sees at the panel.
7. **Quote Request + EMERGENCY mode** — equipment down, what the customer sees, what the rep gets.
8. **Fleet Dashboard** — the contractor's management view, risk-ranked across accounts.
9. **Modernization Forecast** — tease the 3-year CapEx view.

---

## Listen For

- **Pain signals**: "We still do that on spreadsheets." "That takes 3 days." → Features that matter.
- **Validation signals**: "We actually have that problem." "Our reps would love that." → Note word-for-word.
- **Acquisition signals**: "Management was willing to pay X for Gimba." "Our CEO keeps asking why we don't have this." → Your opens.
- **Correction signals**: "That's not how it works in the field." "Nobody cares about that." → Equally valuable — these killed bad assumptions before (NETA framing).
- **The report handoff**: if he commits to sending real PDFs, lock the logistics on the spot. That commitment is worth more than any answer.

---

## After the Conversation

1. Land the golden corpus (real PDFs) → parser fixture tests → tune extraction (V4 stage 1).
2. Decide multi-asset segmentation priority from Q3/Q4 answers.
3. Adjust trend thresholds, interval multipliers, and rate-card values from his numbers.
4. Settle I1–I3.
5. Update the contractor-channel / acquisition narrative from Q5 + Tier 3 strategic answers.

---

---

## ARCHIVE — removed 2026-06-11 (post-build-wave vetting)

Removed because the build answered them, he already answered them, or a sharper question replaced them. Kept for the record.

**Answered by the as-built product:**
- *Old Q18 — "When a customer has a planned outage, how do they coordinate which equipment gets serviced?"* → Answered by the shipped date-first Outage Planner (date + scope → grouped plan → one-click WOs, loop closed on completion) and by his own earlier "we'd test all of them for sure." Replaced by the sharper Tier-2 who-pays question (#8).
- *Old Q46 — "Demote NETA to optional, NFPA 70B + manufacturer primary?"* → He already corrected the framing in a prior session; the build shipped it. Done.
- *Old Q54 — "Is each breaker its own asset or rows under the substation?"* → Answered by the as-built Location→Panel/Equipment→Device grouping with child assets. Revisit only if he objects during the demo.
- *Old Q56 — "Do you trend results today, and in what tool?"* → Superseded: YoY trending + wrong-direction advisories shipped. Replaced by the threshold-numbers gut-check (#10).
- *Old assumption bullet "auto-created child assets on import"* → shipped; folded into the demo.

**Superseded by a sharper question:**
- *Old Q32 — "How long does nameplate lookup/logging take per piece of equipment?"* → Superseded by the field photo→asset adoption question (#12), which is the actual build decision.
- *Old Q52/Q63 — PowerDB / other tools structured export* → Not removed — **promoted** to Top Priority #2 (merged into one question).
- *Old Q57/Q58 — YoY thresholds + phase imbalance* → merged into Tier-2 #10.
- *Old Q21/Q23 — RUL condition mapping; end-of-support conversations* → folded into Tier-3 #27 (same mental-model question).
- *Old Q27/Q29 — arc flash invalidation on new equipment; predictable emergencies* → folded into Tier-3 #30–31.
- *Old Q30 — what does the customer get after an inspection* → folded into leave-behind question (#32).
- *Old Q40/Q45 — competitive ownership; contractor network size* → folded into Tier-3 #38–40.

**General discovery, deprioritized for his time budget (built features cover the workflow they probed):**
- *Old Q1, Q3, Q4 — call-to-close walkthrough; field tech's day; unexpected-finding process* → the deficiency/WO/field-mode flows are built; the demo will surface corrections faster than open-ended discovery.
- *Old Q5 — how is installed equipment tracked* → covered by Tier-3 #34.
- *Old Q6 — quote touchpoints* → Quote Request (5 questions + EMERGENCY) shipped; demo it instead.
- *Old Q7/Q8 — emergency first-30-minutes; storm response* → EMERGENCY mode + disaster banner shipped; demo stop #7.
- *Old Q2 — monthly WO volume* → replaced by the higher-leverage report-volume question (Top #4).
- *Old Q10/Q11/Q13 — SLA pushback; how customers know service is due; ideal customer* → the product thesis answers Q11; Q10/Q13 only matter post-validation. Cut for time.
- *Old Q14–Q17 — how big a deal is 70B/70E/NFPA 99; compliance failures seen* → partially validated by prior sessions + market research (insurer enforcement); the path-to-100 framing question (Top #7) extracts the same signal faster.
- *Old Q33 — first 3–4 columns in an equipment list* → answered in the 2026-06-11 IA/card/column review; UI shipped.
- *Old Q38 — "Have you heard of PowerDB?"* → answered in a prior session (he asked us to ingest a PowerDB report); superseded by Top #1–#3.
