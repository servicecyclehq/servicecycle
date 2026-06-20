/**
 * /api/outage-planner — Date-first Outage Plan Generator (§J + gem N1).
 *
 * The brother's question is "my outage is July 18 — what should we do that day?"
 * This module answers it. Given a target outage DATE and a de-energization
 * SCOPE (whole facility / a site / a switchgear+everything downstream of it),
 * it builds the candidate task set from the UNION of three configurable rules:
 *
 *   - dueByDate   (default ON): outage tasks coming due on/before the target date
 *   - carryOver   (default ON): outage tasks deferred since the LAST outage
 *   - opportunistic(default ON): EVERY device de-energized in scope, via the
 *                                power-path graph, regardless of due status
 *                                ("we'd test all of them for sure")
 *
 * Optional filters (off by default, "advanced"): minCondition (C2/C3),
 * minCriticality, standard — these only narrow the opportunistic dragnet,
 * never hide genuinely due/overdue/carry-over work.
 *
 * Output is grouped Location (site) -> Panel/Equipment (the upstream feeder)
 * -> Device (asset) -> tasks, each task tagged with WHY it's included.
 *
 *   GET  /plan            — JSON plan
 *   GET  /plan/export.xlsx— same plan as an Excel check-off sheet
 *   GET  /plan/export.pdf — same plan as a printable field check-off
 *   POST /commit          — create the BlackoutWindow(s) + spawn Work Orders
 *
 * Legacy (kept for back-compat with anything still calling them):
 *   GET  /summary         — original ±90-day browse view
 *   POST /work-order      — original consolidated-WO creator
 *
 * Mounted at /api/outage-planner in server/index.ts. Every query filters
 * accountId = req.user.accountId (IDOR).
 */

'use strict';

const router = require('express').Router();
const { requireManager } = require('../middleware/roles');
const prisma = require('../lib/prisma').default;
const PDFDocument = require('pdfkit');
const { sendXlsx } = require('../lib/xlsxExport');

const WINDOW_DAYS = 90;
const DAY_MS = 86400000;

// ── label + status helpers ────────────────────────────────────────────────────
function assetLabel(a: { manufacturer?: string|null, model?: string|null, serialNumber?: string|null, equipmentType?: string|null }): string {
  const base = [a.manufacturer, a.model].filter(Boolean).join(' ');
  const serial = a.serialNumber ? ` #${a.serialNumber}` : '';
  return base ? base + serial : (a.equipmentType ?? 'Asset');
}

function taskStatus(nextDueDate: Date | null | undefined): 'overdue' | 'due' | 'upcoming' {
  if (!nextDueDate) return 'upcoming';
  const daysUntil = (new Date(nextDueDate).getTime() - Date.now()) / DAY_MS;
  if (daysUntil < 0)   return 'overdue';
  if (daysUntil <= 30) return 'due';
  return 'upcoming';
}

const CONDITION_RANK: Record<string, number> = { C1: 1, C2: 2, C3: 3 };

/** Walk the feed graph downward from a root asset (BFS) — one query, in-memory. */
async function getDownstreamIds(rootId: string, accountId: string): Promise<string[]> {
  const all = await prisma.asset.findMany({
    where:  { accountId },
    select: { id: true, fedFromAssetId: true },
  });
  const childrenByParent = new Map<string, string[]>();
  for (const a of all) {
    if (!a.fedFromAssetId) continue;
    const bucket = childrenByParent.get(a.fedFromAssetId);
    if (bucket) bucket.push(a.id);
    else childrenByParent.set(a.fedFromAssetId, [a.id]);
  }
  const visited = new Set<string>();
  const queue   = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const childId of childrenByParent.get(current) || []) queue.push(childId);
  }
  visited.delete(rootId);
  return [...visited];
}

