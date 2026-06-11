# Brother Conversation Guide
Purpose: Product validation + strategic/acquisition setup
Last updated: 2026-06-08 — revised after sessions covering RUL scoring, modernization engine, arc flash integrity, QEMW, rate card, fleet forecast, leave-behind PDF, and multi-AI exit thesis research.

Prep time: 45 min. This is the most important conversation in the company's history — treat it that way.

---

## How to Frame the Conversation

Don't pitch. Ask. You want him to tell you about his problems so you can show him you've already solved them. The acquisition conversation happens naturally at the end if the product resonates — you don't need to force it. Let him arrive there himself.

Open with: *"I want your brain for an hour. I'm building something in your space and I need a real operator to poke holes in it. What does your day look like — can we do a demo and then I'll grill you with questions?"*

---

## Section 1 — Current Operations (Understand Their World)

These questions establish baseline. Listen for pain, not just answers.

1. Walk me through what happens from the moment a customer calls with a service issue to when the job is closed. Every step.

2. How many service calls / work orders are you handling in a typical month? What percentage are reactive (equipment down) vs. planned maintenance?

3. What does your field tech's day look like? How do they know what jobs they have, how do they document what they find, and how does that get back to the office?

4. When a tech is on site and finds something unexpected — a deficiency, a safety concern — what's the process today? Phone call? Email? Paper form?

5. How do you track what equipment is installed at each customer site? Is there a system, or is that knowledge in people's heads and spreadsheets?

6. When you need to quote a repair or replacement job, how many touchpoints does it take before a quote goes out? What information do you keep having to go back and ask for?

7. When equipment goes down and it's a real emergency — customer is down, no power — what happens in the first 30 minutes on your end?

8. How do you handle natural disasters or regional grid events? Last time a major storm hit a cluster of your customers, how did you manage the response?

---

## Section 2 — Customer Pain Points (Their Customers = Your End Users)

9. What's the #1 complaint you hear from customers about the service experience? Not the equipment — the *service experience*.

10. Do customers ever push back on response time? What's the current SLA expectation and how often do you miss it?

11. How do customers currently know when their equipment is due for service? Do they track that themselves, rely on you to remind them, or just wait for something to break?

12. Have you ever lost a customer or a renewal because a competitor offered better visibility into their equipment health?

13. What would your ideal customer look like? Meaning — what kind of customer gets the most value from having a software layer managing their equipment?

---

## Section 3 — Compliance and Safety (Product Validation)

14. How big a deal is NFPA 70B compliance for your customers? Is it something they're actively managing, or is it a checkbox they ignore until an audit?

15. What about NFPA 70E (electrical safety in the workplace)? How do your customers handle arc flash studies — do they track when the last one was done, or is that buried in a binder somewhere?

16. Do you have customers in healthcare (NFPA 99 requirements)? If so, how do they currently manage their compliance documentation?

17. What compliance failures have you seen cause real problems for customers? Lost certifications, fines, insurance issues, OSHA citations?

18. When a customer has a planned outage — scheduled downtime to do maintenance — how do they currently coordinate which equipment gets serviced in that window? Is there a process, or is it whoever yells loudest?

19. ANSI/NETA EMW-2026 created a new QEMW (Qualified Electrical Equipment Maintenance Worker) certification requirement effective January 2026. How aware is the industry of this? Is anyone actually enforcing it yet or is it theoretical at this point?

---

## Section 4 — Equipment Aging and Modernization (NEW — validate our core assumptions)

These are the most important questions for the next feature sprint. We've built a scoring model and need a real operator to gut-check it.

20. When you look at a piece of equipment that's, say, 25 years old — a switchgear lineup or a transformer — how do you actually decide if it needs to be replaced vs. getting another 10 years out of it? What's the mental model?

21. We've built a Remaining Useful Life score for assets that adjusts based on condition rating, not just age. The idea: a 25-year-old transformer in C1 condition (well-maintained, controlled environment) scores differently than the same age transformer in C3 (missed maintenance, harsh environment). Does that map to how experienced techs actually think about this, or is it more complicated than that?

