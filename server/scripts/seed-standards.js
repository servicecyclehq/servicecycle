'use strict';

/**
 * scripts/seed-standards.js
 * -------------------------
 * Seeds the GLOBAL compliance library: ComplianceStandard rows and the
 * MaintenanceTaskDefinition interval matrix (accountId = NULL rows shared by
 * every tenant). Runs idempotently — upsert-by-natural-key — so it is safe
 * to call on every deploy and from the demo seed.
 *
 *   node server/scripts/seed-standards.js          — CLI
 *   const { seedStandards } = require(...);        — programmatic
 *
 * ── PROVENANCE / REVIEW NOTE (read before trusting the numbers) ─────────────
 * Intervals encode the NFPA 70B:2023 condition-of-maintenance model:
 *   C1 (good)  — extended interval, ceiling 60 months
 *   C2 (fair)  — base interval (NETA MTS-2023 Appendix B published values)
 *   C3 (poor)  — compressed interval, ceiling 12 months
 * Where an explicit C1/C3 column is set below it reflects the published
 * table value or the standard's own mandate (e.g. NFPA 110 monthly generator
 * exercise does NOT stretch for a C1 unit — the standard mandates monthly
 * regardless of condition). Where C1/C3 are null, lib/maintenanceInterval.ts
 * derives them via the 2.5× / 0.25× multipliers with the 60/12-month
 * ceilings.
 *
 * These values were encoded from the standards summaries in KICKOFF.md by a
 * non-EE and MUST be reviewed against the actual NFPA 70B:2023 / NETA
 * MTS-2023 / NFPA 110:2022 text by a NETA-certified engineer before any
 * production customer relies on them. Every row carries standardRef so the
 * review can be done line-by-line.
 *
 * SECOND WAVE (2026-06-07) — the matrix now covers the Tier 2/3 equipment
 * types (ATS, switchboards/panelboards, busway, breakers, motors, MCCs, dry
 * transformers, UPS/battery systems, relays, GFP, disconnects, arresters,
 * cables, tray, grounding, emergency lighting, VFDs, fire pump controllers,
 * fuse gear). Provenance rules for this wave:
 *   - Intervals verified by the 2026-06-07 research passes
 *     (docs/research/2026-06-07-nfpa99-healthcare-module.md and
 *     docs/research/2026-06-07-insurance-audit-records.md) cite the section
 *     exactly as those docs do.
 *   - Intervals encoding NETA MTS-2023 Appendix B / industry common practice
 *     WITHOUT a doc-verified citation carry ' [ENCODED FROM PRACTICE —
 *     VERIFY]' inside the description and use a conservative base interval.
 *     The same NETA-certified-engineer review requirement applies to every
 *     row in this wave before production reliance.
 *   - Mandate-fixed intervals (NFPA 101 §7.9.3 lighting tests, NFPA 110
 *     monthly transfer / 36-month EPSS tests, NFPA 25 §8.3 fire pump runs)
 *     keep C1 == C2 — condition NEVER stretches a code mandate. C3 may
 *     still compress.
 *   - WEEKLY cadences (NFPA 110 §8.4.1 generator/ATS weekly inspections,
 *     NFPA 25 diesel fire pump weekly runs) are NOT seedable yet: intervals
 *     are month-granular (minimum 1). They land with the healthcare-module
 *     day-granular interval work (gap G1 in the NFPA 99 research doc).
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');

// ── Governing standards (KICKOFF table) ──────────────────────────────────────
const STANDARDS = [
  { code: 'NFPA 70B',       edition: '2023', publisher: 'NFPA', title: 'Standard for Electrical Equipment Maintenance',                 keyMandate: 'Mandatory EMP, condition-based intervals, annual IR thermography', revisionCycle: '3-5yr' },
  { code: 'NFPA 70E',       edition: '2024', publisher: 'NFPA', title: 'Standard for Electrical Safety in the Workplace',               keyMandate: 'Arc flash study 5yr max, PPE requirements, LOTO',                  revisionCycle: '3yr' },
  { code: 'NFPA 110',       edition: '2022', publisher: 'NFPA', title: 'Standard for Emergency and Standby Power Systems',              keyMandate: 'Generator monthly exercise, annual load bank, 3yr full test',      revisionCycle: '3yr' },
  { code: 'NETA MTS',       edition: '2023', publisher: 'NETA', title: 'Standard for Maintenance Testing Specifications',               keyMandate: 'Per-equipment test intervals (Appendix B matrix)',                 revisionCycle: '~4yr' },
  { code: 'NETA ATS',       edition: '2025', publisher: 'NETA', title: 'Standard for Acceptance Testing Specifications',                keyMandate: 'Acceptance testing on new installations',                          revisionCycle: '~4yr' },
  { code: 'IEEE C57.104',   edition: '2019', publisher: 'IEEE', title: 'Guide for the Interpretation of Gases Generated in Mineral Oil-Immersed Transformers', keyMandate: 'DGA interpretation for liquid-filled transformers', revisionCycle: 'irregular' },
  { code: 'IEEE 43',        edition: '2013', publisher: 'IEEE', title: 'Recommended Practice for Testing Insulation Resistance of Electric Machinery',         keyMandate: 'Insulation resistance for motors/generators',       revisionCycle: 'irregular' },
  { code: 'OSHA 1910-S',    edition: 'current', publisher: 'OSHA', title: '29 CFR 1910 Subpart S — Electrical',                          keyMandate: 'Fines $16,550/violation (serious), $165,514 (willful)',            revisionCycle: 'ongoing' },
  // ── Second wave (2026-06-07) ───────────────────────────────────────────────
  // NFPA 101 edition: '2012' deliberately — CMS enforces the 2012 Life Safety
  // Code (healthcare research doc, "edition trap"); current NFPA edition is
  // 2024. Multi-edition binding lands with the healthcare module.
  { code: 'NFPA 101',       edition: '2012', publisher: 'NFPA', title: 'Life Safety Code',                                               keyMandate: 'Emergency lighting: monthly 30-sec functional + annual 90-min discharge (§7.9.3)', revisionCycle: '3yr' },
  // NFPA 25: monthly electric fire-pump no-flow cadence dates from the 2017
  // edition (was weekly before); 2023 is the current edition.
  { code: 'NFPA 25',        edition: '2023', publisher: 'NFPA', title: 'Standard for the Inspection, Testing, and Maintenance of Water-Based Fire Protection Systems', keyMandate: 'Fire pump: monthly electric no-flow run, weekly diesel, annual flow test (§8.3)', revisionCycle: '3yr' },
  { code: 'IEEE 450',       edition: '2010', publisher: 'IEEE', title: 'Recommended Practice for Maintenance, Testing, and Replacement of Vented Lead-Acid Batteries for Stationary Applications', keyMandate: 'Quarterly per-cell float V/ohmic readings; annual capacity test (pass ≥80% rated)', revisionCycle: 'irregular' },
  { code: 'IEEE 1188',      edition: '2005', publisher: 'IEEE', title: 'Recommended Practice for Maintenance, Testing, and Replacement of Valve-Regulated Lead-Acid (VRLA) Batteries for Stationary Applications', keyMandate: 'Quarterly ohmic/impedance trending for VRLA; annual capacity test', revisionCycle: 'irregular' },
  { code: 'IEEE 81',        edition: '2012', publisher: 'IEEE', title: 'Guide for Measuring Earth Resistivity, Ground Impedance, and Earth Surface Potentials of a Grounding System', keyMandate: 'Fall-of-potential ground-resistance measurement method', revisionCycle: 'irregular' },
  { code: 'NFPA 70',        edition: '2023', publisher: 'NFPA', title: 'National Electrical Code',                                       keyMandate: 'GFP performance test on installation (§230.95(C)); cable tray fill/bonding (§392)', revisionCycle: '3yr' },
];

// ── Task matrix (wave 1: Tier 1 · wave 2: all remaining equipment types) ──────
// taskCode is the stable upsert key (global rows). standardKey references the
// STANDARDS entry whose id is wired in at seed time.
// Interval columns are MONTHS for the C1/C2/C3 governing condition.
const TASKS = [
  // ── SWITCHGEAR ─────────────────────────────────────────────────────────────
  {
    code: 'SWGR_IR_THERMO', equipmentType: 'SWITCHGEAR', name: 'Infrared thermography scan',
    standardKey: 'NFPA 70B', ref: 'NFPA 70B:2023 §11.17 / NETA MTS-2023 Table 100.2',
    // NFPA 70B mandates IR annually regardless of condition; C3 compresses.
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: true, requiresOutage: false, neta: true, netaLevel: 'LEVEL_II',
    description: 'Scan under load (≥40% rated where possible). Record thermal anomalies by ΔT class.',
  },
  {
    code: 'SWGR_INSULATION_RES', equipmentType: 'SWITCHGEAR', name: 'Insulation resistance test',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.1 / Appendix B',
    c1: 36, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Phase-to-phase and phase-to-ground, applied voltage per manufacturer/NETA Table 100.1.',
  },
  {
    code: 'SWGR_CONTACT_RES', equipmentType: 'SWITCHGEAR', name: 'Contact/connection resistance (micro-ohm)',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.1 / Appendix B',
    c1: 60, c2: 24, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Bus joints, breaker stabs, disconnect blades. Compare against adjacent poles; investigate >50% deviation.',
  },
  {
    code: 'SWGR_CB_TRIP', equipmentType: 'SWITCHGEAR', name: 'Circuit breaker trip/operation test',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.6 / Appendix B',
    c1: 60, c2: 48, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_III',
    description: 'Primary/secondary injection per breaker class; verify trip-curve conformance and mechanism operation.',
  },
  {
    code: 'SWGR_RELAY_CAL', equipmentType: 'SWITCHGEAR', name: 'Protective relay calibration',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.9 / Appendix B',
    c1: 60, c2: 48, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_III',
    description: 'Secondary injection; verify pickup, timing, and targets against the coordination study settings.',
  },

  // ── TRANSFORMER_LIQUID ─────────────────────────────────────────────────────
  {
    code: 'XFMR_DGA', equipmentType: 'TRANSFORMER_LIQUID', name: 'Dissolved gas analysis (DGA) oil sample',
    standardKey: 'IEEE C57.104', ref: 'IEEE C57.104-2019 / NFPA 70B:2023 §22.6',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Sample under normal load; lab analysis of H2/CH4/C2H2/C2H4/C2H6/CO/CO2 per IEEE C57.104 interpretation.',
  },
  {
    code: 'XFMR_OIL_QUALITY', equipmentType: 'TRANSFORMER_LIQUID', name: 'Oil quality screen',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.2.2 / Appendix B',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Dielectric breakdown, moisture (Karl Fischer), acidity, interfacial tension, color.',
  },
  {
    code: 'XFMR_TTR', equipmentType: 'TRANSFORMER_LIQUID', name: 'Turns ratio (TTR) test',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.2.2 / Appendix B',
    c1: 60, c2: 36, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'All tap positions; deviation >0.5% from nameplate ratio indicates winding/core problems.',
  },
  {
    code: 'XFMR_INSULATION_RES', equipmentType: 'TRANSFORMER_LIQUID', name: 'Insulation resistance + PI',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.2.2 / Appendix B',
    c1: 36, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Winding-to-winding and winding-to-ground with polarization index.',
  },
  {
    code: 'XFMR_SFRA', equipmentType: 'TRANSFORMER_LIQUID', name: 'Sweep frequency response analysis (SFRA)',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.2.2 (3-5yr per Appendix B)',
    c1: 60, c2: 48, c3: 24,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_III',
    description: 'Fingerprint comparison against baseline; detects winding displacement/core movement.',
  },
  {
    code: 'XFMR_PD_SURVEY', equipmentType: 'TRANSFORMER_LIQUID', name: 'Partial discharge survey (>600V)',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.2.2 / NFPA 70B:2023 (annual >600V)',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: true, requiresOutage: false, neta: true, netaLevel: 'LEVEL_III',
    description: 'Online ultrasonic/TEV survey under normal load.',
  },

  // ── GENERATOR ──────────────────────────────────────────────────────────────
  {
    code: 'GEN_MONTHLY_EXERCISE', equipmentType: 'GENERATOR', name: 'Monthly exercise under load',
    standardKey: 'NFPA 110', ref: 'NFPA 110:2022 §8.4.2 (30% nameplate kW, 30 min)',
    // NFPA 110 mandates monthly REGARDLESS of condition — C1 does not stretch.
    c1: 1, c2: 1, c3: 1,
    requiresEnergized: true, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Run ≥30 minutes at ≥30% nameplate kW (or until water/oil temps stabilize). Log transfer time.',
  },
  {
    code: 'GEN_LOAD_BANK', equipmentType: 'GENERATOR', name: 'Annual load bank test',
    standardKey: 'NFPA 110', ref: 'NFPA 110:2022 §8.4.2.3 (required when monthly runs miss 30% loading)',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: true, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Supplemental load bank: 50% kW × 30min + 75% kW × 60min (continuous 90 min total).',
  },
  {
    code: 'GEN_FULL_SYSTEM_TEST', equipmentType: 'GENERATOR', name: '3-year full system test',
    standardKey: 'NFPA 110', ref: 'NFPA 110:2022 §8.4.9 (4-hour test at full EPSS load)',
    c1: 36, c2: 36, c3: 12,
    requiresEnergized: true, requiresOutage: true, neta: false, netaLevel: null,
    description: 'Full EPSS test for the duration of its class (min 4hr); includes transfer switches.',
  },
  {
    code: 'GEN_FUEL_ANALYSIS', equipmentType: 'GENERATOR', name: 'Fuel quality analysis',
    standardKey: 'NFPA 110', ref: 'NFPA 110:2022 §8.3.8 (annual fuel test per ASTM standards)',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Tank sample to ASTM D975/D6468; microbial contamination, water, sediment, cetane.',
  },
  {
    code: 'GEN_INSULATION_RES', equipmentType: 'GENERATOR', name: 'Winding insulation resistance + PI',
    standardKey: 'IEEE 43', ref: 'IEEE 43-2013 / NETA MTS-2023 §7.15',
    c1: 36, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Stator/rotor IR with polarization index per IEEE 43 minimum values.',
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SECOND WAVE (2026-06-07) — remaining equipment types.
  // Provenance per the header note: doc-verified rows cite as the research
  // docs do; practice-encoded rows carry [ENCODED FROM PRACTICE — VERIFY].
  // ═══════════════════════════════════════════════════════════════════════════

  // ── TRANSFER_SWITCH (ATS) ──────────────────────────────────────────────────
  // NOTE: the NFPA 110 §8.4.1 WEEKLY generator/ATS inspection is day-granular
  // and OUT OF SCOPE until the healthcare-module interval work (G1).
  {
    code: 'ATS_MONTHLY_TRANSFER', equipmentType: 'TRANSFER_SWITCH', name: 'Monthly operational transfer test',
    standardKey: 'NFPA 110', ref: 'NFPA 110:2022 §8.4.6 (each ATS transferred monthly with the EPSS test)',
    // Mandate-fixed: NFPA 110 monthly does NOT stretch for a C1 unit.
    c1: 1, c2: 1, c3: 1,
    requiresEnergized: true, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Transfer each ATS normal→emergency→normal under load with the monthly EPSS test; log transfer time per switch (≤10s for Level 1 systems) and document each ATS separately (un-itemized ATS logs are a top surveyor citation). Interval is mandate-fixed — condition does not stretch it. Healthcare (NFPA 99/CMS): the test must fall in a 20–40-day window from the prior test; window enforcement lands with the day-granular healthcare-module work.',
  },
  {
    code: 'ATS_IR_THERMO', equipmentType: 'TRANSFER_SWITCH', name: 'Infrared thermography scan',
    standardKey: 'NFPA 70B', ref: 'NFPA 70B:2023 §11.17 / NETA MTS-2023 §7.22.3',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: true, requiresOutage: false, neta: true, netaLevel: 'LEVEL_II',
    description: 'Scan under load (≥40% rated where possible); cover normal/emergency/load terminals and control wiring. Record ΔT class and load % at scan time.',
  },
  {
    code: 'ATS_CONTACT_IR_RES', equipmentType: 'TRANSFER_SWITCH', name: 'Contact resistance + insulation resistance',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.22.3 / Appendix B',
    c1: 36, c2: 24, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Micro-ohm across main contacts in both source positions; insulation resistance phase-to-phase and phase-to-ground per NETA Table 100.1. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'ATS_FULL_SYSTEM_TEST', equipmentType: 'TRANSFER_SWITCH', name: '36-month full-system transfer test',
    standardKey: 'NFPA 110', ref: 'NFPA 110:2022 §8.4.9 (full EPSS test, min 4 hours, includes transfer switches)',
    c1: 36, c2: 36, c3: 12,
    requiresEnergized: true, requiresOutage: true, neta: false, netaLevel: null,
    description: 'ATS leg of the triennial full-load EPSS test (min 4hr at full EPSS load): verify transfer of each switch under the full-system test. Mandate-fixed interval — C1 does not stretch; C3 compresses.',
  },

  // ── SWITCHBOARD ────────────────────────────────────────────────────────────
  {
    code: 'SWBD_IR_THERMO', equipmentType: 'SWITCHBOARD', name: 'Infrared thermography scan',
    standardKey: 'NFPA 70B', ref: 'NFPA 70B:2023 §11.17 / NETA MTS-2023 Table 100.2',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: true, requiresOutage: false, neta: true, netaLevel: 'LEVEL_II',
    description: 'Scan under load (≥40% rated where possible). Record thermal anomalies by ΔT class and load % at scan time.',
  },
  {
    code: 'SWBD_TORQUE_VISUAL', equipmentType: 'SWITCHBOARD', name: 'Visual/mechanical inspection + connection torque verification',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.1 / Appendix B',
    c1: 36, c2: 24, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Inspect bus, supports, barriers, and anchorage; verify bolted connections by calibrated torque wrench or low-resistance ohmmeter survey. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'SWBD_INSULATION_RES', equipmentType: 'SWITCHBOARD', name: 'Insulation resistance test',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.1 / Appendix B',
    c1: 36, c2: 24, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Phase-to-phase and phase-to-ground per NETA Table 100.1, scheduled with the outage cycle. [ENCODED FROM PRACTICE — VERIFY]',
  },

  // ── PANELBOARD ─────────────────────────────────────────────────────────────
  {
    code: 'PNL_IR_THERMO', equipmentType: 'PANELBOARD', name: 'Infrared thermography scan',
    standardKey: 'NFPA 70B', ref: 'NFPA 70B:2023 §11.17 / NETA MTS-2023 Table 100.2',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: true, requiresOutage: false, neta: true, netaLevel: 'LEVEL_II',
    description: 'Scan with dead-front removed, under load (≥40% rated where possible). Record ΔT class and load % at scan time.',
  },
  {
    code: 'PNL_TORQUE_VISUAL', equipmentType: 'PANELBOARD', name: 'Visual/mechanical inspection + connection torque verification',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.1 / Appendix B',
    c1: 36, c2: 24, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Inspect interior, breaker seating, and conductor condition; verify lug/breaker connections to manufacturer torque spec. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'PNL_INSULATION_RES', equipmentType: 'PANELBOARD', name: 'Insulation resistance test',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.1 / Appendix B',
    c1: 36, c2: 24, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Phase-to-phase and phase-to-ground per NETA Table 100.1, scheduled with the outage cycle. [ENCODED FROM PRACTICE — VERIFY]',
  },

  // ── BUSWAY ─────────────────────────────────────────────────────────────────
  {
    code: 'BUS_IR_THERMO', equipmentType: 'BUSWAY', name: 'Infrared thermography scan',
    standardKey: 'NFPA 70B', ref: 'NFPA 70B:2023 §11.17 / NETA MTS-2023 §7.4',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: true, requiresOutage: false, neta: true, netaLevel: 'LEVEL_II',
    description: 'Scan accessible joints, plug-in units, and end feeds under load — busway joints loosen with thermal cycling. Record ΔT class and load %.',
  },
  {
    code: 'BUS_TORQUE_CHECK', equipmentType: 'BUSWAY', name: 'Bolted joint torque verification',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.4 / Appendix B',
    c1: 36, c2: 24, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Verify joint bolts to manufacturer torque spec (or check belleville-washer indication); inspect supports, hangers, and housing integrity. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'BUS_INSULATION_RES', equipmentType: 'BUSWAY', name: 'Insulation resistance test',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.4 / Appendix B',
    c1: 36, c2: 24, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Phase-to-phase and phase-to-ground per run/section per NETA Table 100.1. [ENCODED FROM PRACTICE — VERIFY]',
  },

  // ── CIRCUIT_BREAKER (standalone LV power / insulated-case / molded-case;
  //    breakers inside switchgear lineups are covered by SWGR_CB_TRIP) ───────
  {
    code: 'CB_TRIP_TEST', equipmentType: 'CIRCUIT_BREAKER', name: 'Primary-injection trip test',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.6 / Appendix B',
    c1: 60, c2: 48, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_III',
    description: 'Primary current injection at %-of-rated points; verify trip times against the published time-current curve tolerance band; record as-found AND as-left settings.',
  },
  {
    code: 'CB_CONTACT_RES', equipmentType: 'CIRCUIT_BREAKER', name: 'Contact/pole resistance (micro-ohm)',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.6 / Appendix B',
    c1: 60, c2: 24, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Per-pole micro-ohm measurement; investigate >50% deviation between poles. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'CB_INSULATION_RES', equipmentType: 'CIRCUIT_BREAKER', name: 'Insulation resistance test',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.6 / NETA Table 100.1',
    c1: 36, c2: 24, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Pole-to-pole, pole-to-ground, and across open contacts per NETA Table 100.1. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'CB_MECH_OPERATION', equipmentType: 'CIRCUIT_BREAKER', name: 'Mechanical operation / exercise',
    standardKey: 'NFPA 70B', ref: 'NFPA 70B:2023 (periodic exercising) / NETA MTS-2023 §7.6',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: true, neta: false, netaLevel: null,
    description: 'Operate through open/close (and charge, where applicable) cycles; verify mechanism freedom, interlocks, and trip-free operation. Breakers that sit closed for years are the ones that fail to trip. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'CB_LUBRICATION', equipmentType: 'CIRCUIT_BREAKER', name: 'Mechanism lubrication per manufacturer',
    standardKey: 'NETA MTS', ref: 'Manufacturer service manual / NETA MTS-2023 §7.6',
    c1: 60, c2: 36, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: false, netaLevel: null,
    description: 'Lubricate mechanism and contact surfaces with manufacturer-specified lubricants only; interval governed by the manufacturer manual — conservative base encoded here. [ENCODED FROM PRACTICE — VERIFY]',
  },

  // ── MOTOR ──────────────────────────────────────────────────────────────────
  {
    code: 'MTR_INSULATION_RES_PI', equipmentType: 'MOTOR', name: 'Winding insulation resistance + polarization index',
    standardKey: 'IEEE 43', ref: 'IEEE 43-2013 / NETA MTS-2023 §7.15',
    c1: 36, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Megohm at 30s/1min/10min with PI (≥2.0 acceptable, <1.0 do not energize); temperature-correct readings to 40°C for trending.',
  },
  {
    code: 'MTR_VIBRATION', equipmentType: 'MOTOR', name: 'Vibration analysis',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.15 / Appendix B (predictive maintenance)',
    // Quarterly for critical/C3 machines; semiannual base.
    c1: 12, c2: 6, c3: 3,
    requiresEnergized: true, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Vibration spectrum under normal load; trend amplitude/frequency signatures against baseline for bearing, alignment, and balance degradation. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'MTR_WINDING_RES', equipmentType: 'MOTOR', name: 'Winding resistance test',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.15 / Appendix B',
    c1: 60, c2: 36, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Phase-to-phase winding resistance; investigate imbalance >2% between phases. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'MTR_IR_THERMO', equipmentType: 'MOTOR', name: 'Infrared thermography scan',
    standardKey: 'NFPA 70B', ref: 'NFPA 70B:2023 §11.17 / NETA MTS-2023 §7.15',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: true, requiresOutage: false, neta: true, netaLevel: 'LEVEL_II',
    description: 'Scan connection box, starter/feeder connections, and bearing housings under load. Record ΔT class and load %.',
  },

  // ── MCC ────────────────────────────────────────────────────────────────────
  {
    code: 'MCC_IR_THERMO', equipmentType: 'MCC', name: 'Infrared thermography scan',
    standardKey: 'NFPA 70B', ref: 'NFPA 70B:2023 §11.17 / NETA MTS-2023 §7.16',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: true, requiresOutage: false, neta: true, netaLevel: 'LEVEL_II',
    description: 'Scan horizontal/vertical bus, bucket stabs, and starter connections under load (≥40% rated where possible).',
  },
  {
    code: 'MCC_INSULATION_RES', equipmentType: 'MCC', name: 'Insulation resistance test',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.16 / Appendix B',
    c1: 36, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Bus and each bucket, phase-to-phase and phase-to-ground per NETA Table 100.1. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'MCC_STARTER_INSPECT', equipmentType: 'MCC', name: 'Starter/contactor inspection',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.16.1 / Appendix B',
    c1: 60, c2: 36, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: false, netaLevel: null,
    description: 'Inspect contactor contacts for wear/pitting, verify overload relay sizing/settings against motor FLA, check coil and mechanical operation per bucket. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'MCC_TORQUE_VERIFY', equipmentType: 'MCC', name: 'Connection torque verification',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.16 / Appendix B',
    c1: 60, c2: 36, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Verify bus splice, bucket stab, and load terminal connections by torque wrench or micro-ohm survey. [ENCODED FROM PRACTICE — VERIFY]',
  },

  // ── TRANSFORMER_DRY ────────────────────────────────────────────────────────
  {
    code: 'XFMRD_INSULATION_RES', equipmentType: 'TRANSFORMER_DRY', name: 'Insulation resistance + PI',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.2.1 / Appendix B',
    c1: 36, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Winding-to-winding and winding-to-ground with polarization index, per NETA Table 100.5.',
  },
  {
    code: 'XFMRD_IR_THERMO', equipmentType: 'TRANSFORMER_DRY', name: 'Infrared thermography scan',
    standardKey: 'NFPA 70B', ref: 'NFPA 70B:2023 §11.17 / NETA MTS-2023 §7.2.1',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: true, requiresOutage: false, neta: true, netaLevel: 'LEVEL_II',
    description: 'Scan windings (through ventilation openings where safe), terminations, and tap connections under load.',
  },
  {
    code: 'XFMRD_TTR', equipmentType: 'TRANSFORMER_DRY', name: 'Turns ratio (TTR) test',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.2.1 / Appendix B',
    c1: 60, c2: 36, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'All tap positions; deviation >0.5% from nameplate ratio indicates winding/core problems. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'XFMRD_WINDING_RES', equipmentType: 'TRANSFORMER_DRY', name: 'Winding resistance test',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.2.1 / Appendix B',
    c1: 60, c2: 36, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Winding resistance per phase; compare against factory/baseline values and between phases. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'XFMRD_VISUAL_MECH', equipmentType: 'TRANSFORMER_DRY', name: 'Visual/mechanical inspection + cooling fan & temperature controls',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.2.1',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: true, neta: false, netaLevel: null,
    description: 'Inspect windings/insulators for dust accumulation and tracking, clean ventilation passages, verify cooling fans and winding-temperature controller/alarm setpoints operate. [ENCODED FROM PRACTICE — VERIFY]',
  },

  // ── UPS_BATTERY ────────────────────────────────────────────────────────────
  {
    code: 'UPS_BATT_OHMIC', equipmentType: 'UPS_BATTERY', name: 'Battery ohmic/impedance test (quarterly)',
    standardKey: 'IEEE 1188', ref: 'IEEE 1188-2005 (VRLA quarterly ohmic) / NETA MTS-2023 §7.18.1',
    // IEEE-recommended quarterly cadence (verified 2026-06-07 research) — C1
    // does not stretch; C3 compresses to monthly.
    c1: 3, c2: 3, c3: 1,
    requiresEnergized: true, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Per-jar ohmic/impedance on float using the SAME instrument and probe placement each reading; establish baseline at ~6 months; 30–50% rise from baseline = replace. IEEE-recommended quarterly — condition does not stretch the interval.',
  },
  {
    code: 'UPS_BATT_CAPACITY', equipmentType: 'UPS_BATTERY', name: 'Annual battery capacity/discharge test',
    standardKey: 'IEEE 1188', ref: 'IEEE 1188-2005 (annual capacity test; pass ≥80% rated)',
    c1: 12, c2: 12, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: false, netaLevel: null,
    description: 'Load-bank discharge per IEEE 1188; pass = ≥80% of rated capacity. Annual cadence is fixed (verified 2026-06-07 research) — degrading ohmic trend should trigger replacement planning, not a longer test interval.',
  },
  {
    code: 'UPS_LOAD_TRANSFER_TEST', equipmentType: 'UPS_BATTERY', name: 'UPS full-load and transfer test',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.22.2 / manufacturer service manual',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: true, requiresOutage: true, neta: false, netaLevel: null,
    description: 'Verify inverter operation at full load, transfer to/from static and maintenance bypass, and alarm/shutdown setpoints during a planned maintenance window. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'UPS_CAP_FAN_INSPECT', equipmentType: 'UPS_BATTERY', name: 'Capacitor and cooling fan inspection',
    standardKey: 'NETA MTS', ref: 'Manufacturer service manual / NETA MTS-2023 §7.22.2',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: true, neta: false, netaLevel: null,
    description: 'Inspect DC bus / AC filter capacitors for swelling or leakage and fans for bearing wear; replace on the manufacturer life schedule (capacitors typically 5–7 yr, fans per manual). [ENCODED FROM PRACTICE — VERIFY]',
  },

  // ── BATTERY_SYSTEM (stationary strings + chargers) ─────────────────────────
  {
    code: 'BATT_OHMIC_FLOAT', equipmentType: 'BATTERY_SYSTEM', name: 'Quarterly ohmic + per-cell float voltage',
    standardKey: 'IEEE 450', ref: 'IEEE 450-2010 (vented) / IEEE 1188-2005 (VRLA) — quarterly per-cell float V, temperature, ohmic',
    c1: 3, c2: 3, c3: 1,
    requiresEnergized: true, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Per-cell float voltage, pilot-cell temperature, and ohmic value with the same instrument + probe placement each reading; trend against baseline (30–50% ohmic rise from baseline = replace). IEEE-recommended quarterly — condition does not stretch the interval.',
  },
  {
    code: 'BATT_CAPACITY', equipmentType: 'BATTERY_SYSTEM', name: 'Annual capacity/discharge test',
    standardKey: 'IEEE 450', ref: 'IEEE 450-2010 / IEEE 1188-2005 (annual capacity test; pass ≥80% rated)',
    c1: 12, c2: 12, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: false, netaLevel: null,
    description: 'Discharge test against the duty-cycle or rated load; pass = ≥80% of rated capacity. Annual cadence is fixed (verified 2026-06-07 research).',
  },
  {
    code: 'BATT_TERMINAL_TORQUE', equipmentType: 'BATTERY_SYSTEM', name: 'Terminal torque + connection resistance',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.18.1 / IEEE 450-2010',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Measure intercell/terminal connection resistance against baseline, retorque to manufacturer spec, clean and inspect for corrosion/electrolyte residue. [ENCODED FROM PRACTICE — VERIFY]',
  },

  // ── PROTECTION_RELAY (standalone; relays within switchgear lineups are
  //    covered by SWGR_RELAY_CAL) ─────────────────────────────────────────────
  {
    code: 'RELAY_SEC_INJECTION', equipmentType: 'PROTECTION_RELAY', name: 'Secondary-injection calibration',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.9 / Appendix B (24-36mo class)',
    c1: 36, c2: 24, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_III',
    description: 'Secondary injection; verify pickup, timing, and targets/output contacts against as-left settings. NOTE: HSB/insurer guidance expects ANNUAL relay test records — confirm cadence with the carrier. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'RELAY_TRIP_PATH', equipmentType: 'PROTECTION_RELAY', name: 'Functional trip-path verification (relay-to-breaker)',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.9 / Appendix B',
    c1: 36, c2: 24, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_III',
    description: 'Trip the associated breaker from the relay, exercising the live trip path (wiring, aux contacts, trip coil, lockout relays). Schedule with calibration. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'RELAY_SETTINGS_VS_STUDY', equipmentType: 'PROTECTION_RELAY', name: 'Settings vs coordination study verification',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.9; short-circuit/coordination study currency ≤5yr (insurer-verified expectation)',
    c1: 60, c2: 60, c3: 24,
    requiresEnergized: false, requiresOutage: false, neta: true, netaLevel: 'LEVEL_II',
    description: 'Compare as-found relay settings against the current coordination study; re-verify whenever the study is revised. The studies themselves should be ≤5 years old — a top-5 insurer audit ask. [ENCODED FROM PRACTICE — VERIFY]',
  },

  // ── GROUND_FAULT_PROTECTION ────────────────────────────────────────────────
  {
    code: 'GFP_PERFORMANCE_TEST', equipmentType: 'GROUND_FAULT_PROTECTION', name: 'GFP system performance test',
    standardKey: 'NFPA 70', ref: 'NEC (NFPA 70) §230.95(C) / NETA MTS-2023 §7.14',
    c1: 36, c2: 24, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'NEC 230.95(C) mandates the performance test when first installed; periodic retest per NETA §7.14: verify pickup current and time delay by primary current injection through the sensor; record on the panel test form. Periodic interval is practice-based. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'GFP_ZONE_COORDINATION', equipmentType: 'GROUND_FAULT_PROTECTION', name: 'Zone-selectivity / coordination verification',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.14 / Appendix B',
    c1: 60, c2: 36, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_III',
    description: 'Verify zone-interlocking and selective coordination between GFP levels against the coordination study. [ENCODED FROM PRACTICE — VERIFY]',
  },

  // ── DISCONNECT_SWITCH ──────────────────────────────────────────────────────
  {
    code: 'DISC_IR_THERMO', equipmentType: 'DISCONNECT_SWITCH', name: 'Infrared thermography scan',
    standardKey: 'NFPA 70B', ref: 'NFPA 70B:2023 §11.17 / NETA MTS-2023 §7.5',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: true, requiresOutage: false, neta: true, netaLevel: 'LEVEL_II',
    description: 'Scan blades, jaws, and terminal connections under load. Record ΔT class and load %.',
  },
  {
    code: 'DISC_MECH_OPERATION', equipmentType: 'DISCONNECT_SWITCH', name: 'Mechanical operation + lubrication',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.5 / Appendix B',
    c1: 36, c2: 24, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: false, netaLevel: null,
    description: 'Operate the switch; verify blade alignment and penetration, arc chutes/interrupters, interlocks; lubricate per manufacturer. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'DISC_CONTACT_RES', equipmentType: 'DISCONNECT_SWITCH', name: 'Contact resistance (micro-ohm)',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.5 / Appendix B',
    c1: 60, c2: 24, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Micro-ohm across each blade/pole; compare between poles and investigate >50% deviation. [ENCODED FROM PRACTICE — VERIFY]',
  },

  // ── SURGE_ARRESTER ─────────────────────────────────────────────────────────
  {
    code: 'SA_VISUAL', equipmentType: 'SURGE_ARRESTER', name: 'Visual/mechanical inspection',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.19 (LV SPD) / §7.20 (MV-HV arresters)',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Inspect housings for damage/tracking/contamination, check status indicators and surge counters, verify short lead length and intact ground connections. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'SA_LEAKAGE_TEST', equipmentType: 'SURGE_ARRESTER', name: 'Leakage current / insulation watt-loss test',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.19 / §7.20 / Appendix B',
    c1: 36, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Online leakage-current survey or offline insulation/watts-loss test per arrester class; compare against similar units and baseline. [ENCODED FROM PRACTICE — VERIFY]',
  },

  // ── CABLE_LV (≤600V feeders) ───────────────────────────────────────────────
  {
    code: 'CBLLV_INSULATION_RES', equipmentType: 'CABLE_LV', name: 'Insulation resistance test (per run)',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.3.1 / Appendix B',
    c1: 60, c2: 36, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Per-run megohm against NETA Table 100.1; keep history per run and temperature-correct readings for trending. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'CBLLV_TERM_VISUAL', equipmentType: 'CABLE_LV', name: 'Visual inspection at terminations',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.3.1',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Inspect accessible terminations for discoloration, tracking, corrosion, and mechanical strain; pair with panel IR scans. [ENCODED FROM PRACTICE — VERIFY]',
  },

  // ── CABLE_MV_HV ────────────────────────────────────────────────────────────
  {
    code: 'CBLMV_VLF_PD', equipmentType: 'CABLE_MV_HV', name: 'VLF withstand or partial discharge test',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.3.3 / IEEE 400.2 (VLF)',
    c1: 60, c2: 60, c3: 24,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_III',
    description: 'Offline VLF withstand (IEEE 400.2) or partial-discharge/tan-delta assessment per engineering judgment; repeated withstand testing of aged cable carries failure risk — prefer diagnostic (PD/tan δ) on degraded runs. Interval class is a non-EE judgment on §7.3.3 practice. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'CBLMV_IR_TERMINATIONS', equipmentType: 'CABLE_MV_HV', name: 'Infrared scan at terminations',
    standardKey: 'NFPA 70B', ref: 'NFPA 70B:2023 §11.17 / NETA MTS-2023 §7.3.3',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: true, requiresOutage: false, neta: true, netaLevel: 'LEVEL_II',
    description: 'Scan accessible terminations, splices, and elbows under load. Record ΔT class and load %.',
  },
  {
    code: 'CBLMV_SHIELD_CONTINUITY', equipmentType: 'CABLE_MV_HV', name: 'Shield/sheath continuity test',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.3.3 / Appendix B',
    c1: 60, c2: 36, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Verify shield continuity and grounding on each run during the outage cycle; broken shields concentrate stress and precede insulation failure. [ENCODED FROM PRACTICE — VERIFY]',
  },

  // ── CABLE_TRAY ─────────────────────────────────────────────────────────────
  {
    code: 'TRAY_VISUAL', equipmentType: 'CABLE_TRAY', name: 'Structural/corrosion/loading inspection',
    standardKey: 'NFPA 70B', ref: 'NFPA 70B:2023 (cable tray systems) / NEC (NFPA 70) §392.22 (fill)',
    c1: 24, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Inspect supports/hangers, corrosion, fill/loading vs NEC 392.22, cover integrity, sharp edges, and clearance from heat sources. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'TRAY_BOND_CONTINUITY', equipmentType: 'CABLE_TRAY', name: 'Bonding/ground continuity verification',
    standardKey: 'NFPA 70', ref: 'NEC (NFPA 70) §392.60 (bonding) / NETA MTS-2023 §7.13',
    c1: 60, c2: 36, c3: 12,
    requiresEnergized: false, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Verify tray-section bonding jumpers and equipment-grounding continuity where tray is used as an EGC. [ENCODED FROM PRACTICE — VERIFY]',
  },

  // ── GROUNDING_SYSTEM ───────────────────────────────────────────────────────
  {
    code: 'GND_FALL_OF_POTENTIAL', equipmentType: 'GROUNDING_SYSTEM', name: 'Ground-resistance test (fall-of-potential)',
    standardKey: 'IEEE 81', ref: 'IEEE 81-2012 / NETA MTS-2023 §7.13',
    // C1 held at 36mo — electrode corrosion is invisible to condition
    // assessment, so the interval does not stretch.
    c1: 36, c2: 36, c3: 12,
    requiresEnergized: false, requiresOutage: false, neta: true, netaLevel: 'LEVEL_II',
    description: 'Fall-of-potential (or clamp-on where geometry prevents it) on the grounding electrode system; trend against baseline and design value. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'GND_POINT_TO_POINT', equipmentType: 'GROUNDING_SYSTEM', name: 'Point-to-point bonding continuity',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.13 / Appendix B',
    c1: 60, c2: 36, c3: 12,
    requiresEnergized: false, requiresOutage: false, neta: true, netaLevel: 'LEVEL_II',
    description: 'Micro-ohm point-to-point between system neutral/ground points, equipment frames, and the grounding electrode system. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'GND_VISUAL_CORROSION', equipmentType: 'GROUNDING_SYSTEM', name: 'Visual corrosion/connection inspection',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.13',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Inspect accessible ground conductors, bonds, and test wells for corrosion, looseness, and mechanical damage. [ENCODED FROM PRACTICE — VERIFY]',
  },

  // ── EMERGENCY_LIGHTING ─────────────────────────────────────────────────────
  // NFPA 101 §7.9.3 intervals are code mandates — NOT condition-stretchable.
  // Intervals verified by the 2026-06-07 healthcare research pass.
  {
    code: 'ELTG_MONTHLY_FUNCTIONAL', equipmentType: 'EMERGENCY_LIGHTING', name: 'Monthly 30-second functional test',
    standardKey: 'NFPA 101', ref: 'NFPA 101 §7.9.3.1 (monthly 30-second functional test)',
    c1: 1, c2: 1, c3: 1,
    requiresEnergized: true, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Activate each battery-powered emergency light / exit sign for ≥30 seconds; record per-unit pass/fail (checkmark-only logs are a survey citation). Interval is mandate-fixed — condition NEVER stretches it.',
  },
  {
    code: 'ELTG_ANNUAL_90MIN', equipmentType: 'EMERGENCY_LIGHTING', name: 'Annual 90-minute discharge test',
    standardKey: 'NFPA 101', ref: 'NFPA 101 §7.9.3.1 (annual 90-minute full-duration test, egress lighting)',
    c1: 12, c2: 12, c3: 12,
    requiresEnergized: true, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Full 90-minute discharge of each egress unit annually; pass = illumination maintained for the full duration. Mandate-fixed — condition does not stretch it. NOTE: OR/surgical battery lighting has a DIFFERENT annual 30-minute test (NFPA 99 §6.3.2.2.11.5) — lands with the healthcare module.',
  },

  // ── VFD ────────────────────────────────────────────────────────────────────
  // Intervals are manufacturer-driven; NETA MTS §7.17 covers adjustable speed
  // drives but defers heavily to the drive manual.
  {
    code: 'VFD_COOLING_CAPS_INSPECT', equipmentType: 'VFD', name: 'Cooling fan/heatsink + capacitor inspection',
    standardKey: 'NETA MTS', ref: 'Manufacturer service manual / NETA MTS-2023 §7.17',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: true, neta: false, netaLevel: null,
    description: 'Clean heatsinks and filters, verify fan operation and bearing condition, inspect DC bus capacitors for swelling/leakage; replace on the manufacturer life schedule. Manufacturer-driven interval. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'VFD_DC_BUS_CONNECTIONS', equipmentType: 'VFD', name: 'DC bus + power connection checks',
    standardKey: 'NETA MTS', ref: 'Manufacturer service manual / NETA MTS-2023 §7.17',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: true, neta: false, netaLevel: null,
    description: 'Measure DC bus voltage/ripple, verify power and control terminal torque to manufacturer spec, check precharge circuit operation. Manufacturer-driven interval. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'VFD_IR_THERMO', equipmentType: 'VFD', name: 'Infrared thermography scan',
    standardKey: 'NFPA 70B', ref: 'NFPA 70B:2023 §11.17 / NETA MTS-2023 §7.17',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: true, requiresOutage: false, neta: true, netaLevel: 'LEVEL_II',
    description: 'Scan input/output/DC bus connections and reactor/filter components under load. Record ΔT class and load %.',
  },

  // ── FIRE_PUMP_CONTROLLER ───────────────────────────────────────────────────
  // NOTE: the NFPA 25 WEEKLY no-flow cadence for diesel-driven pumps
  // (§8.3.1.1) is day-granular and OUT OF SCOPE until the healthcare-module
  // interval work. Rows below are oversight/compliance records — the
  // sprinkler contractor typically executes the tests.
  {
    code: 'FP_MONTHLY_CHURN', equipmentType: 'FIRE_PUMP_CONTROLLER', name: 'Monthly electric-pump no-flow (churn) run — oversight record',
    standardKey: 'NFPA 25', ref: 'NFPA 25:2023 §8.3.1.2 (electric fire pumps: monthly no-flow run; monthly cadence effective since the 2017 edition)',
    c1: 1, c2: 1, c3: 1,
    requiresEnergized: true, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Oversight record of the monthly no-flow run (≥10 min for electric pumps): suction/discharge pressure, automatic controller start, alarm and signal verification. Interval is mandate-fixed — condition does not stretch it.',
  },
  {
    code: 'FP_ANNUAL_FLOW', equipmentType: 'FIRE_PUMP_CONTROLLER', name: 'Annual flow test — oversight record',
    standardKey: 'NFPA 25', ref: 'NFPA 25:2023 §8.3.3.1 (annual flow test at churn/100%/150% of rated capacity)',
    c1: 12, c2: 12, c3: 12,
    requiresEnergized: true, requiresOutage: false, neta: false, netaLevel: null,
    description: 'Annual flow test record at churn, 100%, and 150% of rated capacity; compare results against the rated pump curve. Mandate-fixed — condition does not stretch it.',
  },
  {
    code: 'FP_IR_CONNECTIONS', equipmentType: 'FIRE_PUMP_CONTROLLER', name: 'Infrared scan + electrical connection inspection',
    standardKey: 'NFPA 70B', ref: 'NFPA 70B:2023 §11.17 / industry practice (fire pump controller)',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: true, requiresOutage: false, neta: true, netaLevel: 'LEVEL_II',
    description: 'IR scan of the controller (and transfer switch, where service/generator fed) during a run; visually inspect line and load connections. [ENCODED FROM PRACTICE — VERIFY]',
  },

  // ── FUSE_GEAR (fusible switches / fuse cabinets) ───────────────────────────
  {
    code: 'FUSE_VISUAL_RATINGS', equipmentType: 'FUSE_GEAR', name: 'Visual inspection + fuse ratings verification',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.7 / Appendix B',
    c1: 12, c2: 12, c3: 6,
    requiresEnergized: false, requiresOutage: true, neta: false, netaLevel: null,
    description: 'Verify installed fuse type/class/rating against the coordination study and the spares inventory; inspect clips, barriers, and silencers for damage or overheating evidence. De-energize before handling fuses. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'FUSE_CLIP_RES', equipmentType: 'FUSE_GEAR', name: 'Fuse-clip/contact resistance (micro-ohm)',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.7 / Appendix B',
    c1: 36, c2: 24, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Micro-ohm across fuse clips and switch contacts; compare between phases and investigate >50% deviation. Weak clip tension is the classic fuse-gear failure mode. [ENCODED FROM PRACTICE — VERIFY]',
  },
  {
    code: 'FUSE_INSULATION_RES', equipmentType: 'FUSE_GEAR', name: 'Insulation resistance test',
    standardKey: 'NETA MTS', ref: 'NETA MTS-2023 §7.7 / NETA Table 100.1',
    c1: 36, c2: 24, c3: 12,
    requiresEnergized: false, requiresOutage: true, neta: true, netaLevel: 'LEVEL_II',
    description: 'Phase-to-phase and phase-to-ground per NETA Table 100.1. [ENCODED FROM PRACTICE — VERIFY]',
  },
];

const prisma = new PrismaClient();

// NFPA 70B:2023 Table 9.2.2 — fixed per-equipment, per-task-category intervals
// (months), adopted as the seed basis instead of the NETA-multiplier derivation.
// The 3-axis condition assessment (physical / criticality / ENVIRONMENT, worst
// governs) still selects WHICH column applies, so a unit in harsh outdoor
// conditions lands on C3 and gets the tight interval — the environment scaling
// runs on top of the standard's numbers. Returns null to KEEP a task's existing
// interval (operational / NFPA 110 time-based tasks are not 70B condition-based).
function seventyBInterval(t) {
  const code = (t.code || '').toUpperCase();
  const name = (t.name || '').toLowerCase();
  const eq   = t.equipmentType || '';
  // preserve operational / NFPA 110 cadence tasks (monthly exercise, annual load
  // bank, fuel analysis, full-system transfer, battery discharge, etc.)
  if (/monthly|exercise|load bank|fuel|full[ -]?system|discharge|quarterly|weekly|annual/.test(name)) return null;
  if ((t.c2 == null ? 99 : t.c2) <= 2) return null;  // sub-quarterly base = operational
  const isThermo = code.includes('IR_THERMO') || /thermograph|infrared/.test(name);
  const isVisual = /visual|inspection|torque/.test(name) || code.includes('VISUAL');
  if (isThermo || isVisual)        return { c1: 12, c2: 12, c3: 6 };   // ALL-equipment IR + visual
  if (eq === 'UPS_BATTERY')        return { c1: 12, c2: 6,  c3: 3 };   // UPS cleaning/testing
  if (eq === 'GROUNDING_SYSTEM')   return { c1: 60, c2: 36, c3: 36 };  // grounding electrical testing (C3 not compressed)
  return { c1: 60, c2: 36, c3: 12 };                                   // dominant 70B Table 9.2.2 row
}

async function seedStandards(prismaClient) {
  const db = prismaClient || prisma;

  // Standards: upsert on (code, edition).
  const standardIdByCode = {};
  for (const s of STANDARDS) {
    const row = await db.complianceStandard.upsert({
      where:  { code_edition: { code: s.code, edition: s.edition } },
      update: { publisher: s.publisher, title: s.title, keyMandate: s.keyMandate, revisionCycle: s.revisionCycle },
      create: { code: s.code, edition: s.edition, publisher: s.publisher, title: s.title, keyMandate: s.keyMandate, revisionCycle: s.revisionCycle },
    });
    standardIdByCode[s.code] = row.id;
  }

  // Task definitions: global rows (accountId null). The (accountId,
  // equipmentType, taskCode) unique does not constrain NULL accountId rows in
  // Postgres, so we enforce idempotency in code via findFirst-then-update.
  let created = 0, updated = 0;
  for (const t of TASKS) {
    const iv = seventyBInterval(t) || { c1: t.c1, c2: t.c2, c3: t.c3 };
    const data = {
      accountId:             null,
      standardId:            standardIdByCode[t.standardKey] || null,
      equipmentType:         t.equipmentType,
      taskName:              t.name,
      taskCode:              t.code,
      description:           t.description || null,
      intervalC1Months:      iv.c1,
      intervalC2Months:      iv.c2,
      intervalC3Months:      iv.c3,
      requiresOutage:        !!t.requiresOutage,
      requiresEnergized:     !!t.requiresEnergized,
      requiresNetaCertified: !!t.neta,
      netaCertLevelMin:      t.netaLevel || null,
      standardRef:           t.ref,
    };
    const existing = await db.maintenanceTaskDefinition.findFirst({
      where: { accountId: null, taskCode: t.code, equipmentType: t.equipmentType },
      select: { id: true },
    });
    if (existing) {
      await db.maintenanceTaskDefinition.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await db.maintenanceTaskDefinition.create({ data });
      created++;
    }
  }

  console.log(`[seed-standards] ${STANDARDS.length} standards upserted; task matrix: ${created} created, ${updated} updated`);
  return { standards: STANDARDS.length, tasksCreated: created, tasksUpdated: updated };
}

// CLI entry point
if (require.main === module) {
  seedStandards()
    .then(() => prisma.$disconnect())
    .catch((e) => {
      console.error('[seed-standards] failed:', e);
      return prisma.$disconnect().then(() => process.exit(1));
    });
}

module.exports = { seedStandards, STANDARDS, TASKS };