// ── the core: build the plan object from request params ────────────────────────
// Shared by /plan (JSON), /plan/export.xlsx and /plan/export.pdf so the three
// surfaces can never drift. Returns null + an error string on bad scope.
async function buildPlan(req: any): Promise<{ data?: any, error?: string }> {
  const accountId = req.user.accountId;
  const now = new Date();

  // 1. Target date (default = now + 90d so the page is useful with no input)
  let targetDate: Date;
  if (req.query.date) {
    targetDate = new Date(String(req.query.date));
    if (isNaN(targetDate.getTime())) return { error: 'Invalid date' };
  } else {
    targetDate = new Date(now.getTime() + WINDOW_DAYS * DAY_MS);
  }
  // end-of-day so a task due ON the target date counts as "due in window"
  targetDate.setHours(23, 59, 59, 999);

  // 2. Rule toggles (default ON) + optional filters (advanced, default off)
  const flag = (v: any, dflt: boolean) => (v === undefined ? dflt : !(v === '0' || v === 'false' || v === false));
  const rules = {
    dueByDate:     flag(req.query.dueByDate, true),
    carryOver:     flag(req.query.carryOver, true),
    opportunistic: flag(req.query.opportunistic, true),
  };
  const filters = {
    minCondition:   req.query.minCondition ? String(req.query.minCondition).toUpperCase() : null,  // 'C2' | 'C3'
    minCriticality: req.query.minCriticality ? Number(req.query.minCriticality) : null,            // 1..5
    standard:       req.query.standard ? String(req.query.standard) : null,                        // substring of standardRef
  };

  // 3. Resolve scope -> in-scope asset id set + a human label
  const scopeRaw = String(req.query.scope || 'facility');
  let inScopeIds: string[] | null = null;  // null = whole facility (no id filter)
  let scopeLabel = 'Whole facility';
  let scopeType: 'facility' | 'site' | 'asset' = 'facility';
  let scopeAssetId: string | null = null;

  if (scopeRaw.startsWith('site:')) {
    scopeType = 'site';
    const siteId = scopeRaw.slice(5);
    const site = await prisma.site.findFirst({ where: { id: siteId, accountId }, select: { id: true, name: true } });
    if (!site) return { error: 'Site not found' };
    const assets = await prisma.asset.findMany({ where: { accountId, siteId, archivedAt: null }, select: { id: true } });
    inScopeIds = assets.map((a: any) => a.id);
    scopeLabel = site.name;
  } else if (scopeRaw.startsWith('asset:')) {
    scopeType = 'asset';
    const rootId = scopeRaw.slice(6);
    const root = await prisma.asset.findFirst({
      where: { id: rootId, accountId, archivedAt: null },
      select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true },
    });
    if (!root) return { error: 'Scope asset not found' };
    const downstream = await getDownstreamIds(rootId, accountId);
    inScopeIds = [rootId, ...downstream];
    scopeAssetId = rootId;
    scopeLabel = `${assetLabel(root)} + ${downstream.length} downstream`;
  }

  // 4. Pull every ACTIVE OUTAGE-REQUIRING schedule on in-scope assets, with the
  //    asset (incl. its upstream feeder for the Panel/Equipment grouping).
  const schedules = await prisma.maintenanceSchedule.findMany({
    where: {
      accountId,
      isActive: true,
      taskDefinition: { requiresOutage: true },
      ...(inScopeIds ? { assetId: { in: inScopeIds } } : {}),
    },
    select: {
      id: true, nextDueDate: true, lastCompletedDate: true, conditionOverride: true, assetId: true,
      taskDefinition: { select: { taskName: true, taskCode: true, standardRef: true } },
      asset: {
        select: {
          id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true,
          criticalityScore: true, governingCondition: true, fedFromAssetId: true, inService: true,
          archivedAt: true,
          site: { select: { id: true, name: true } },
          fedFrom: { select: { id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true } },
          workOrders: { where: { status: { in: ['SCHEDULED', 'IN_PROGRESS'] } }, select: { id: true }, take: 1 },
        },
      },
    },
  });

  const active = schedules.filter((s: any) => !s.asset.archivedAt);

  // 5. Carry-over baseline: most recent PAST outage window per site. Anything
  //    that should have been done by then but wasn't is a carry-over.
  const siteIds = [...new Set(active.map((s: any) => s.asset.site?.id).filter(Boolean))] as string[];
  const lastOutageBySite = new Map<string, Date>();
  if (siteIds.length) {
    const past = await prisma.blackoutWindow.findMany({
      where: { accountId, siteId: { in: siteIds }, isOutageWindow: true, endsAt: { lt: now } },
      orderBy: { startsAt: 'desc' },
      select: { siteId: true, startsAt: true },
    });
    for (const w of past) if (!lastOutageBySite.has(w.siteId)) lastOutageBySite.set(w.siteId, w.startsAt);
  }
  const deferThreshold = new Date(now.getTime() - 180 * DAY_MS); // fallback: deferred > 6 months

  function isCarryOver(s: any): boolean {
    const due = s.nextDueDate ? new Date(s.nextDueDate) : null;
    if (!due || due >= now) return false;            // not overdue -> not a carry-over
    const lastOutage = s.asset.site?.id ? lastOutageBySite.get(s.asset.site.id) : null;
    if (lastOutage) {
      const done = s.lastCompletedDate ? new Date(s.lastCompletedDate) : null;
      return !done || done < lastOutage;             // wasn't done in/after the last outage
    }
    return due < deferThreshold;                     // no outage history -> deferred > 6mo
  }

  // 6. Tag + include each schedule
  type DeviceTask = { scheduleId: string, taskName: string, taskCode: string, standardRef: string|null,
                      dueDate: Date|null, reason: string, status: string, condition: string };
  type Device = { assetId: string, assetName: string, equipmentType: string|null, condition: string,
                  criticalityScore: number|null, hasOpenWO: boolean, tasks: DeviceTask[] };
  type Equipment = { equipmentId: string, equipmentName: string, equipmentType: string|null,
                     isFeeder: boolean, devices: Record<string, Device> };
  type Location = { siteId: string, siteName: string, equipment: Record<string, Equipment> };

  const locations: Record<string, Location> = {};
  let dueCount = 0, overdueCount = 0, carryOverCount = 0, opportunisticCount = 0, pulledForwardCount = 0;
  const monthBuckets = new Set<string>();   // distinct (site|YYYY-MM) of effective work => "separate shutdowns avoided"

  for (const s of active) {
    const due = s.nextDueDate ? new Date(s.nextDueDate) : null;
    const overdue   = !!due && due < now;
    const dueInWin  = !!due && due <= targetDate;
    const carry     = isCarryOver(s);
    // opportunistic = asset is de-energized in scope (true for every in-scope
    // outage schedule); only the "reason" of last resort.
    const opportunistic = true;

    const included =
      (rules.dueByDate && dueInWin) ||
      (rules.carryOver && carry) ||
      (rules.opportunistic && opportunistic);
    if (!included) continue;

    // primary reason (precedence: overdue > carry-over > due > opportunistic)
    let reason: string;
    if (overdue && (rules.dueByDate || rules.carryOver)) reason = 'overdue';
    else if (carry && rules.carryOver)                   reason = 'carry-over';
    else if (dueInWin && rules.dueByDate)                reason = 'due';
    else                                                 reason = 'opportunistic';

    const condition = s.conditionOverride || s.asset.governingCondition || 'C2';

    // Advanced filters narrow ONLY the opportunistic dragnet — never hide
    // genuinely due / overdue / carry-over work.
    if (reason === 'opportunistic') {
      if (filters.minCondition && (CONDITION_RANK[condition] || 0) < (CONDITION_RANK[filters.minCondition] || 0)) continue;
      if (filters.minCriticality != null && (s.asset.criticalityScore || 0) < filters.minCriticality) continue;
      if (filters.standard && !(s.taskDefinition.standardRef || '').toLowerCase().includes(filters.standard.toLowerCase())) continue;
    }

    // tally
    if (reason === 'overdue') overdueCount++;
    else if (reason === 'carry-over') carryOverCount++;
    else if (reason === 'due') dueCount++;
    else opportunisticCount++;
    if (!dueInWin) pulledForwardCount++;   // not yet due by the target date = pulled forward

    const site = s.asset.site;
    const siteId = site?.id ?? '__no_site__';
    const siteName = site?.name ?? 'No site';
    const ym = due ? `${siteId}|${due.getFullYear()}-${due.getMonth()}` : `${siteId}|future`;
    monthBuckets.add(ym);

    if (!locations[siteId]) locations[siteId] = { siteId, siteName, equipment: {} };

    // Panel/Equipment node = the upstream feeder if present, else the device itself
    const feeder = s.asset.fedFrom;
    const eqId = feeder?.id ?? `self:${s.asset.id}`;
    if (!locations[siteId].equipment[eqId]) {
      locations[siteId].equipment[eqId] = {
        equipmentId: eqId,
        equipmentName: feeder ? assetLabel(feeder) : assetLabel(s.asset),
        equipmentType: feeder ? feeder.equipmentType : s.asset.equipmentType,
        isFeeder: !!feeder,
        devices: {},
      };
    }
    const eq = locations[siteId].equipment[eqId];
    if (!eq.devices[s.asset.id]) {
      eq.devices[s.asset.id] = {
        assetId: s.asset.id,
        assetName: assetLabel(s.asset),
        equipmentType: s.asset.equipmentType,
        condition,
        criticalityScore: s.asset.criticalityScore,
        hasOpenWO: s.asset.workOrders.length > 0,
        tasks: [],
      };
    }
    eq.devices[s.asset.id].tasks.push({
      scheduleId: s.id,
      taskName: s.taskDefinition.taskName,
      taskCode: s.taskDefinition.taskCode,
      standardRef: s.taskDefinition.standardRef,
      dueDate: s.nextDueDate,
      reason,
      status: taskStatus(s.nextDueDate),
      condition,
    });
  }

  // 7. Flatten + sort (overdue first, then criticality desc) and tally devices
  const REASON_ORDER: Record<string, number> = { overdue: 0, 'carry-over': 1, due: 2, opportunistic: 3 };
  let totalDevices = 0, totalTasks = 0;
  const locationsArr = Object.values(locations).map((loc) => {
    const equipmentArr = Object.values(loc.equipment).map((eq) => {
      const devicesArr = Object.values(eq.devices).map((d) => {
        d.tasks.sort((a, b) => (REASON_ORDER[a.reason] - REASON_ORDER[b.reason]) ||
          ((a.dueDate ? +new Date(a.dueDate) : Infinity) - (b.dueDate ? +new Date(b.dueDate) : Infinity)));
        totalTasks += d.tasks.length;
        return d;
      });
      devicesArr.sort((a, b) => (b.criticalityScore || 0) - (a.criticalityScore || 0) || a.assetName.localeCompare(b.assetName));
      totalDevices += devicesArr.length;
      return { equipmentId: eq.equipmentId, equipmentName: eq.equipmentName, equipmentType: eq.equipmentType,
               isFeeder: eq.isFeeder, devices: devicesArr, deviceCount: devicesArr.length,
               taskCount: devicesArr.reduce((n, d) => n + d.tasks.length, 0) };
    });
    equipmentArr.sort((a, b) => b.taskCount - a.taskCount || a.equipmentName.localeCompare(b.equipmentName));
    const locDevices = equipmentArr.reduce((n, e) => n + e.deviceCount, 0);
    const locTasks   = equipmentArr.reduce((n, e) => n + e.taskCount, 0);
    return { siteId: loc.siteId, siteName: loc.siteName, equipment: equipmentArr,
             totalDevices: locDevices, totalTasks: locTasks };
  });
  locationsArr.sort((a, b) => b.totalTasks - a.totalTasks || a.siteName.localeCompare(b.siteName));

  const sitesCount = locationsArr.length;
  // Without consolidation each distinct (site, month) of work is a separate
  // shutdown; with the plan you do one window per site on the target date.
  const shutdownsAvoided = Math.max(0, monthBuckets.size - sitesCount);

  return {
    data: {
      target: { date: targetDate.toISOString(), scopeLabel, scopeType, scopeAssetId },
      rules, filters,
      locations: locationsArr,
      summary: {
        totalDevices, totalTasks, sites: sitesCount,
        dueCount, overdueCount, carryOverCount, opportunisticCount, pulledForwardCount,
        shutdownsAvoided,
      },
      generatedAt: now.toISOString(),
    },
  };
}

