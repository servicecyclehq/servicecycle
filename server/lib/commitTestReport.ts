/**
 * lib/commitTestReport.ts -- shared "preview -> committed assets/readings" writer.
 *
 * Extracted from routes/testReportImport.ts POST /commit so BOTH the synchronous
 * route AND the #6 email-in auto-commit worker write identical program-of-record
 * data. The route owns request/auth/section-shape concerns and calls
 * commitAssetReadings per asset; the worker calls commitPreviewSections to turn a
 * raw preview (no human in the loop) straight into asset cards.
 */

'use strict';

const prisma = require('./prisma').default;
const { severityFor, groupTestPoints } = require('./testReportParse');

// W4 trend flags: which direction is "worse" per measurement type, and the
// year-over-year percentage that turns an in-spec reading into an ADVISORY.
const BAD_DIRECTION: any = {
  insulation_resistance: 'down', polarization_index: 'down', dielectric_absorption_ratio: 'down',
  contact_resistance: 'up', winding_resistance: 'up', power_factor: 'up', dissipation_factor: 'up',
  dissolved_gas: 'up', excitation_current: 'up', ground_resistance: 'up',
};
const TREND_PCT = 15;

// [P5 2026-07-22] Worst-severity-wins ranking used when collapsing a
// multi-reading test point (see groupTestPoints()) down to a single
// deficiency. Higher = worse.
const SEV_RANK: any = { ADVISORY: 1, RECOMMENDED: 2, IMMEDIATE: 3 };

// Thrown inside a $transaction to abort the whole commit with a specific HTTP
// status. The route catch maps `httpStatus` to the response.
class HttpableError extends Error {
  httpStatus: number;
  constructor(status: number, message: string) { super(message); this.httpStatus = status; }
}

// [W8] Every ingest commit path (PDF /commit, /bulk-commit, email-in
// commitPreviewSections, Doble commit) independently wrote the same
// `raw ? new Date(raw) : new Date()` fallback: when no date could be parsed
// from the source, the WorkOrder silently gets "now" (commit time) with
// nothing distinguishing it from a real report-stated date. A report
// processed weeks late (backlog, email delay) then mislabels WHEN the test
// actually happened -- exactly the fallback-masks-capture shape already
// fixed for SystemStudy.studyDateSource. One helper, used everywhere, plus a
// WorkOrder.testDateSource column so the fallback is honestly flagged.
function resolveTestDate(raw: any): { when: Date; dateSource: string | null } {
  if (raw != null && raw !== '') {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return { when: d, dateSource: null };
  }
  return { when: new Date(), dateSource: 'unverified_default' };
}

// A reading is "usable" (can complete a WO / roll schedules) if it carries a
// numeric value OR an explicit pass/fail. Mirrors the guard inside
// commitAssetReadings so callers can pre-filter empty sections.
function hasUsableReading(measurements: any[]): boolean {
  return (measurements || []).some((x: any) => {
    const v = (x.asFoundValue != null && x.asFoundValue !== '') ? Number(x.asFoundValue) : null;
    return (v != null && !isNaN(v)) || ['GREEN', 'YELLOW', 'RED'].includes(x.passFail);
  });
}

// [NETA-8-11] Name the standard / criterion behind a pass/fail verdict so the
// auto-created deficiency cites a basis rather than an unexplained flag.
const IEEE43_FLOOR_TYPES = new Set(['polarization_index', 'dielectric_absorption_ratio']);
function passFailBasis(x: any, _passFail: string): string {
  // [W8] testReportParse.ts's Layer-2 physical-plausibility gate forces
  // passFail='RED' and sets sanityNote when a value is outside a physically
  // possible envelope -- that RED did NOT come from the report's own result
  // column (it may have printed GREEN, or nothing at all). Citing "basis:
  // test-report result column" in that case is a false attribution the
  // deficiency reader would reasonably rely on. Check this first: it
  // overrides whatever the report printed, same as the gate itself does.
  if (x.sanityNote) return `basis: automated plausibility check (${x.sanityNote}) -- not the report's stated result`;
  if (x.expectedRange) return `basis: report limit ${x.expectedRange}`;
  if (IEEE43_FLOOR_TYPES.has(String(x.measurementType))) return 'basis: IEEE 43 acceptance floor';
  return 'basis: test-report result column';
}

