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
const { severityFor } = require('./testReportParse');

// W4 trend flags: which direction is "worse" per measurement type, and the
// year-over-year percentage that turns an in-spec reading into an ADVISORY.
const BAD_DIRECTION: any = {
  insulation_resistance: 'down', polarization_index: 'down', dielectric_absorption_ratio: 'down',
  contact_resistance: 'up', winding_resistance: 'up', power_factor: 'up', dissipation_factor: 'up',
  dissolved_gas: 'up', excitation_current: 'up', ground_resistance: 'up',
};
const TREND_PCT = 15;

// Thrown inside a $transaction to abort the whole commit with a specific HTTP
// status. The route catch maps `httpStatus` to the response.
class HttpableError extends Error {
  httpStatus: number;
  constructor(status: number, message: string) { super(message); this.httpStatus = status; }
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

// Write ONE asset's readings: a COMPLETE WorkOrder parent + TestMeasurement rows
// + auto Deficiency rows (hard pass/fail + year-over-year trend flag). `db` is a
// prisma client OR a $transaction client. Returns the per-asset summary.
async function commitAssetReadings(db: any, p: {
  accountId: string; assetId: string; when: Date;
  vendor?: string; techName?: string; measurements: any[];
  isAcceptanceTest?: boolean;
}) {
  const { accountId, assetId, when, vendor, techName, measurements } = p;
  const isAcceptanceTest = !!p.isAcceptanceTest;
  const { checkMeasurementSanity } = require('./measurementSanity');

  if (!hasUsableReading(measurements)) {
    throw new HttpableError(400, 'Report has no usable readings (a value or pass/fail) -- refusing to mark maintenance complete.');
  }

  const wo = await db.workOrder.create({
    data: { accountId, assetId, status: 'COMPLETE', scheduledDate: when, completedDate: when,
            isAcceptanceTest,
            notes: `[ingest:test_report]${isAcceptanceTest ? '[acceptance]' : ''} Test report ingest${vendor ? ` -- ${vendor}` : ''}${techName ? ` (${techName})` : ''}` },
    select: { id: true },
  });

  const priorRows = await db.testMeasurement.findMany({
    where: { accountId, deletedAt: null, asFoundValue: { not: null }, workOrder: { assetId } },
    select: { measurementType: true, phase: true, asFoundValue: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  const priorByKey = new Map<string, number>();
  for (const r of priorRows as any[]) {
    const k = `${r.measurementType}|${r.phase || ''}`;
    if (!priorByKey.has(k)) priorByKey.set(k, Number(r.asFoundValue));
  }

  let measurementsCreated = 0;
  let trendDeficiencies = 0;
  let sanityFlags = 0;
  const defBySeverity: any = { IMMEDIATE: 0, RECOMMENDED: 0, ADVISORY: 0 };
  for (const x of measurements) {
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
      await db.deficiency.create({
        data: {
          accountId, assetId, workOrderId: wo.id, severity: sev,
          description: `${x.label || x.measurementType}${x.phase ? ` (Ph ${x.phase})` : ''}: ${x.asFoundValue ?? '?'}${x.asFoundUnit || ''}${x.expectedRange ? ` -- expected ${x.expectedRange}` : ''}`,
          correctiveAction: 'Flagged from test report ingest -- review reading and schedule corrective work.',
        },
      });
      defBySeverity[sev]++;
    } else if (val != null && !isAcceptanceTest) {
      const dir = BAD_DIRECTION[String(x.measurementType)];
      const prior = priorByKey.get(`${x.measurementType}|${x.phase || ''}`);
      if (dir && prior != null && prior !== 0) {
        const pct = ((val - prior) / Math.abs(prior)) * 100;
        const worse = (dir === 'up' && pct >= TREND_PCT) || (dir === 'down' && pct <= -TREND_PCT);
        if (worse) {
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

function inferEquipmentType(...parts: any[]): string {
  const blob = parts.filter(Boolean).map((p) => String(p)).join(' ');
  for (const [re, type] of TYPE_RULES) if (re.test(blob)) return type;
  return 'SWITCHGEAR';
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
  const when = meta.testDate && !isNaN(new Date(meta.testDate).getTime()) ? new Date(meta.testDate) : new Date();
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
        units.push({
          measurements: ms, label,
          createAsset: {
            equipmentType: inferEquipmentType(sec.label, sec.position, sec.substation, idx === 0 ? meta.model : null, idx === 0 ? meta.manufacturer : null),
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
      units.push({
        measurements: allMeasurements, label,
        createAsset: {
          equipmentType: inferEquipmentType(meta.model, meta.manufacturer, originalName),
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
            accountId, siteId, equipmentType: c.equipmentType,
            manufacturer: c.manufacturer, model: c.model, serialNumber: c.serialNumber,
          },
          select: { id: true },
        });
        targetId = na.id; created = true;
      }
      const r = await commitAssetReadings(tx, { accountId, assetId: targetId, when, vendor, techName, measurements: u.measurements });
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

module.exports = { commitAssetReadings, commitPreviewSections, inferEquipmentType, hasUsableReading, HttpableError, BAD_DIRECTION, TREND_PCT };

export {};
