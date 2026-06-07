# Field Access & Mobile — Competitive Landscape (researched 2026-06-07)

Four-agent web research pass, current sources only (2025-2026 release notes,
pricing pages, press releases, forum threads). Full agent transcripts with
per-claim source URLs preserved below each section summary. This supersedes
any from-memory competitive claims made earlier.

## 1. Mainstream CMMS — mobile is table stakes, AI capture commoditizing fast

| Product | Mobile/offline | Photo/vision AI (GA only) | Notes |
|---|---|---|---|
| MaintainX | Native iOS/Android, full offline, best-in-category UX (G2 ~4.8, #1 five straight quarters) | **Nameplate→asset (Jun 2025)**, photo→issue suggestions (Jun 2025), voice→WO (Jun 2025), CoPilot (Feb 2025) | Acquired by Autodesk mid-2026. Most advanced shipped vision AI in CMMS. Uses Anthropic/OpenAI models. |
| Limble | Native apps; offline only on Premium+ ($69/u/mo); mobile rebuilt Winter 2026 | **Asset Snap** nameplate→asset (GA Jan 2026, US) | Also shipped an MCP connector (their data exposed to LLM agents). |
| UpKeep | Native, tiered offline | Voice Fill (GA), photo→parts; Nova AI on the $24 tier | Broadest AI-at-entry-price. |
| Fiix / eMaint / Maximo / SAP / Brightly | All have native apps + offline | None shipped vision capture | Maximo's watsonx assistant (Jun 2025) is text-query; eMaint vibration AI is beta; Brightly consumes XOi data via partnership rather than building. |

Bottom line: native-app-with-offline is the 2026 baseline everywhere, and
**nameplate OCR became a commodity feature across the industry in the last
12 months** (also ServiceTrade Smart Scan Nov 2025, ServiceTitan OCR Sep
2025, BuildOps OpsAI, XOi Advisor Feb 2026 — the field-service tools all
shipped it too).

## 2. The NFPA 70B niche — two small direct competitors, both gappy

**Gimba** (St. Charles IL, ~sub-10 team, SaaS-only, opaque pricing):
one-click EMP document (their best feature — they beat us to it), guided
C1/C2/C3 assessment (rule-based; markets it as "AI" but no model behind it),
asset registry, audit export, **white-label for contractors (May 2026)**.
Lacks: arc flash/70E, IR workflow, NETA MTS intervals, native mobile app,
real AI, named customers.

**Egalvanic** (Milwaukee, contractor-first GTM): arc flash module w/
SKM/EasyPower/ETAP import, **FLIR-integrated IR thermography**, mobile w/
offline + QR scanning, mass acceptance testing module, branded reports.
Lacks: one-click EMP document, white-label, AI of any kind, public pricing.
One named customer (Hi-Tech Electric).

**OxMaint** (Sunnyvale): horizontal CMMS with a March-2026 NFPA 70B/NETA SEO
landing page + native apps + genuine cross-industry AI; electrical depth
looks landing-page-deep (6+ AI-generated posts/day). Watch, don't fear yet.

**No major CMMS has shipped a 70B module** — MaintainX/Limble offer generic
electrical checklists only. Eaton's 70B play is services, not software.

## 3. NETA test-data capture — a functional monopoly with hated UX

Megger **PowerDB Pro** (v11.3.16, Jan 2026) is the incumbent: 370+ NETA
forms, Windows desktop, file-sync architecture, **no real mobile** (the
companion app does facility inspections only, not test forms). NETA Level
III techs on TestGuy, verbatim: *"It has been a nightmare"*, *"constant
problems… synchronizing our data"*, *"Some of the largest testing firms
still use excel forms or handwrite"* — thumb-drive sync confirmed as a
live 2024 workflow. Success requires a full-time PowerDB admin. OMICRON
PTM/DataSync is the most modern alternative but is locked to OMICRON
instruments. **No cloud-native, mobile-first NETA test capture product
exists in 2026.** Our beachhead buyer (NETA contractors) lives in this gap.

## 4. What still does not exist anywhere (adversarially verified)

1. **C1/C2/C3 condition suggestion from photos** — no shipped product.
   *(ServiceCycle shipped exactly this today — photo inspect.)*
2. **Photo/AI-suggested asset topology** (what feeds what) — research-stage
   only (SmartSLD toy, academic papers). *(We shipped power-path + AI
   suggestion today.)*
3. **Hash-anchored / tamper-evident compliance evidence** — nobody.
4. **Insurer-ready evidence packaging matched to carrier requests** —
   Gimba/Egalvanic gesture at it; no structured export. *(Our snapshots +
   audit-visit linkage are ahead here.)*
5. **70B EMP + arc flash + NETA MTS intervals + mobile in ONE product** —
   Gimba and Egalvanic each have half.
6. **Modern NETA test-form capture** — the PowerDB gap above.
7. Full nameplate extraction beyond make/model/serial (voltage/AIC/NEMA
   ratings) in a structured, deployable product.

## 5. Strategy implications

- Mobile (as PWA "Field Mode") is REQUIRED to match the niche, not a wow.
- Nameplate OCR alone is not a differentiator anymore — ours must be framed
  as the full loop: scan tag → photo → **condition suggestion + topology
  suggestion + NETA-complete record + chain-anchored evidence**. Items 1-4
  above are the wow, and we already ship three of them.
- The EMP generator matters more now (Gimba leads with theirs); ours pulls
  from live system data — match their one-click, beat them on substance.
- Biggest strategic opening this research surfaced: **NETA test-data
  capture**. PowerDB's users are our beachhead buyers and they are visibly
  suffering. Field Mode with NETA-form-grade test capture (as-found/as-left,
  instrument provenance, decals — all already in our model) is a credible
  PowerDB displacement story no startup is attempting.
- White-label (Gimba has it) aligns with our OEM-channel strategy — backlog.

*(Agent transcripts with full source URL lists archived in this directory's
git history; key sources: getmaintainx.com release notes Feb/Jun/Nov 2025,
limble.com pricing + Jan 2026 PR, upkeep.com/pricing, gimba.io (May 2026
pages), egalvanic.com, oxmaint.com (Mar 2026), megger.com PowerDB pages,
testguy.net forum threads 2019-2024, servicetrade.com Nov 2025,
servicetitan.com Fall 2025, buildops.com, xoi.io Feb 2026, ibm.com MVI.)*