// Write ONE asset's readings: a COMPLETE WorkOrder parent + TestMeasurement rows
// + auto Deficiency rows (hard pass/fail + year-over-year trend flag). `db` is a
// prisma client OR a $transaction client. Returns the per-asset summary.
async function commitAssetReadings(db: any, p: {
  accountId: string; assetId: string; when: Date; dateSource?: string | null;
  vendor?: string; techName?: string; measurements: any[];
  isAcceptanceTest?: boolean;
}) {
  const { accountId, assetId, when, vendor, techName, measurements } = p;
  const dateSource = p.dateSource ?? null;
  const isAcceptanceTest = !!p.isAcceptanceTest;
  const { checkMeasurementSanity } = require('./measurementSanity');

  if (!hasUsableReading(measurements)) {
    throw new HttpableError(400, 'Report has no usable readings (a value or pass/fail) -- refusing to mark maintenance complete.');
  }

  const wo = await db.workOrder.create({
    data: { accountId, assetId, status: 'COMPLETE', scheduledDate: when, completedDate: when,
            isAcceptanceTest, testDateSource: dateSource,
            notes: `[ingest:test_report]${isAcceptanceTest ? '[acceptance]' : ''} Test report ingest${vendor ? ` -- ${vendor}` : ''}${techName ? ` (${techName})` : ''}` },
    select: { id: true },
  });

  const priorRows = await db.testMeasurement.findMany({
    where: { accountId, deletedAt: null, asFoundValue: { not: null }, workOrder: { assetId } },
    select: { measurementType: true, phase: true, label: true, asFoundValue: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  // [W17 2026-07-23] Key includes `label`, not just type+phase. Without it,
  // every device on a contact_resistance/trip_time table (Main Breaker,
  // Tie Breaker, Feeder F-1..F-4 -- same type, and for trip_time the same
  // null phase too) collapsed into ONE map slot, so a trend deficiency could
  // compare one device's new reading against an UNRELATED device's old one
  // (confirmed live: "Feeder F-3 (Ph A) trending up 33% since last test
  // (66->88uOhm)" -- 66 was actually Feeder F-4's 2024 Phase-A value, not
  // Feeder F-3's). label still doesn't disambiguate insulation_resistance's
  // 1-Min/10-Min/PI trio (all three share one label, e.g. "A-G") -- that
  // narrower residual case is a separate, smaller-scope follow-up.
  const priorByKey = new Map<string, number>();
  for (const r of priorRows as any[]) {
    const k = `${r.measurementType}|${r.phase || ''}|${r.label || ''}`;
    if (!priorByKey.has(k)) priorByKey.set(k, Number(r.asFoundValue));
  }

  let measurementsCreated = 0;
  let trendDeficiencies = 0;
  let sanityFlags = 0;
  const defBySeverity: any = { IMMEDIATE: 0, RECOMMENDED: 0, ADVISORY: 0 };

  // [P5 2026-07-22] Group readings into NETA test points (groupTestPoints(),
  // moved here from testReportPreview.ts) BEFORE creating pass/fail-severity
  // and trend deficiencies, so a single physical test point that prints
  // multiple rows (e.g. an A-G insulation-resistance point's 1-Min/10-Min/PI
  // readings, all sharing one `label`) yields AT MOST ONE severity
  // deficiency and AT MOST ONE trend deficiency -- not one of each per row.
  // Previously this loop ran per-READING, so a single flagged point could
  // create up to 3x the deficiencies it should have (confirmed against the
  // 3 Riverside NETA demo commits: 1 pre-existing deficiency ballooned to 32
  // across 2024/2025/DEMO). TestMeasurement creation and the sanity-check
  // deficiency stay per-READING below -- those are legitimately about one
  // physical value each, not the point as a whole.
  const points = groupTestPoints(measurements);
  for (const point of points) {
    let worstSev: 'IMMEDIATE' | 'RECOMMENDED' | 'ADVISORY' | null = null;
    let worstSevX: any = null;
    let worstSevPassFail: string | null = null;
    const trendCandidates: Array<{ x: any; dir: string; prior: number; val: number; pct: number }> = [];

    for (const x of point) {
      const raw = x.asFoundValue;
      const val = (raw != null && raw !== '') ? Number(raw) : null;
      const passFail = ['GREEN', 'YELLOW', 'RED'].includes(x.passFail) ? x.passFail : null;
      await db.testMeasurement.create({
        data: {
          accountId, workOrderId: wo.id,
          measurementType: String(x.measurementType || 'measurement'),
          phase: x.phase || null,
          asFoundValue: (val != null && !isNaN(val)) ? val : null,
          asFoundUnit: x.asFoundUnit || null,
          passFail,
          expectedRange: x.expectedRange || null,
          testVoltage: x.testVoltage || null,
          notes: x.notes || null,
          // [W2] The extractor already computes this identity (DGA gas
          // species, winding pair, PF test mode, battery cell) and this same
          // function already READS x.label below for deficiency text -- it
          // was just never persisted on the row itself until now.
          label: x.label || null,
          // [W8] testReportParse.ts's physical-plausibility gate computes this
          // (the reason a value was forced to RED) and the bulk-preview UI
          // already surfaces it to the reviewer -- but it was dropped between
          // preview and persistence, so the committed row (and any deficiency
          // built from it) carried no trace of why. passFailBasis() below
          // reads it back off `x` to give the auto-deficiency an honest basis.
          sanityNote: x.sanityNote || null,
          // [2026-07-08 acquisition audit W2-AI] The preview stage (aiTestReportExtract,
          // testReportPreview) already stamps every reading with `source`
          // ('ai' | 'deterministic') and `confidence` -- but this create() never
          // wrote them, so once committed an AI-vision guess from a blurry photo
          // was indistinguishable from a deterministically-parsed ruled-table
          // value, both in the record and in every export. Populate straight off
          // `x`: 'deterministic' when the extractor didn't stamp a source (the
          // common/default case, matching aiTestReportExtract's convention that
          // only AI/vision-recovered readings carry an explicit source), and
          // confidence only meaningful when source='ai' (schema comment).
          source: x.source || 'deterministic',
          confidence: (x.source === 'ai' && x.confidence != null && !isNaN(Number(x.confidence)))
            ? Number(x.confidence) : null,
        },
      });
      measurementsCreated++;

      if (val != null && !isNaN(val)) {
        const sanity = checkMeasurementSanity(x.measurementType, val);
        if (sanity) {
          await db.deficiency.create({
            data: {
              accountId, assetId, workOrderId: wo.id, severity: 'ADVISORY',
              description: `[data check] ${x.label || x.measurementType}${x.phase ? ` (Ph ${x.phase})` : ''}: ${sanity}`,
              correctiveAction: 'Verify the reading and its unit against the source report before trusting the trend.',
            },
          });
          defBySeverity.ADVISORY++;
          sanityFlags++;
        }
      }

      const sev = severityFor(passFail, !!x.critical);
      if (sev) {
        // Worst-severity-wins across the point's readings -- at most one
        // severity deficiency is created for the whole point, below.
        if (!worstSev || SEV_RANK[sev] > SEV_RANK[worstSev]) {
          worstSev = sev;
          worstSevX = x;
          worstSevPassFail = passFail;
        }
      } else if (val != null && !isAcceptanceTest) {
        const dir = BAD_DIRECTION[String(x.measurementType)];
        const prior = priorByKey.get(`${x.measurementType}|${x.phase || ''}|${x.label || ''}`);
        if (dir && prior != null && prior !== 0) {
          const pct = ((val - prior) / Math.abs(prior)) * 100;
          const worse = (dir === 'up' && pct >= TREND_PCT) || (dir === 'down' && pct <= -TREND_PCT);
          if (worse) trendCandidates.push({ x, dir, prior, val, pct });
        }
      }
    }

    // At most ONE severity deficiency per point -- the worst reading wins.
    if (worstSev && worstSevX) {
      // [NETA-8-11] State the pass/fail BASIS so an auto-created deficiency is
      // defensible: the expected range/limit from the report when present, else
      // the applicable standard floor (IEEE 43 for PI/DAR), else that the verdict
      // came from the report's own result column. Always name the verdict.
      const basis = passFailBasis(worstSevX, worstSevPassFail as string);
      await db.deficiency.create({
        data: {
          accountId, assetId, workOrderId: wo.id, severity: worstSev,
          description: `${worstSevX.label || worstSevX.measurementType}${worstSevX.phase ? ` (Ph ${worstSevX.phase})` : ''}: ${worstSevX.asFoundValue ?? '?'}${worstSevX.asFoundUnit || ''}${worstSevX.expectedRange ? ` -- expected ${worstSevX.expectedRange}` : ''} [${worstSevPassFail}; ${basis}]`,
          correctiveAction: 'Flagged from test report ingest -- review reading and schedule corrective work.',
        },
      });
      defBySeverity[worstSev]++;
    }

    // At most ONE trend deficiency per point -- the steepest degrading
    // reading (largest |pct| among qualifying candidates) wins.
    if (trendCandidates.length) {
      const worstTrend = trendCandidates.reduce((w, c) => (Math.abs(c.pct) > Math.abs(w.pct) ? c : w));
      const { x, dir, prior, val, pct } = worstTrend;
      await db.deficiency.create({
        data: {
          accountId, assetId, workOrderId: wo.id, severity: 'ADVISORY',
          description: `${x.label || x.measurementType}${x.phase ? ` (Ph ${x.phase})` : ''} trending ${dir === 'up' ? 'up' : 'down'} ${Math.abs(Math.round(pct))}% since last test (${prior}->${val}${x.asFoundUnit || ''}) -- still in spec, monitor`,
          correctiveAction: 'Trend flag from test-report ingest -- watch for continued degradation before next cycle.',
        },
      });
      defBySeverity.ADVISORY++;
      trendDeficiencies++;
    }
  }

  const deficienciesCreated = defBySeverity.IMMEDIATE + defBySeverity.RECOMMENDED + defBySeverity.ADVISORY;
  return { workOrderId: wo.id, assetId, measurementsCreated, deficienciesCreated, trendDeficiencies, sanityFlags, deficiencyBySeverity: defBySeverity };
}

// Keyword -> EquipmentType inference for auto-created assets (email-in has no
// human to pick the type). Order matters: more specific patterns first. Falls
// back to SWITCHGEAR (the most common subject of these reports) so a commit
// never fails for lack of a type.
const TYPE_RULES: Array<[RegExp, string]> = [
  [/\b(ats|automatic transfer|transfer switch)\b/i, 'TRANSFER_SWITCH'],
  [/\b(arc[- ]?flash)\b/i, 'ARC_FLASH_PANEL'],
  [/\b(fire pump)\b/i, 'FIRE_PUMP_CONTROLLER'],
  [/\b(ground fault|gfp)\b/i, 'GROUND_FAULT_PROTECTION'],
  [/\b(grounding|ground grid|fall[- ]of[- ]potential)\b/i, 'GROUNDING_SYSTEM'],
  [/\b(surge|spd|arrester)\b/i, 'SURGE_ARRESTER'],
  [/\b(protecti(ve|on) relay|sel[- ]?\d|relay)\b/i, 'PROTECTION_RELAY'],
  [/\b(mcc|motor control center)\b/i, 'MCC'],
  [/\b(vfd|variable frequency|adjustable speed|drive)\b/i, 'VFD'],
  [/\b(motor)\b/i, 'MOTOR'],
  [/\b(generator|genset|engine[- ]generator)\b/i, 'GENERATOR'],
  [/\b(ups)\b/i, 'UPS_BATTERY'],
  [/\b(battery|cell string|vrla)\b/i, 'BATTERY_SYSTEM'],
  [/\b(busway|bus duct|busbar)\b/i, 'BUSWAY'],
  [/\b(panelboard|panel\b|load center)\b/i, 'PANELBOARD'],
  [/\b(switchboard)\b/i, 'SWITCHBOARD'],
  [/\b(switchgear|swgr|metal[- ]clad)\b/i, 'SWITCHGEAR'],
  [/\b(circuit breaker|breaker|power\s?pact|masterpact)\b/i, 'CIRCUIT_BREAKER'],
  [/\b(fuse|fusible)\b/i, 'FUSE_GEAR'],
  [/\b(disconnect|safety switch|load[- ]break)\b/i, 'DISCONNECT_SWITCH'],
  [/\b(transformer).*(dry|cast|vpi)\b/i, 'TRANSFORMER_DRY'],
  [/\b(dry[- ]?type).*(transformer)\b/i, 'TRANSFORMER_DRY'],
  [/\b(transformer|xfmr|pad[- ]?mount)\b/i, 'TRANSFORMER_LIQUID'],
  [/\b(cable).*(mv|medium voltage|hv|high voltage|vlf|partial discharge)\b/i, 'CABLE_MV_HV'],
  [/\b(cable|feeder|conductor)\b/i, 'CABLE_LV'],
  [/\b(emergency light|egress|exit sign)\b/i, 'EMERGENCY_LIGHTING'],
];

// Returns the inferred type AND whether it came from a keyword match vs the
// SWITCHGEAR fallback. The confidence gate uses `matched` as an identity signal:
// a defaulted type means we guessed, so the card should be reviewed before commit.
function inferEquipmentTypeResult(...parts: any[]): { type: string; matched: boolean } {
  const blob = parts.filter(Boolean).map((p) => String(p)).join(' ');
  for (const [re, type] of TYPE_RULES) if (re.test(blob)) return { type, matched: true };
  return { type: 'SWITCHGEAR', matched: false };
}

function inferEquipmentType(...parts: any[]): string {
  return inferEquipmentTypeResult(...parts).type;
}

// Turn a raw preview (from buildTestReportPreview) into committed assets+readings
// with NO human in the loop (#6 email-in). Tolerant: sections with no usable
// reading are skipped (not committed, not fatal). Existing-asset matches are
// reused; everything else is created on `siteId`. All writes are atomic.
async function commitPreviewSections(p: {
  accountId: string; siteId: string; preview: any; originalName?: string;
}) {
  const { accountId, siteId, preview, originalName } = p;
  const meta = preview?.meta || {};
  const { when, dateSource } = resolveTestDate(meta.testDate);
  const vendor = meta.vendor || undefined;
  const techName = meta.techName || undefined;
  const allMeasurements: any[] = Array.isArray(preview?.measurements) ? preview.measurements : [];

  // Build the list of {measurements, assetId?, createAsset{}} units to commit.
  type Unit = { measurements: any[]; assetId?: string; createAsset?: any; label: string | null };
  const units: Unit[] = [];

  if (Array.isArray(preview?.sections) && preview.sections.length > 1) {
    preview.sections.forEach((sec: any, idx: number) => {
      const ms = (sec.measurementIndices || []).map((i: number) => allMeasurements[i]).filter(Boolean);
      if (!ms.length) return;
      const label = sec.label || sec.position || sec.substation || `Section ${idx + 1}`;
      if (sec.assetMatch?.id) {
        units.push({ measurements: ms, assetId: sec.assetMatch.id, label });
      } else {
        // [W8] Use the flag-preserving inference so a keyword-guessed type
        // (SWITCHGEAR fallback or a matched-but-uncertain rule) is honestly
        // marked on the created asset -- see Asset.equipmentTypeSource.
        // An explicit reviewer-set sec.equipmentType always counts as verified.
        const typeRes = sec.equipmentType
          ? { type: sec.equipmentType, matched: true }
          : inferEquipmentTypeResult(sec.label, sec.position, sec.substation, idx === 0 ? meta.model : null, idx === 0 ? meta.manufacturer : null);
        units.push({
          measurements: ms, label,
          createAsset: {
            equipmentType: typeRes.type,
            equipmentTypeSource: typeRes.matched ? null : 'unverified_default',
            manufacturer: idx === 0 ? (meta.manufacturer || null) : null,
            model:        idx === 0 ? (meta.model || null) : null,
            serialNumber: idx === 0 ? (meta.serialNumber || null) : null,
            namePosition: label,
          },
        });
      }
    });
  } else if (allMeasurements.length) {
    const label = meta.model || meta.serialNumber || originalName || 'Imported asset';
    if (preview?.assetMatch?.id) {
      units.push({ measurements: allMeasurements, assetId: preview.assetMatch.id, label });
    } else {
      const typeRes = meta.equipmentType
        ? { type: meta.equipmentType, matched: true }
        : inferEquipmentTypeResult(meta.model, meta.manufacturer, originalName);
      units.push({
        measurements: allMeasurements, label,
        createAsset: {
          equipmentType: typeRes.type,
          equipmentTypeSource: typeRes.matched ? null : 'unverified_default',
          manufacturer: meta.manufacturer || null, model: meta.model || null, serialNumber: meta.serialNumber || null,
          namePosition: null,
        },
      });
    }
  }

  // Drop units with no usable reading up front so the transaction never aborts
  // on a label-only section.
  const committable = units.filter((u) => hasUsableReading(u.measurements));
  if (!committable.length) {
    return { assetsCommitted: 0, assetsCreated: 0, measurementsCreated: 0, deficienciesCreated: 0, sections: [], skipped: units.length };
  }

  const results = await prisma.$transaction(async (tx: any) => {
    const out: any[] = [];
    for (const u of committable) {
      let targetId = u.assetId;
      let created = false;
      if (targetId) {
        const a = await tx.asset.findFirst({ where: { id: targetId, accountId, archivedAt: null }, select: { id: true } });
        if (!a) throw new HttpableError(404, `Asset not found: ${targetId}`);
      } else {
        const c = u.createAsset;
        const na = await tx.asset.create({
          data: {
            accountId, siteId, equipmentType: c.equipmentType, equipmentTypeSource: c.equipmentTypeSource ?? null,
            manufacturer: c.manufacturer, model: c.model, serialNumber: c.serialNumber,
          },
          select: { id: true },
        });
        targetId = na.id; created = true;
      }
      const r = await commitAssetReadings(tx, { accountId, assetId: targetId, when, dateSource, vendor, techName, measurements: u.measurements });
      out.push({ ...r, created, label: u.label });
    }
    return out;
  });

  const totals = results.reduce((acc: any, r: any) => {
    acc.measurementsCreated += r.measurementsCreated;
    acc.deficienciesCreated += r.deficienciesCreated;
    acc.assetsCreated += r.created ? 1 : 0;
    return acc;
  }, { assetsCommitted: results.length, assetsCreated: 0, measurementsCreated: 0, deficienciesCreated: 0 });

  return { ...totals, sections: results, skipped: units.length - committable.length };
}

module.exports = { commitAssetReadings, commitPreviewSections, inferEquipmentType, inferEquipmentTypeResult, hasUsableReading, HttpableError, BAD_DIRECTION, TREND_PCT, resolveTestDate };

export {};