// ── GET /api/outage-planner/plan ──────────────────────────────────────────────
router.get('/plan', async (req: any, res: any) => {
  try {
    const { data, error } = await buildPlan(req);
    if (error) return res.status(400).json({ success: false, error });
    return res.json({ success: true, data });
  } catch (err) {
    console.error('[outagePlanner GET /plan]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── helper: flatten plan -> one row per (device, task) for exports ─────────────
function planRows(data: any): any[] {
  const rows: any[] = [];
  for (const loc of data.locations) {
    for (const eq of loc.equipment) {
      for (const d of eq.devices) {
        for (const t of d.tasks) {
          rows.push({
            location: loc.siteName,
            equipment: eq.equipmentName + (eq.isFeeder ? '' : ' (standalone)'),
            device: d.assetName,
            deviceType: d.equipmentType,
            condition: t.condition,
            task: t.taskName,
            standard: t.standardRef,
            due: t.dueDate,
            reason: t.reason,
          });
        }
      }
    }
  }
  return rows;
}

// ── GET /api/outage-planner/plan/export.xlsx ──────────────────────────────────
router.get('/plan/export.xlsx', async (req: any, res: any) => {
  try {
    const { data, error } = await buildPlan(req);
    if (error) return res.status(400).json({ success: false, error });
    const columnDefs = [
      { id: 'done',      header: 'Done', type: 'string', get: () => '', width: 6 },
      { id: 'location',  header: 'Location', type: 'string', get: (r: any) => r.location, width: 22 },
      { id: 'equipment', header: 'Panel / Equipment', type: 'string', get: (r: any) => r.equipment, width: 26 },
      { id: 'device',    header: 'Device', type: 'string', get: (r: any) => r.device, width: 26 },
      { id: 'condition', header: 'Cond', type: 'string', get: (r: any) => r.condition, width: 8 },
      { id: 'task',      header: 'Test / Task', type: 'string', get: (r: any) => r.task, width: 34 },
      { id: 'standard',  header: 'Standard', type: 'string', get: (r: any) => r.standard, width: 20 },
      { id: 'due',       header: 'Due', type: 'date', get: (r: any) => r.due, width: 14 },
      { id: 'reason',    header: 'Why', type: 'string', get: (r: any) => r.reason, width: 14 },
    ];
    const d = new Date(data.target.date);
    const fname = `outage-plan-${d.toISOString().slice(0, 10)}.xlsx`;
    return sendXlsx(res, { sheetName: 'Outage Plan', columnDefs, rows: planRows(data), filename: fname });
  } catch (err) {
    console.error('[outagePlanner GET /plan/export.xlsx]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── GET /api/outage-planner/plan/export.pdf ───────────────────────────────────
router.get('/plan/export.pdf', async (req: any, res: any) => {
  try {
    const { data, error } = await buildPlan(req);
    if (error) return res.status(400).json({ success: false, error });

    const d = new Date(data.target.date);
    const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
    const chunks: any[] = [];
    doc.on('data', (c: any) => chunks.push(c));
    doc.on('end', () => {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="outage-plan-${d.toISOString().slice(0,10)}.pdf"`);
      res.send(Buffer.concat(chunks));
    });

    doc.fontSize(18).text('Outage Work Plan', { continued: false });
    doc.moveDown(0.2);
    doc.fontSize(11).fillColor('#555')
       .text(`Outage date: ${d.toLocaleDateString()}    Scope: ${data.target.scopeLabel}`);
    const s = data.summary;
    doc.text(`${s.totalTasks} tasks on ${s.totalDevices} devices · ${s.overdueCount} overdue · ${s.carryOverCount} carry-over · ${s.opportunisticCount} opportunistic (${s.pulledForwardCount} pulled forward)`);
    if (s.shutdownsAvoided > 0) doc.fillColor('#15803d').text(`Consolidating saves ${s.shutdownsAvoided} separate shutdown(s).`);
    doc.fillColor('#000').moveDown(0.5);

    for (const loc of data.locations) {
      doc.moveDown(0.4).fontSize(13).fillColor('#0f172a').text(loc.siteName);
      for (const eq of loc.equipment) {
        doc.moveDown(0.15).fontSize(11).fillColor('#334155')
           .text(`  ${eq.isFeeder ? '▸ ' : ''}${eq.equipmentName}${eq.isFeeder ? '' : '  (standalone)'}`);
        for (const dev of eq.devices) {
          doc.fontSize(10).fillColor('#0f172a').text(`     ${dev.assetName}  [${dev.condition}]`);
          for (const t of dev.tasks) {
            const dd = t.dueDate ? new Date(t.dueDate).toLocaleDateString() : '—';
            doc.fontSize(9).fillColor('#475569')
               .text(`        [  ]  ${t.taskName}   (${t.reason}, due ${dd})${t.standardRef ? '  ·  ' + t.standardRef : ''}`);
          }
        }
      }
    }
    doc.end();
  } catch (err) {
    console.error('[outagePlanner GET /plan/export.pdf]', err);
    if (!res.headersSent) return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── POST /api/outage-planner/commit ───────────────────────────────────────────
// Body: { date, notes?, createBlackout?:bool, selections:[{assetId, scheduleIds[]}] }
// Creates (optionally) one BlackoutWindow per site touched + one WorkOrder per
// asset (linked to a schedule), all scheduled for the outage date. Manager+.
router.post('/commit', requireManager, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const { date, notes, createBlackout = true, selections } = req.body;
    if (!date) return res.status(400).json({ success: false, error: 'date required' });
    const when = new Date(date);
    if (isNaN(when.getTime())) return res.status(400).json({ success: false, error: 'Invalid date' });
    if (!Array.isArray(selections) || selections.length === 0) {
      return res.status(400).json({ success: false, error: 'selections required (array of {assetId, scheduleIds})' });
    }

    const assetIds = [...new Set(selections.map((x: any) => String(x.assetId)))];
    const assets = await prisma.asset.findMany({
      where: { id: { in: assetIds }, accountId, archivedAt: null },
      select: { id: true, siteId: true },
    });
    if (assets.length !== assetIds.length) {
      return res.status(400).json({ success: false, error: 'One or more assets not found in this account' });
    }
    const siteByAsset = new Map(assets.map((a: any) => [a.id, a.siteId]));

    // SECURITY (cross-tenant nested-write): WorkOrder.scheduleId is a raw FK with
    // no account constraint, and the WO COMPLETE transition rolls the linked
    // schedule forward by id alone (routes/workOrders.ts). An unvalidated
    // scheduleId in the body therefore lets a manager pin ANOTHER tenant's
    // schedule onto their own WO and corrupt that tenant's NFPA/NETA due dates
    // on completion. Validate every submitted scheduleId belongs to this account
    // AND to the asset it is paired with before any of it is written.
    const allSchedIds = [...new Set(
      selections.flatMap((s: any) => Array.isArray(s.scheduleIds) ? s.scheduleIds.map(String) : [])
    )];
    const ownedSchedules = allSchedIds.length
      ? await prisma.maintenanceSchedule.findMany({
          where: { id: { in: allSchedIds }, accountId },
          select: { id: true, assetId: true },
        })
      : [];
    const schedAssetById = new Map(ownedSchedules.map((s: any) => [s.id, s.assetId]));
    for (const sel of selections) {
      const selAssetId = String(sel.assetId);
      const ids = Array.isArray(sel.scheduleIds) ? sel.scheduleIds.map(String) : [];
      for (const sid of ids) {
        if (schedAssetById.get(sid) !== selAssetId) {
          return res.status(400).json({ success: false, error: 'One or more schedules not found for the specified asset in this account' });
        }
      }
    }

    // 1. One BlackoutWindow per distinct site (full-day planned shutdown).
    const blackouts: any[] = [];
    if (createBlackout) {
      const siteIds = [...new Set(assets.map((a: any) => a.siteId))];
      const startsAt = new Date(when); startsAt.setHours(0, 0, 0, 0);
      const endsAt   = new Date(when); endsAt.setHours(23, 59, 59, 999);
      for (const siteId of siteIds) {
        const bw = await prisma.blackoutWindow.create({
          data: { accountId, siteId, startsAt, endsAt, isOutageWindow: true,
                  reason: notes ? `Planned outage — ${notes}` : 'Planned outage (Outage Planner)' },
          select: { id: true, siteId: true, startsAt: true },
        });
        blackouts.push(bw);
      }
    }

    // 2. One WorkOrder per asset, linked to its first selected schedule.
    const workOrders: any[] = [];
    for (const sel of selections) {
      const assetId = String(sel.assetId);
      const scheduleIds = Array.isArray(sel.scheduleIds) ? sel.scheduleIds.map(String) : [];
      const wo = await prisma.workOrder.create({
        data: {
          accountId, assetId,
          scheduleId: scheduleIds[0] || null,
          scheduledDate: when,
          status: 'SCHEDULED',
          // [outage-sched:...] marker lets the WO COMPLETE transition roll EVERY
          // task on this device forward (gem V1 — close the outage loop), not
          // just the primary scheduleId.
          notes: `Outage plan ${when.toISOString().slice(0,10)} — ${scheduleIds.length} task(s)` +
                 (scheduleIds.length ? `\n[outage-sched:${scheduleIds.join(',')}]` : '') +
                 (notes ? `\n${notes}` : ''),
        },
        select: { id: true, assetId: true },
      });
      workOrders.push(wo);
    }

    return res.status(201).json({
      success: true,
      data: { blackoutWindows: blackouts, workOrders, blackoutCount: blackouts.length, workOrderCount: workOrders.length },
    });
  } catch (err) {
    console.error('[outagePlanner POST /commit]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// LEGACY ENDPOINTS (unchanged behavior, kept for back-compat)
// ════════════════════════════════════════════════════════════════════════════

router.get('/summary', async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;
    const now       = new Date();
    const windowEnd = new Date(now.getTime() + WINDOW_DAYS * DAY_MS);
    const windowStart = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);

    const schedules = await prisma.maintenanceSchedule.findMany({
      where: {
        accountId,
        isActive: true,
        taskDefinition: { requiresOutage: true },
        OR: [
          { nextDueDate: { gte: windowStart, lte: windowEnd } },
          { nextDueDate: { lt: now } },
        ],
      },
      select: {
        id: true, nextDueDate: true, assetId: true,
        taskDefinition: { select: { id: true, taskName: true, taskCode: true, standardRef: true, requiresOutage: true, intervalC2Months: true } },
        asset: {
          select: {
            id: true, manufacturer: true, model: true, serialNumber: true, equipmentType: true,
            criticalityScore: true, archivedAt: true, inService: true,
            site: { select: { id: true, name: true } },
            workOrders: { where: { status: { in: ['SCHEDULED', 'IN_PROGRESS'] } }, select: { id: true, status: true }, take: 1 },
          },
        },
      },
    });

    const active = schedules.filter((s: any) => !s.asset.archivedAt);
    const siteMap: Record<string, any> = {};
    for (const s of active) {
      const site   = s.asset.site;
      const siteId = site?.id ?? '__no_site__';
      if (!siteMap[siteId]) siteMap[siteId] = { siteId, siteName: site?.name ?? 'No site', assetMap: {} };
      const assetId = s.asset.id;
      if (!siteMap[siteId].assetMap[assetId]) {
        siteMap[siteId].assetMap[assetId] = {
          assetId, assetName: assetLabel(s.asset), equipmentType: s.asset.equipmentType,
          criticalityScore: s.asset.criticalityScore, inService: s.asset.inService,
          hasOpenWO: s.asset.workOrders.length > 0, tasks: [],
        };
      }
      siteMap[siteId].assetMap[assetId].tasks.push({
        scheduleId: s.id, taskName: s.taskDefinition.taskName, taskCode: s.taskDefinition.taskCode,
        standardRef: s.taskDefinition.standardRef, dueDate: s.nextDueDate, status: taskStatus(s.nextDueDate),
      });
    }

    const sites = Object.values(siteMap).map((site: any) => {
      const assets = Object.values(site.assetMap) as any[];
      for (const a of assets) {
        a.tasks.sort((x: any, y: any) => {
          const order: Record<string, number> = { overdue: 0, due: 1, upcoming: 2 };
          const diff = (order[x.status] ?? 2) - (order[y.status] ?? 2);
          if (diff !== 0) return diff;
          return (x.dueDate ? new Date(x.dueDate).getTime() : 0) - (y.dueDate ? new Date(y.dueDate).getTime() : 0);
        });
      }
      assets.sort((a, b) => {
        const aOverdue = a.tasks.some((t: any) => t.status === 'overdue') ? 0 : 1;
        const bOverdue = b.tasks.some((t: any) => t.status === 'overdue') ? 0 : 1;
        if (aOverdue !== bOverdue) return aOverdue - bOverdue;
        return (b.criticalityScore ?? 0) - (a.criticalityScore ?? 0);
      });
      const totalTasks       = assets.reduce((n: number, a: any) => n + a.tasks.length, 0);
      const overdueTasks     = assets.reduce((n: number, a: any) => n + a.tasks.filter((t: any) => t.status === 'overdue').length, 0);
      const shutdownsAvoided = Math.max(0, assets.length - 1);
      return { siteId: site.siteId, siteName: site.siteName, assets, totalAssets: assets.length, totalTasks, overdueTasks, shutdownsAvoided };
    });
    sites.sort((a: any, b: any) => (b.overdueTasks - a.overdueTasks) || (b.totalAssets - a.totalAssets));
    const totalShutdownsAvoided = sites.reduce((n: number, s: any) => n + s.shutdownsAvoided, 0);

    return res.json({ success: true, data: { sites, totalShutdownsAvoided, generatedAt: now.toISOString() } });
  } catch (err) {
    console.error('[outagePlanner GET /summary]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

router.post('/work-order', requireManager, async (req: any, res: any) => {
  try {
    const { siteId, scheduledDate, notes, assetSchedules } = req.body;
    const accountId = req.user.accountId;
    if (!scheduledDate) return res.status(400).json({ success: false, error: 'scheduledDate required' });
    if (!Array.isArray(assetSchedules) || assetSchedules.length === 0) {
      return res.status(400).json({ success: false, error: 'assetSchedules required (array of {assetId, scheduleIds})' });
    }
    const date = new Date(scheduledDate);
    if (isNaN(date.getTime())) return res.status(400).json({ success: false, error: 'Invalid scheduledDate' });
    const assetIds = assetSchedules.map((a: any) => String(a.assetId));
    const assets   = await prisma.asset.findMany({ where: { id: { in: assetIds }, accountId, archivedAt: null }, select: { id: true } });
    if (assets.length !== assetIds.length) return res.status(400).json({ success: false, error: 'One or more assets not found in this account' });

    // SECURITY (cross-tenant nested-write): mirror /commit — validate every
    // submitted scheduleId belongs to this account AND its paired asset before
    // writing it onto a WorkOrder.scheduleId FK (see /commit note above).
    const allSchedIds = [...new Set(
      assetSchedules.flatMap((a: any) => Array.isArray(a.scheduleIds) ? a.scheduleIds.map(String) : [])
    )];
    const ownedSchedules = allSchedIds.length
      ? await prisma.maintenanceSchedule.findMany({
          where: { id: { in: allSchedIds }, accountId },
          select: { id: true, assetId: true },
        })
      : [];
    const schedAssetById = new Map(ownedSchedules.map((s: any) => [s.id, s.assetId]));
    for (const { assetId, scheduleIds } of assetSchedules) {
      const ids = Array.isArray(scheduleIds) ? scheduleIds.map(String) : [];
      for (const sid of ids) {
        if (schedAssetById.get(sid) !== String(assetId)) {
          return res.status(400).json({ success: false, error: 'One or more schedules not found for the specified asset in this account' });
        }
      }
    }
    const created = [];
    for (const { assetId, scheduleIds } of assetSchedules) {
      const primaryScheduleId = Array.isArray(scheduleIds) && scheduleIds.length > 0 ? scheduleIds[0] : null;
      const wo = await prisma.workOrder.create({
        data: {
          accountId, assetId: String(assetId),
          scheduleId: primaryScheduleId ? String(primaryScheduleId) : null,
          scheduledDate: date,
          notes: notes ? `[Outage consolidation — ${assetSchedules.length} asset(s)] ${notes}`
                       : `Outage consolidation — ${assetSchedules.length} asset(s) in one planned outage`,
          status: 'SCHEDULED',
        },
        select: { id: true, assetId: true, scheduledDate: true },
      });
      created.push(wo);
    }
    return res.status(201).json({ success: true, data: { workOrders: created, count: created.length } });
  } catch (err) {
    console.error('[outagePlanner POST /work-order]', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;

export {};