22. We're using IEEE base life figures as starting points — liquid-filled transformers at 30 years base, MV switchgear at 30 years, LV breakers at 25 years, microprocessor relays at 20 years. Do those feel right in the field, or are you regularly seeing equipment last meaningfully longer or shorter?

23. When a piece of equipment approaches end-of-support — the manufacturer stops making parts for it — how does that conversation with the customer go today? Do they know it's coming, or is it always a surprise?

24. We're building a 3-year CapEx forecast that shows customers their estimated electrical infrastructure spend by year based on equipment age and condition. Something like: "2027: $180k–$340k in recommended upgrades across 4 assets." Would a facilities manager or CFO actually use that for budget planning, or would they dismiss it as too speculative?

25. What are realistic price ranges for the most common service events? We've seeded default estimates (arc flash study $8–15k, switchgear modernization $12–45k, breaker retrofit $3.5–8k, transformer replacement $25–120k). Are those in the right ballpark, or wildly off for your market?

---

## Section 5 — Arc Flash and High-Value Service Events

26. How often are arc flash studies actually current at your customers' facilities? NFPA 70E requires a review every 5 years or when the system changes. In your experience, what percentage of customers are actually compliant with that?

27. When new equipment gets added to a facility — a new panel, a new breaker — does anyone proactively flag that the arc flash study may be invalidated? Or does that just get missed?

28. We built an automatic trigger: when an IMMEDIATE deficiency is logged for a protective relay calibration issue, the system auto-generates an arc flash study quote request. Does that logic hold up — is a relay calibration issue actually a material arc flash risk in practice?

29. What's the most common reason a customer ends up needing an emergency service event that could have been predicted? What's the "if we'd caught this 6 months ago" failure mode you see most?

---

## Section 6 — Field Tech Experience (Validate What We Built)

30. After a tech completes an inspection, what does the customer typically get? A report? A verbal summary? An email? How formal is the leave-behind documentation today?

31. We built a "sales conversion leave-behind" PDF — three sections: what we found, what we fixed, what you should budget for. The third section shows open deficiencies and aging equipment with estimated cost ranges. Would a field tech actually use that, or is it too formal for how field conversations work?

32. When a tech finds a nameplate on equipment and needs to look up specs or log it — manufacture year, model, voltage rating — what's the process today? How much time does that take per piece of equipment on a typical site survey?

---

## Section 7 — Technology and Competition

33. When you're looking at a list of equipment at a customer site, what are the first 3–4 columns you want to see — the ones that tell you at a glance whether something needs attention?

34. What system does your company use to track equipment and maintenance today? What about your biggest customers?

35. Do any of your customers run ETAP or SKM for arc flash studies? If so, do they have full equipment inventories in those tools?

36. What software are your biggest competitors using for field service? Have you seen any of them offer customers a digital portal or asset health dashboard as a differentiator?

37. Have you looked at Gimba? Your company apparently came close to buying them. What did they do well and where did they fall short? What was the number management was willing to pay, and what drove that valuation?

38. Have you heard of PowerDB? It's the incumbent NETA field test data tool. Do your techs use it, hate it, or never touch it?

39. What would the perfect service platform do that nothing on the market does today?

---

## Section 8 — Strategic / Exit (Handle With Care)

*These land naturally at the end once he's seen the product and answered the questions above. Don't force them early.*

40. What would it mean for your company competitively if you owned a platform like this instead of a competitor owning it?

41. We've had multiple independent research sources tell us the most likely acquirers aren't OEMs (Eaton, Schneider) — they're PE-backed electrical contractors like Shermco/Blackstone or Integrated Power Services, or large contractors like EMCOR, Quanta, RESA. Does that match what you see in your market, or does the OEM acquisition path feel more real from the inside?

