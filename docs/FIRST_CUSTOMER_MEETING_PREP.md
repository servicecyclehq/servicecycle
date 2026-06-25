# First Contractor Meeting — Internal Prep

**Audience:** Internal — not for the customer  
**Format:** In-person or video call, ~60 minutes  

---

## Before the meeting

- [ ] Log into servicecycle.app and confirm demo environment is healthy (Fleet Dashboard loads, at least one site with equipment records and a deficiency)
- [ ] Have the CONTRACTOR_PITCH_ONE_PAGER.md printed or ready to share screen
- [ ] Know the answer to: "How long does ingesting a PowerDB report take?" (answer: 1–3 minutes per report, reviewed before confirmed)
- [ ] Review the Gimba question below — this is the most important intel you'll collect

---

## Meeting structure (suggested 60 min)

### Open (5 min)
Don't pitch yet. Ask: "Walk me through how a typical test visit ends — what does the paperwork look like after you leave the site?" Let them describe the pain before you name it.

### Their current workflow (10 min)
Questions to ask:
- What format are your test reports in? (PowerDB, Megger, Word, paper?)
- Where do those reports go after delivery? (email to customer, binder, shared drive?)
- How do you track open deficiencies between visits?
- Do customers ever call you back about deficiencies you found — or do they wait until the next visit?
- How do you manage the maintenance schedule across accounts? Spreadsheet, memory, something else?

Listen for: manual effort, things falling through the cracks, customer complaints about not knowing what's due, lost quote opportunities.

### The Gimba question (5 min)
If they mention evaluating or having seen other tools, ask: "What happened with that — what didn't fit?" If they don't bring it up, ask directly: "Have you looked at any other platforms for this?"

The Gimba angle specifically: they almost bought Gimba (a compliance/maintenance tracking tool). Understanding why they didn't close reveals: the price point they expect, the gap that tool had, and what it would take to get them across the line. Don't mention Gimba by name unless they do — just ask "what fell through" and listen.

### Demo (20 min)
Follow DEMO_SCRIPT.md. Priority order:
1. Fleet Dashboard (the "what do I have across all my accounts" view)
2. Upload a test report → show extraction → review screen
3. Deficiency list → link to quote request
4. Leave-behind generation

Skip arc-flash details unless they ask — it's impressive but can eat the clock.

### The pilot ask (10 min)
"Here's what I'd propose: we pick two or three of your sites, ingest the last visit's reports, and you tell us within two weeks whether the data came out right. No commitment beyond that."

Hand them PILOT_KICKOFF_GUIDE.md or CONTRACTOR_PITCH_ONE_PAGER.md.

Questions to ask before closing:
- "Who else needs to be involved in a decision like this?" (map the org)
- "If this works the way I'm describing, what would need to be true for you to use it across your accounts?" (surfaces the real blocker)
- "What's your next outage window?" (creates a natural urgency anchor — if they have a visit in 3 weeks, we can ingest that customer's reports before the visit)

### Close (10 min)
If positive: propose a specific next step — not "let's talk again" but "I'll send you the SOW today, you sign it by end of week, I'll have your account ready Monday."

If uncertain: ask what would make them confident enough to try it. Then solve that specific thing.

---

## What to listen for

- **The real workflow:** How many people touch a report after it's written? Who decides what gets quoted?
- **The customer relationship dynamic:** Do customers call them, or do they wait to be called? (Passive customers = more lost revenue = bigger ROI case)
- **The scale signal:** How many accounts? How many site visits per year? This tells you the ARR potential.
- **The Gimba gap:** What feature was missing, or what was the price? This is the most useful competitive intel available.
- **The decision-maker question:** Is the person in the room the one who signs? If not, who is?

---

## After the meeting

- Send the SOW (docs/PILOT_SOW_TEMPLATE.md) within 24 hours regardless of outcome
- Log: accounts count, report format used, Gimba intel, who the decision-maker is, what the real blocker is
- If they said yes: create account, send invite, follow PILOT_KICKOFF_GUIDE.md
- If they said maybe: send one follow-up with the specific thing they asked about resolved — not a generic "checking in"
- If they said no: ask "is there a version of this that would have been a yes?" One question, then let it go

---

## What NOT to do

- Don't lead with the technology — lead with their workflow
- Don't demo arc-flash first (it's impressive but confusing without context)
- Don't leave without a specific next step and a date
- Don't say "we're building toward X" — everything they need for a pilot is live today
