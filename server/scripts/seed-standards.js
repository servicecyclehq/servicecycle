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
 * review can be done line-by-line. Tier 1 equipment only (transformers,
 * generators, switchgear) per the PoC build priority; Tier 2 (UPS, breakers,
 * MCCs) and Tier 3 follow in a later session.
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
];

// ── Tier 1 task matrix ────────────────────────────────────────────────────────
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
];

const prisma = new PrismaClient();

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
    const data = {
      accountId:             null,
      standardId:            standardIdByCode[t.standardKey] || null,
      equipmentType:         t.equipmentType,
      taskName:              t.name,
      taskCode:              t.code,
      description:           t.description || null,
      intervalC1Months:      t.c1,
      intervalC2Months:      t.c2,
      intervalC3Months:      t.c3,
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
