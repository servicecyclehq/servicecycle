/**
 * lib/irScanStatus.ts — #29 "Last IR Scan" for the asset register.
 *
 * Answers, per asset: when was it last IR-scanned, and is that current,
 * overdue, or never done? NFPA 70B:2023 makes IR thermography an annual task,
 * so an energized distribution asset with no survey on file is a compliance
 * gap the register should show, not a blank cell.
 *
 * Cost: TWO grouped queries for a whole page of assets (max survey date per
 * asset, plus the active 70B IR schedules), never one query per asset.
 */

/**
 * IR thermography applies to energized distribution equipment.
 * ⚠ Mirrors the client allow-list in client/src/pages/AssetDetail.jsx (IR_TYPES)
 * — keep the two in sync; a type in one and not the other means the register
 * and the asset page disagree about whether a scan is expected.
 */
export const IR_APPLICABLE_TYPES = new Set([
  'SWITCHGEAR', 'SWITCHBOARD', 'PANELBOARD', 'MCC', 'BUSWAY', 'CIRCUIT_BREAKER',
  'TRANSFORMER_LIQUID', 'TRANSFORMER_DRY', 'DISCONNECT_SWITCH', 'FUSE_GEAR',
  'TRANSFER_SWITCH', 'GENERATOR', 'MOTOR', 'UPS_BATTERY', 'VFD',
]);

// NFPA 70B mandates IR annually regardless of condition (the seeded 70B IR task
// definitions use c1/c2 = 12, c3 = 6 — see server/scripts/seed-standards.js).
// Used only when the asset carries no active IR schedule to read a due date from.
const DEFAULT_IR_INTERVAL_MONTHS = 12;

export type IrStatus = 'current' | 'overdue' | 'never';

export interface IrScanInfo {
  lastIrScanDate: Date | null;
  irStatus: IrStatus;
  irNextDueDate: Date | null;
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d.getTime());
  out.setMonth(out.getMonth() + months);
  return out;
}

/**
 * Build assetId → IrScanInfo for the IR-applicable assets in `assets`.
 * Non-IR types are absent from the map (the caller emits null for them).
 *
 * `assets` must already be the page slice — this reads only their ids.
 */
export async function buildIrScanMap(
  prisma: any,
  accountId: string,
  assets: Array<{ id: string; equipmentType?: string | null }>,
  now: Date = new Date(),
): Promise<Map<string, IrScanInfo>> {
  const out = new Map<string, IrScanInfo>();
  const ids = [...new Set(
    (assets || [])
      .filter((a) => a && a.equipmentType && IR_APPLICABLE_TYPES.has(a.equipmentType))
      .map((a) => a.id),
  )];
  // Guard the empty page: `assetId: { in: [] }` is a pointless round trip.
  if (ids.length === 0) return out;

  const [surveyRows, scheduleRows] = await Promise.all([
    prisma.thermographySurvey.groupBy({
      by:    ['assetId'],
      where: { accountId, assetId: { in: ids } },
      _max:  { surveyDate: true },
    }),
    // The 70B IR schedule carries the authoritative next-due date. Task codes
    // for the seeded IR rows all end in _IR_THERMO (SWGR_IR_THERMO, MTR_IR_THERMO, …).
    prisma.maintenanceSchedule.findMany({
      where: {
        accountId,
        isActive: true,
        assetId: { in: ids },
        taskDefinition: { taskCode: { contains: 'IR_THERMO' } },
      },
      select: { assetId: true, nextDueDate: true },
    }),
  ]);

  const lastScan = new Map<string, Date>();
  for (const r of surveyRows as any[]) {
    const d = r?._max?.surveyDate;
    if (d) lastScan.set(r.assetId, new Date(d));
  }
  // An asset can carry more than one IR schedule (multi-task equipment); the
  // earliest next-due is the one that makes it overdue first.
  const nextDue = new Map<string, Date>();
  for (const r of scheduleRows as any[]) {
    if (!r?.nextDueDate) continue;
    const d = new Date(r.nextDueDate);
    const prev = nextDue.get(r.assetId);
    if (!prev || d < prev) nextDue.set(r.assetId, d);
  }

  for (const id of ids) {
    const last = lastScan.get(id) || null;
    const due  = nextDue.get(id) || null;
    let status: IrStatus;
    if (!last) {
      // IR-applicable and never scanned — the gap the register exists to show.
      status = 'never';
    } else if (due) {
      status = due < now ? 'overdue' : 'current';
    } else {
      // No schedule to read a due date from: fall back to the 70B annual interval.
      status = addMonths(last, DEFAULT_IR_INTERVAL_MONTHS) < now ? 'overdue' : 'current';
    }
    out.set(id, {
      lastIrScanDate: last,
      irStatus:       status,
      irNextDueDate:  due || (last ? addMonths(last, DEFAULT_IR_INTERVAL_MONTHS) : null),
    });
  }
  return out;
}