42. Is there a world where a platform like ServiceCycle becomes something your company offers customers as part of a service contract — "you get the equipment maintenance and the software to manage it"? What would that do for renewal rates?

43. Who at your company would be the person to evaluate something like this? Product, IT, business unit, or does it go to the top?

44. What would need to be true — features, customers, compliance certifications, revenue — for this to be a "we need to own this" conversation at your company?

45. Is there a contractor network or dealer channel attached to your business that would also benefit from a version of this? How many companies in that network?

---

## What to Demo

Show in this order — each one should answer a question he didn't know he had:

1. **Asset inventory with condition tracking** — "Here's what a customer's site looks like the moment they're onboarded."
2. **Field Mode / QR scan** — "Here's what the tech sees on their phone when they walk up to a panel."
3. **Nameplate OCR** — "Point the camera at the nameplate. The record populates itself." (This one gets a reaction every time.)
4. **Deficiency report workflow** — "Tech finds something wrong — this is how it gets documented, tiered by severity, tracked, and closed."
5. **Quote Request + EMERGENCY mode** — "Equipment is down. This is what the customer sees. This is what the rep gets."
6. **Outage Consolidation Planner** — "Planned downtime window — every asset that's overdue, batched automatically."
7. **Fleet Dashboard (OEM view)** — "Here's what your management team sees across every customer account. Risk-ranked."
8. **Compliance report / EMP** — "One click — NFPA 70B program document, audit-ready."
9. **Modernization Forecast** — "Here's what this customer's electrical CapEx looks like over the next 3 years based on asset age and condition." (Tease this — it's coming in the next sprint.)

---

## Assumptions We Built That Need His Gut-Check

These are engineering decisions made without an industry operator in the room. Flag these specifically and get a reaction:

- **C1 condition = 1.0× life, C3 = 0.50× life (cut expected life in half).** Is that too aggressive, not aggressive enough, or about right for badly maintained equipment?
- **Arc flash study expires at 5 years per NFPA 70E.** Is that actually tracked, or is it honored in the breach?
- **Default CapEx estimate ranges (arc flash $8–15k, switchgear modernization $12–45k, etc.).** Right ballpark for your geography and customer size?
- **QEMW certification as a meaningful compliance forcing event.** Is the industry taking this seriously or will it be ignored for years?
- **PE roll-ups and large contractors as the most likely acquirers, not OEMs.** Does that match what he sees?
- **The "leave-behind as sales artifact" concept.** Do field techs have that kind of commercial conversation with customers, or does that happen at a different level?

---

## Listen For

- **Pain signals**: "We still do that on spreadsheets." "That takes 3 days." "Customers always ask us for that and we can't give it to them." → Features that matter.
- **Validation signals**: "We actually have that problem." "Our reps would love that." → Note these exactly, word for word.
- **Acquisition signals**: "Management was willing to pay X for Gimba." "We budgeted for this type of tool." "Our CEO keeps asking why we don't have something like this." → These are your opens.
- **Gap signals**: "What about [X]?" "Can it do [Y]?" → Next sprint.
- **Correction signals**: "That's not how it works in the field." "Nobody cares about that." → Equally valuable. Note these and bring them back.

---

## After the Conversation

Bring the notes back. We'll:
1. Validate or adjust the RUL scoring multipliers based on his gut-check
2. Adjust the default ServiceRateCard values to match real market pricing
3. Reprioritize any feature gaps he surfaces
4. Update the acquisition narrative if exit signals are there
5. Draft the formal pitch if warranted

---

## Section 9 — Test Data, PowerDB Import & Standards (NEW — 2026-06-11)

Added after he corrected the NETA framing and asked us to ingest a real PowerDB/Megger annual report and trend it year-over-year. Goal: lock down the "standard vs optional" test taxonomy, the YoY signals that matter, and how the import should model devices. See `docs/research/2026-06-11-test-data-model-standard-vs-optional-yoy.md`.

**Standards & scope**
46. We're demoting NETA from "the standard" to optional/advanced and making **NFPA 70B Ch. 11–38 + manufacturer recommended maintenance** the primary procedure reference. Does that match how you actually scope a maintenance job?
47. For each equipment type you service most (LV/MV breakers, switchgear, transformers, cables, batteries, relays) — what tests do you consider **standard annual maintenance** vs **optional/advanced** (only on request / troubleshooting / acceptance)? This directly drives what we default-show.
48. Manufacturer recommended maintenance is "very hard to figure out." Where does that knowledge live today — OEM manuals, tribal knowledge, a database? Is there anything we could ingest, or do techs just know it?
49. Cert reality check: should we drop "NETA cert required" entirely and replace it with a "qualified testing company" flag + optional cert tags (NICET / NETA / manufacturer-trained)? Anyone ever actually asked your techs for a cert?
50. Beyond NFPA 70B, which standards do customers genuinely want *tracked* (NFPA 70E/arc flash, NFPA 110 gensets, IEEE 450/1188 batteries, manufacturer)? Which to prioritize vs. keep-but-optional?
51. Confirm we mark **SFRA optional** (or remove). Any other advanced tests currently in the app we should demote the same way?

**PowerDB / data plumbing**
52. Does PowerDB (or the Megger device) export a **data file** — CSV / XML / database — or is the **PDF the only output** we'll realistically get? (This is the single biggest factor in import reliability.)
53. Are oil quality / **DGA** results in the same PowerDB report, or separate lab reports? What format?
54. When you say "device," is each **breaker its own asset**, or is the **substation the asset** and the breakers are just rows under it? How do you want to *see* it in the app?
55. The same Device ID shows up as "B36S01" and "B36SO1" (O vs zero) in one report. How standardized are device IDs across years/techs — can we match on them reliably, or do we need a fuzzy-match/confirm step?

**Year-over-year signals (the actual deliverable)**
56. Do you trend results today at all, or just read this year's pass/fail? If you trend — in what tool?
57. What YoY changes make you *act*? e.g., how much of a **contact-resistance** increase makes you say "remove and clean contacts"? How big an **insulation-resistance** drop worries you? Transformer **power factor** % thresholds?
58. Do you react more to **one phase being off** (imbalance) or to **all three rising together**? Both matter — which triggers faster?
59. Are you recording the variables we'd need to compare years *fairly* — **load %** at thermography, **temperature** at transformer IR/PF? Or is that inconsistent in the field?
60. What would make a YoY trend report genuinely useful to **hand a customer** — per-asset cards, per-site rollup, an exec summary of "deficiencies trending worse"? What's the deliverable that wins the renewal?

**New vs maintenance equipment (positioning)**
61. Should customers be able to catalog **new** equipment too (using its acceptance test as the year-0 baseline), so it rolls into maintenance trending over its life? Or do they only care once it's on a service contract?

---

## Assumptions to gut-check (added 2026-06-11)

- **Standard vs optional split** (see research doc §3) — is our per-equipment-type classification of "standard maintenance" tests right, or did we mislabel anything as standard that's really advanced (or vice-versa)?
- **YoY flag logic** (research doc §4): contact resistance +>20–50% YoY, insulation resistance drop >50%, transformer PF >1.0%. Right ballpark, or what numbers do you actually use?
- **Each switchgear breaker = a child asset** (auto-created on import). Does that match how techs think, or is it too granular?

---

## Section 10 — Test-tool ecosystem (NEW — 2026-06-11)

62. Besides PowerDB, which test-data tools do your techs and your customers actually use — **Doble** (dobleARMS / Test Assistant), **OMICRON** (Primary Test Manager / ADMO), homegrown Excel, anything else? Rough split?
63. For whichever they use: is the output **PDF-only** (like PowerDB) or do any of them **export structured data** (CSV / XML / database)? (Structured export = far easier and more reliable import for us.)
64. If a customer is mid-stream on PowerDB, would they ever switch tools — or is the value in us being the layer that *consumes* whatever tool they already run?
