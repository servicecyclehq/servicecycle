# Arc-Flash Values — AI Cross-Validation (internal record)

5-model panel run 2026-06-22 against the same items we gave the PE worksheet, checked vs IEEE 1584-2018 + NFPA 70E-2024. Models: Gemini Flash, DeepSeek, ChatGPT, Perplexity, Copilot. NOTE: Copilot self-marked every source UNVERIFIED (it didn't actually verify), so when it's the lone dissenter against the four grounded models, weight it low. This is an internal confidence record — NOT shared with the brother (he's reviewing his own copy); use it to pre-empt where his answers should land.

## LOCKED — 4–5 of 5 agree, treat as verified
- Electrode configs EC1–EC6: VCB / VCBB / HCB / VOA / HOA; **VCBB** is canonical (not VCCB); the 5 are the complete set. (Wording: define as "conductors/**electrodes**.")
- Equipment typicals TY1, TY3–TY6 (gap mm / working distance in): panel 25/18, LV swgr 32/24, cable 13/18, 5kV 104/36, 15kV 152/36 — these match our `ieee1584Defaults`.
- Applicability RA1–RA4: 208 V–15 kV; 500 A–106 kA (208–600 V); 200 A–65 kA (601 V–15 kV); gap test ranges 6.35–76.2 / 19.05–254 mm.
- Device rule DV1, DV3, DV4: fuses no settings; electronic LSI/LSIG + relays require settings (validates the slice-1 rule).
- Fuses FC1–FC7, FC9: L, RK1, RK5, J, T, CC, G current-limiting; H not. FC8 (CF/CUBEFuse) current-limiting (4/5).
- PPE PP1 (two methods, one per label), PP2 (Cat 1=4/2=8/3=25/4=40 cal/cm2), PP3 (arc rating = lower of ATPV/EBT).
- Shock boundaries SB1–SB4: 151–600 V = 3'6"/1'0"; 601–2500 V = 4'0"/2'2"; 2501–15 kV = 5'0"/2'7"; prohibited boundary removed (2021).
- Program TH2 (5-yr review + on change), TH3 (NEC 240.87 @ 1200 A), TH4 (125 kVA exemption removed), TH5 (no 50 HP exemption).
- Enclosure EN1 (508 mm cube normalization); EN2 categories (verify exact breakpoints in the standard text).
- RA5: 2.0 s is the recommended/default max arc duration when nothing clears (clause 6.9.1) — say "recommended max," not "hard cap."

## FLAGS — route to the brother / decide (the short real list)
1. **DANGER/WARNING rule (TH1) — affects shipped code (`labelSeverity`).** 4 of 5 say DANGER vs WARNING is NOT an NFPA 70E requirement — it's an **ANSI Z535.4 / employer-policy** convention, and the "**>600 V → DANGER**" half specifically got pushback (the 40 cal/cm2 line is the real driver). ACTION: keep `labelSeverity` as a useful convention but (a) document the basis as convention not code, and (b) reconsider/soften or make-configurable the >600 V trigger. Brother to confirm how they want it framed.
2. **Class K fuse (FC10) — current-limiting?** Split 3 (CL) vs 2 (NOT CL); the 2 dissenters (Gemini, Copilot) give the same precise reason — K is interchangeable with non-CL Class H and isn't UL-listed as current-limiting. Lean: **K = not officially current-limiting** (K1 has the performance, not the listing). Brother to confirm.
3. **LV MCC gap (TY2) — 25 vs 32 mm.** 4 of 5 + our value = **25 mm**; Copilot alone said 32 (it conflated MCC with switchgear, which IS 32). 25 mm stands, but MCC-vs-switchgear is a known mix-up point — worth a quick brother sanity check.

## WORDING tweaks (value right, phrasing)
- DV2: thermal-mag MCCB = no settings EXCEPT capture adjustable-instantaneous if the model has it.
- PP3: arc rating = lower of ATPV/EBT conceptually; the fabric is lab-assigned one value.
- LB1: 3 core fields confirmed; add "site-specific PPE level" as a valid 4th option; the date = "assessment / label-application date" (a date on the label is best practice; not strictly a 130.5(H) field per several models).

## NET-NEW additions worth capturing (2+ models) — backlog
- **DC shock boundaries** (NFPA 70E Table 130.4(E)(b)) — we're AC-only.
- **MV fuse classes (Class E, R)** for >600 V; **add Class R** to the LV set; keep an `other` escape.
- **Minimum working distance 12 in (305 mm)** — validation floor.
- **Frequency 50/60 Hz** — applicability flag.
- **Enclosure bounds** — max H/W 1244.6 mm (49 in), min width 4× gap, max opening area 1.549 m^2; and store the per-category size-correction factors explicitly.
- **Extra shock voltage bands** — the table also covers <151 V and >15 kV; we only list three bands.

## ACTION ITEMS for the next build session (do NOT do while C–H is live)
- In Slice B follow-up: reframe `labelSeverity` basis (convention, not NFPA) + revisit the >600 V trigger (configurable).
- In Slice C/F enum work: keep Class K but mark current-limiting = pending brother; add Class R (+ MV E/R) to `FuseClass`; keep `other`.
- Add the net-new fields when their slices come up (DC boundaries with shock work; min-WD + frequency + enclosure bounds as validations; extra shock bands).
