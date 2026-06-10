/**
 * /api/work-orders — contractor maintenance/testing jobs.
 *
 * A WorkOrder is one visit by a contractor (or in-house crew) against one
 * asset, optionally born from a MaintenanceSchedule. The lifecycle is a
 * strict state machine:
 *
 *   SCHEDULED ──→ IN_PROGRESS ──→ COMPLETE
 *        │              │
 *        └──────────────┴───────→ CANCELLED
 *
 * COMPLETE is where the NFPA 70B loop closes:
 *   1. completedDate stamps the job (defaults to now)
 *   2. as-found / as-left condition + NETA decal are recorded (NETA MTS
 *      requires both as-found and as-left state on the test record)
 *   3. an as-left condition writes asset.conditionPhysical and recomputes
 *      asset.governingCondition (worst of the three NFPA 70B axes)
 *   4. the linked schedule rolls forward via recomputeScheduleDates — the
 *      SAME helper POST /schedules/:id/complete uses, evaluated against the
 *      asset's NEW condition so a degraded as-left immediately compresses
 *      the next interval
 * Steps 2–4 run in one transaction; a crash can't leave a completed work
 * order with a stale schedule.
 *
 * Child records (test measurements, deficiencies, lab samples) are managed
 * through nested endpoints here; account-wide deficiency views live in
 * routes/deficiencies.ts.
 *
 * Mounted behind authenticateToken in index.ts. Every query filters
 * accountId = req.user.accountId. Writes are manager+ (requireManager).
 */

const router = require('express').Router();
const { z } = require('zod');
const { requireManager } = require('../middleware/roles');
const { validateBody, UuidStr, emptyToUndef } = require('../lib/validate');
const { writeLog: writeActivityLog } = require('../lib/activityLog');
const { recomputeScheduleDates, worstCondition } = require('../lib/maintenanceInterval');
const prisma = require('../lib/prisma').default;
// Prisma.DbNull — clearing a nullable Json column (testEquipment) requires the
// sentinel; a plain JS null is rejected by the client for Json fields.
const { Prisma } = require('@prisma/client');

// App-layer enum guards — bad strings 400 instead of throwing Prisma errors.
const WO_STATUSES      = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETE', 'CANCELLED'];
const CONDITIONS       = ['C1', 'C2', 'C3'];
const RESULT_RATINGS   = ['GREEN', 'YELLOW', 'RED'];
const NETA_CERT_LEVELS = ['LEVEL_I', 'LEVEL_II', 'LEVEL_III', 'LEVEL_IV'];
const SEVERITIES       = ['IMMEDIATE', 'RECOMMENDED', 'ADVISORY'];

// Legal lifecycle transitions. COMPLETE and CANCELLED are terminal.
const ALLOWED_TRANSITIONS: any = {
  SCHEDULED:   ['IN_PROGRESS', 'COMPLETE', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETE', 'CANCELLED'],
  COMPLETE:    [],
  CANCELLED:   [],
};

const DateLike = z.preprocess(emptyToUndef, z.union([z.string(), z.date()]).nullable().optional());

// ── Test-condition + instrument provenance (NETA MTS §5.4.2 #4, §5.3) ────────
// Calibrated instrument list: max 10 entries, each field a string ≤200 chars,
// no extra keys. Shared between the POST zod schema and the manual PUT path
// so the two can't drift.
const TestEquipmentSchema = z.array(
  z.object({
    make:    z.string().max(200).nullable().optional(),
    model:   z.string().max(200).nullable().optional(),
    serial:  z.string().max(200).nullable().optional(),
    calDate: z.string().max(200).nullable().optional(),
  }).strict()
).max(10);

// Ambient readings arrive as number or numeric string from the SPA; final
// numeric coercion happens in the handlers via toDecimal.
const NumLike = z.preprocess(emptyToUndef, z.union([z.number(), z.string()]).nullable().optional());

// number | numeric-string | '' | null → number | null; undefined = invalid.
function toDecimal(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isNaN(n) ? undefined : n;
}

const CreateWorkOrderSchema = z.object({
  assetId:        UuidStr,
  scheduleId:     UuidStr.nullable().optional().or(z.literal('')),
  contractorId:   UuidStr.nullable().optional().or(z.literal('')),
  assignedTechId: UuidStr.nullable().optional().or(z.literal('')),
  netaCertLevel:  z.enum(NETA_CERT_LEVELS).nullable().optional().or(z.literal('')),
  scheduledDate:  DateLike,
  ambientTempC:   NumLike,
  humidityPct:    NumLike,
  testEquipment:  TestEquipmentSchema.nullable().optional(),
  notes:          z.string().max(4000).nullable().optional(),
}).strict();

// Shared include for the list view.
const listInclude = {
  asset: {
    select: {
      id: true, equipmentType: true, manufacturer: true, model: true,
      serialNumber: true, site: { select: { id: true, name: true } },
    },
  },
  contractor:   { select: { id: true, name: true, netaAccredited: true } },
  assignedTech: { select: { id: true, name: true, netaCertLevel: true } },
  schedule: {
    select: {
      id: true,
      taskDefinition: { select: { id: true, taskName: true, taskCode: true } },
    },
  },
};

// ─── GET /api/work-orders ─────────────────────────────────────────────────────
// Filters: status, assetId, siteId (via the asset join), contractorId,
// scheduledFrom / scheduledTo (scheduled date range, inclusive).
// Default sort: scheduledDate descending (most recent activity first).
router.get('/', async (req, res) => {
  try {
    const {
      status, assetId, siteId, contractorId,
      scheduledFrom, scheduledTo,
      page = 1, limit = 50,
    } = req.query;

    const take = Math.min(Math.max(parseInt(limit) || 50, 1), 200);
    const pageNum = Math.max(parseInt(page) || 1, 1);
    const skip = (pageNum - 1) * take;

    const where: any = { accountId: req.user.accountId };
    if (status) {
      if (!WO_STATUSES.includes(String(status))) {
        return res.status(400).json({ success: false, error: `status must be one of ${WO_STATUSES.join(', ')}` });
      }
      where.status = status;
    }
    if (assetId)      where.assetId = String(assetId);
    if (siteId)       where.asset = { siteId: String(siteId) };
    if (contractorId) where.contractorId = String(contractorId);
    if (scheduledFrom || scheduledTo) {
      const range: any = {};
      if (scheduledFrom) {
        const from = new Date(String(scheduledFrom));
        if (Number.isNaN(from.getTime())) return res.status(400).json({ success: false, error: 'Invalid scheduledFrom' });
        range.gte = from;
      }
      if (scheduledTo) {
        const to = new Date(String(scheduledTo));
        if (Number.isNaN(to.getTime())) return res.status(400).json({ success: false, error: 'Invalid scheduledTo' });
        range.lte = to;
      }
      where.scheduledDate = range;
    }

    const [workOrders, total] = await Promise.all([
      prisma.workOrder.findMany({
        where,
        include: listInclude,
        orderBy: [{ scheduledDate: 'desc' }],
        skip,
        take,
      }),
      prisma.workOrder.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        workOrders,
        pagination: { page: pageNum, limit: take, total, pages: Math.ceil(total / take) },
      },
    });
  } catch (err) {
    console.error('List work orders error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch work orders' });
  }
});

// ─── GET /api/work-orders/priority-queue ─────────────────────────────────────
// Top 10 un-archived assets ranked by DPS (priorityScore DESC) that have no
// open (SCHEDULED or IN_PROGRESS) work order. Used by the Priority Queue panel
// on the Work Orders page. Must be defined BEFORE /:id so Express doesn't
// capture "priority-queue" as an id param.
router.get('/priority-queue', async (req, res) => {
  try {
    // Collect all assetIds that already have an open work order (one query).
    const openRows = await prisma.workOrder.findMany({
      where: {
        accountId: req.user.accountId,
        status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
      },
      select: { assetId: true },
      distinct: ['assetId'],
    });
    const excludeIds = openRows.map((r: any) => r.assetId);

    const assets = await prisma.asset.findMany({
      where: {
        accountId:    req.user.accountId,
        archivedAt:   null,
        priorityScore: { not: null },
        ...(excludeIds.length > 0 ? { NOT: { id: { in: excludeIds } } } : {}),
      },
      orderBy: { priorityScore: 'desc' },
      take: 10,
      select: {
        id:               true,
        equipmentType:    true,
        manufacturer:     true,
        model:            true,
        serialNumber:     true,
        priorityScore:    true,
        conditionScore:   true,
        criticalityScore: true,
        inService:        true,
        site: { select: { id: true, name: true } },
      },
    });

    res.json({ success: true, data: { assets } });
  } catch (err) {
    console.error('Priority queue error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch priority queue' });
  }
});

// ─── GET /api/work-orders/:id ─────────────────────────────────────────────────
// Full job record: measurements, deficiencies, lab samples, attached documents.
router.get('/:id', async (req, res) => {
  try {
    const workOrder = await prisma.workOrder.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
      include: {
        ...listInclude,
        schedule: {
          select: {
            id: true, lastCompletedDate: true, nextDueDate: true, conditionOverride: true,
            taskDefinition: {
              select: {
                id: true, taskName: true, taskCode: true, standardRef: true,
                requiresOutage: true, requiresEnergized: true,
                requiresNetaCertified: true, netaCertLevelMin: true,
              },
            },
          },
        },
        measurements: { orderBy: [{ createdAt: 'asc' }] },
        deficiencies: {
          orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
          include: { resolvedBy: { select: { id: true, name: true } } },
        },
        labSamples: { orderBy: [{ sampleDate: 'desc' }] },
        documents: {
          select: { id: true, filename: true, fileType: true, version: true, uploadedAt: true },
          orderBy: [{ uploadedAt: 'desc' }],
        },
      },
    });

    if (!workOrder) {
      return res.status(404).json({ success: false, error: 'Work order not found' });
    }

    res.json({ success: true, data: { workOrder } });
  } catch (err) {
    console.error('Get work order error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch work order' });
  }
});

// ── Shared assignment validators ─────────────────────────────────────────────
// Contractor must belong to the account; tech must belong to the contractor.
// Both return null on success, or an error string the caller turns into a 400/404.
async function validateContractor(accountId, contractorId) {
  const contractor = await prisma.contractor.findFirst({
    where: { id: contractorId, accountId },
    select: { id: true },
  });
  return contractor ? null : 'Contractor not found';
}

async function validateTech(accountId, contractorId, assignedTechId) {
  if (!contractorId) return 'assignedTechId requires a contractorId';
  const tech = await prisma.contractorTech.findFirst({
    where: { id: assignedTechId, contractorId, contractor: { accountId } },
    select: { id: true },
  });
  return tech ? null : 'Assigned tech not found on that contractor';
}

// ─── POST /api/work-orders ────────────────────────────────────────────────────
// Create a job. assetId is required and ownership-checked; the optional
// scheduleId must belong to the SAME asset (a job can't satisfy another
// asset's recurrence). When the work order is born from a schedule and the
// body doesn't pin a cert level, the task definition's netaCertLevelMin is
// copied onto the work order — schema documents netaCertLevel as "from the
// task definition at creation time; editable".
router.post('/', requireManager, async (req, res) => {
  const parsed = validateBody(req, res, CreateWorkOrderSchema);
  if (!parsed) return;
  try {
    const { assetId, scheduledDate, notes } = parsed;
    const scheduleId     = parsed.scheduleId || null;
    const contractorId   = parsed.contractorId || null;
    const assignedTechId = parsed.assignedTechId || null;
    let   netaCertLevel  = parsed.netaCertLevel || null;

    const asset = await prisma.asset.findFirst({
      where: { id: assetId, accountId: req.user.accountId },
      select: { id: true },
    });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    let schedule = null;
    if (scheduleId) {
      schedule = await prisma.maintenanceSchedule.findFirst({
        where: { id: scheduleId, accountId: req.user.accountId, assetId: asset.id },
        include: { taskDefinition: { select: { netaCertLevelMin: true } } },
      });
      if (!schedule) {
        return res.status(404).json({ success: false, error: 'Schedule not found for this asset' });
      }
      if (!netaCertLevel && schedule.taskDefinition.netaCertLevelMin) {
        netaCertLevel = schedule.taskDefinition.netaCertLevelMin;
      }
    }

    if (contractorId) {
      const cErr = await validateContractor(req.user.accountId, contractorId);
      if (cErr) return res.status(404).json({ success: false, error: cErr });
    }
    if (assignedTechId) {
      const tErr = await validateTech(req.user.accountId, contractorId, assignedTechId);
      if (tErr) return res.status(400).json({ success: false, error: tErr });
    }

    const when = scheduledDate ? new Date(scheduledDate) : null;
    if (when && Number.isNaN(when.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid scheduledDate' });
    }

    // Test-condition provenance — zod gated the container shapes above;
    // toDecimal rejects non-numeric ambient strings here.
    const ambientTempC = toDecimal(parsed.ambientTempC);
    if (ambientTempC === undefined) {
      return res.status(400).json({ success: false, error: 'ambientTempC must be numeric' });
    }
    const humidityPct = toDecimal(parsed.humidityPct);
    if (humidityPct === undefined) {
      return res.status(400).json({ success: false, error: 'humidityPct must be numeric' });
    }

    const workOrder = await prisma.workOrder.create({
      data: {
        accountId:     req.user.accountId,
        assetId:       asset.id,
        scheduleId,
        contractorId,
        assignedTechId,
        netaCertLevel,
        scheduledDate: when,
        ambientTempC,
        humidityPct,
        testEquipment: parsed.testEquipment ?? undefined,
        notes:         notes || null,
        // status defaults to SCHEDULED in the schema
      },
      include: listInclude,
    });

    writeActivityLog({
      assetId:   asset.id,
      userId:    req.user.id,
      accountId: req.user.accountId,
      action:    'work_order_created',
      details:   { workOrderId: workOrder.id, scheduleId, contractorId, scheduledDate: when },
    });

    res.status(201).json({ success: true, data: { workOrder } });
  } catch (err) {
    console.error('Create work order error:', err);
    res.status(500).json({ success: false, error: 'Failed to create work order' });
  }
});

// ─── PUT /api/work-orders/:id ─────────────────────────────────────────────────
// Field updates + status transitions (see file header for the state machine
// and what the COMPLETE transition does).
router.put('/:id', requireManager, async (req, res) => {
  try {
    const existing = await prisma.workOrder.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
      include: {
        schedule: { include: { taskDefinition: true } },
        asset:    true,
      },
    });
    if (!existing) return res.status(404).json({ success: false, error: 'Work order not found' });

    const {
      status, scheduledDate, completedDate, notes, reportPdfUrl,
      contractorId, assignedTechId, netaCertLevel,
      asFoundCondition, asLeftCondition, netaDecal,
      ambientTempC, humidityPct, testEquipment,
    } = req.body;

    // ── Enum guards ───────────────────────────────────────────────────────────
    if (status !== undefined && !WO_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: `status must be one of ${WO_STATUSES.join(', ')}` });
    }
    for (const [field, value, allowed] of [
      ['asFoundCondition', asFoundCondition, CONDITIONS],
      ['asLeftCondition',  asLeftCondition,  CONDITIONS],
      ['netaDecal',        netaDecal,        RESULT_RATINGS],
      ['netaCertLevel',    netaCertLevel,    NETA_CERT_LEVELS],
    ] as any[]) {
      if (value !== undefined && value !== null && value !== '' && !allowed.includes(value)) {
        return res.status(400).json({ success: false, error: `${field} must be one of ${allowed.join(', ')}` });
      }
    }

    // ── Assignment validation ─────────────────────────────────────────────────
    const effectiveContractorId = contractorId !== undefined
      ? (contractorId || null)
      : existing.contractorId;
    if (contractorId !== undefined && contractorId) {
      const cErr = await validateContractor(req.user.accountId, contractorId);
      if (cErr) return res.status(404).json({ success: false, error: cErr });
    }
    if (assignedTechId !== undefined && assignedTechId) {
      const tErr = await validateTech(req.user.accountId, effectiveContractorId, assignedTechId);
      if (tErr) return res.status(400).json({ success: false, error: tErr });
    }

    const updateData: any = {};
    if (scheduledDate !== undefined) {
      const when = scheduledDate ? new Date(scheduledDate) : null;
      if (when && Number.isNaN(when.getTime())) {
        return res.status(400).json({ success: false, error: 'Invalid scheduledDate' });
      }
      updateData.scheduledDate = when;
    }
    if (notes !== undefined)            updateData.notes = notes || null;
    if (reportPdfUrl !== undefined)     updateData.reportPdfUrl = reportPdfUrl || null;
    if (contractorId !== undefined)     updateData.contractorId = contractorId || null;
    if (assignedTechId !== undefined)   updateData.assignedTechId = assignedTechId || null;
    if (netaCertLevel !== undefined)    updateData.netaCertLevel = netaCertLevel || null;
    if (asFoundCondition !== undefined) updateData.asFoundCondition = asFoundCondition || null;
    if (asLeftCondition !== undefined)  updateData.asLeftCondition = asLeftCondition || null;
    if (netaDecal !== undefined)        updateData.netaDecal = netaDecal || null;

    // ── Test-condition + instrument provenance ────────────────────────────────
    if (ambientTempC !== undefined) {
      const n = toDecimal(ambientTempC);
      if (n === undefined) return res.status(400).json({ success: false, error: 'ambientTempC must be numeric' });
      updateData.ambientTempC = n;
    }
    if (humidityPct !== undefined) {
      const n = toDecimal(humidityPct);
      if (n === undefined) return res.status(400).json({ success: false, error: 'humidityPct must be numeric' });
      updateData.humidityPct = n;
    }
    if (testEquipment !== undefined) {
      if (testEquipment === null || (Array.isArray(testEquipment) && testEquipment.length === 0)) {
        updateData.testEquipment = Prisma.DbNull;
      } else {
        const te = TestEquipmentSchema.safeParse(testEquipment);
        if (!te.success) {
          return res.status(400).json({
            success: false,
            error: 'testEquipment must be an array of up to 10 { make, model, serial, calDate } entries, each a string of 200 characters or fewer',
          });
        }
        updateData.testEquipment = te.data;
      }
    }

    // ── Status transitions ────────────────────────────────────────────────────
    const transitioning = status !== undefined && status !== existing.status;
    if (transitioning) {
      const allowed = ALLOWED_TRANSITIONS[existing.status] || [];
      if (!allowed.includes(status)) {
        return res.status(400).json({
          success: false,
          error: `Cannot transition a ${existing.status} work order to ${status}`,
        });
      }
      updateData.status = status;

      if (status === 'IN_PROGRESS' && !existing.startedAt) {
        updateData.startedAt = new Date();
      }
    }

    // ── COMPLETE: the heavy transition ───────────────────────────────────────
    if (transitioning && status === 'COMPLETE') {
      const completedAt = completedDate ? new Date(completedDate) : new Date();
      if (Number.isNaN(completedAt.getTime())) {
        return res.status(400).json({ success: false, error: 'Invalid completedDate' });
      }
      updateData.completedDate = completedAt;
      // A job completed without ever being flipped to IN_PROGRESS still gets
      // a startedAt so duration reporting never divides by null.
      if (!existing.startedAt && !updateData.startedAt) updateData.startedAt = completedAt;

      // Resolve the as-left condition in play: body value wins, falling back
      // to anything previously stored on the work order.
      const finalAsLeft = (asLeftCondition !== undefined ? (asLeftCondition || null) : existing.asLeftCondition);

      // New governing condition if an as-left was recorded — worst of the
      // three NFPA 70B axes with conditionPhysical replaced by the as-left.
      let newGoverning = null;
      if (finalAsLeft) {
        newGoverning = worstCondition(
          finalAsLeft,
          existing.asset.conditionCriticality,
          existing.asset.conditionEnvironment
        );
      }

      // Asset snapshot reflecting the post-completion condition — passed to
      // recomputeScheduleDates so the next interval is chosen from the
      // asset's NEW state, not its pre-test one.
      const assetAfter = newGoverning
        ? { ...existing.asset, conditionPhysical: finalAsLeft, governingCondition: newGoverning }
        : existing.asset;

      const ops = [];

      // 1. Asset condition write (when an as-left condition was recorded).
      if (finalAsLeft) {
        ops.push(prisma.asset.update({
          where: { id: existing.assetId },
          data: { conditionPhysical: finalAsLeft, governingCondition: newGoverning },
        }));
      }

      // 2. Schedule roll-forward (when the job was born from a schedule).
      if (existing.scheduleId && existing.schedule) {
        const { lastCompletedDate, nextDueDate } = recomputeScheduleDates(
          existing.schedule.taskDefinition, assetAfter, existing.schedule, completedAt
        );

        // Provenance: who actually performed the work. Effective assignment
        // (body value wins over stored) → "Tech Name — Contractor Name" when
        // both are known, contractor name alone otherwise. Only written when
        // a name resolves, so an unassigned completion doesn't clobber an
        // earlier manual provenance entry.
        const effTechId = assignedTechId !== undefined ? (assignedTechId || null) : existing.assignedTechId;
        let performedByName = null;
        if (effTechId) {
          const tech = await prisma.contractorTech.findFirst({
            where:  { id: effTechId, contractor: { accountId: req.user.accountId } },
            select: { name: true, contractor: { select: { name: true } } },
          });
          if (tech) {
            performedByName = tech.contractor?.name ? `${tech.name} — ${tech.contractor.name}` : tech.name;
          }
        }
        if (!performedByName && effectiveContractorId) {
          const c = await prisma.contractor.findFirst({
            where:  { id: effectiveContractorId, accountId: req.user.accountId },
            select: { name: true },
          });
          if (c) performedByName = c.name;
        }

        ops.push(prisma.maintenanceSchedule.update({
          where: { id: existing.scheduleId },
          data: {
            lastCompletedDate,
            nextDueDate,
            ...(performedByName ? { lastPerformedByName: performedByName.slice(0, 200) } : {}),
          },
        }));
      }

      // 3. The work order itself.
      ops.push(prisma.workOrder.update({
        where: { id: existing.id },
        data: updateData,
        include: listInclude,
      }));

      const results = await prisma.$transaction(ops);
      const workOrder = results[results.length - 1];

      // Audit trail — fire-and-forget, never blocks the response.
      writeActivityLog({
        assetId:   existing.assetId,
        userId:    req.user.id,
        accountId: req.user.accountId,
        action:    'work_order_completed',
        details: {
          workOrderId:   existing.id,
          scheduleId:    existing.scheduleId,
          completedDate: completedAt,
          asFoundCondition: updateData.asFoundCondition ?? existing.asFoundCondition ?? null,
          asLeftCondition:  finalAsLeft,
          netaDecal:        updateData.netaDecal ?? existing.netaDecal ?? null,
        },
      });
      if (finalAsLeft && newGoverning !== existing.asset.governingCondition) {
        writeActivityLog({
          assetId:   existing.assetId,
          userId:    req.user.id,
          accountId: req.user.accountId,
          action:    'condition_changed',
          details: {
            workOrderId: existing.id,
            from:        existing.asset.governingCondition,
            to:          newGoverning,
            axis:        'conditionPhysical',
            source:      'work_order_as_left',
          },
        });
      }

      // Partner Flywheel: emit INSPECTION_COMPLETED (fire-and-forget)
      {
        const { emitPartnerEvent } = require('../lib/partnerEvents');
        const openDefs = await prisma.deficiency.findMany({
          where: { accountId: req.user.accountId, assetId: existing.assetId, resolvedAt: null },
          select: { severity: true },
        });
        const immediateCount = openDefs.filter((d: any) => d.severity === 'IMMEDIATE').length;
        emitPartnerEvent(req.user.accountId, 'INSPECTION_COMPLETED', {
          assetId:         existing.assetId,
          assetName:       existing.asset?.name ?? 'Asset',
          deficiencyCount: openDefs.length,
          immediateCount,
        }).catch(console.error);
      }

      return res.json({ success: true, data: { workOrder } });
    }

    // ── Non-COMPLETE path (field edits, IN_PROGRESS, CANCELLED) ─────────────
    // completedDate is only writable through the COMPLETE transition; allow a
    // correction on an already-COMPLETE job, though.
    if (completedDate !== undefined && existing.status === 'COMPLETE' && !transitioning) {
      const when = completedDate ? new Date(completedDate) : null;
      if (when && Number.isNaN(when.getTime())) {
        return res.status(400).json({ success: false, error: 'Invalid completedDate' });
      }
      updateData.completedDate = when;
    }

    const workOrder = await prisma.workOrder.update({
      where: { id: existing.id },
      data: updateData,
      include: listInclude,
    });

    if (transitioning && status === 'CANCELLED') {
      writeActivityLog({
        assetId:   existing.assetId,
        userId:    req.user.id,
        accountId: req.user.accountId,
        action:    'work_order_cancelled',
        details:   { workOrderId: existing.id, scheduleId: existing.scheduleId, previousStatus: existing.status },
      });
    }

    res.json({ success: true, data: { workOrder } });
  } catch (err) {
    console.error('Update work order error:', err);
    res.status(500).json({ success: false, error: 'Failed to update work order' });
  }
});

// ═══ Test measurements ════════════════════════════════════════════════════════
// NETA MTS 5.4: BOTH as-found and as-left values belong on the test record.
// Contractors typically deliver a sheet of readings at once, so the create
// endpoint accepts a single object OR an array.

// Per-row field normalizer + validator. Returns { error } or { data }.
function buildMeasurementData(accountId, workOrderId, raw) {
  if (!raw || typeof raw !== 'object') return { error: 'Each measurement must be an object' };
  const {
    measurementType, phase, asFoundValue, asFoundUnit, asLeftValue, asLeftUnit, passFail,
    expectedRange, testVoltage, loadPercent, severityPriority, notes,
  } = raw;
  if (!measurementType || typeof measurementType !== 'string' || !measurementType.trim()) {
    return { error: 'measurementType is required' };
  }
  if (passFail != null && passFail !== '' && !RESULT_RATINGS.includes(passFail)) {
    return { error: `passFail must be one of ${RESULT_RATINGS.join(', ')}` };
  }
  const num = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isNaN(n) ? undefined : n; // undefined = invalid sentinel
  };
  const found = num(asFoundValue);
  const left  = num(asLeftValue);
  if (found === undefined || left === undefined) {
    return { error: 'asFoundValue/asLeftValue must be numeric' };
  }
  // IR thermography load at scan time (≥40% rule) — decimal percent.
  const load = num(loadPercent);
  if (load === undefined) {
    return { error: 'loadPercent must be numeric' };
  }
  // NETA ΔT priority: 1 (repair immediately) … 4 (possible deficiency).
  const sev = parseSeverityPriority(severityPriority);
  if (sev === undefined) {
    return { error: 'severityPriority must be an integer between 1 and 4' };
  }
  return {
    data: {
      accountId,
      workOrderId,
      measurementType: measurementType.trim(),
      phase:        phase || null,
      asFoundValue: found,
      asFoundUnit:  asFoundUnit || null,
      asLeftValue:  left,
      asLeftUnit:   asLeftUnit || null,
      passFail:     passFail || null,
      expectedRange:    expectedRange || null,
      testVoltage:      testVoltage || null,
      loadPercent:      load,
      severityPriority: sev,
      notes:        notes || null,
    },
  };
}

// int 1–4, number or numeric string; ''/null clears. undefined = invalid.
function parseSeverityPriority(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 4) return undefined;
  return n;
}

// ─── POST /api/work-orders/:id/measurements ───────────────────────────────────
router.post('/:id/measurements', requireManager, async (req, res) => {
  try {
    const workOrder = await prisma.workOrder.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
      select: { id: true },
    });
    if (!workOrder) return res.status(404).json({ success: false, error: 'Work order not found' });

    const rows = Array.isArray(req.body) ? req.body : [req.body];
    if (rows.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one measurement is required' });
    }
    if (rows.length > 200) {
      return res.status(400).json({ success: false, error: 'Maximum 200 measurements per request' });
    }

    const prepared = [];
    for (let i = 0; i < rows.length; i++) {
      const built = buildMeasurementData(req.user.accountId, workOrder.id, rows[i]);
      if (built.error) {
        return res.status(400).json({ success: false, error: `Measurement ${i + 1}: ${built.error}` });
      }
      prepared.push(built.data);
    }

    // Transactional creates (not createMany) so the response returns the full
    // rows — the SPA appends them to the open work-order panel in place.
    const measurements = await prisma.$transaction(
      prepared.map(data => prisma.testMeasurement.create({ data }))
    );

    res.status(201).json({ success: true, data: { measurements } });
  } catch (err) {
    console.error('Create measurements error:', err);
    res.status(500).json({ success: false, error: 'Failed to create measurements' });
  }
});

// ─── PUT /api/work-orders/measurements/:mid ───────────────────────────────────
router.put('/measurements/:mid', requireManager, async (req, res) => {
  try {
    const measurement = await prisma.testMeasurement.findFirst({
      where: { id: req.params.mid, accountId: req.user.accountId },
    });
    if (!measurement) return res.status(404).json({ success: false, error: 'Measurement not found' });

    const {
      measurementType, phase, asFoundValue, asFoundUnit, asLeftValue, asLeftUnit, passFail,
      expectedRange, testVoltage, loadPercent, severityPriority, notes,
    } = req.body;

    if (passFail !== undefined && passFail !== null && passFail !== '' && !RESULT_RATINGS.includes(passFail)) {
      return res.status(400).json({ success: false, error: `passFail must be one of ${RESULT_RATINGS.join(', ')}` });
    }

    const num = (v) => {
      if (v === null || v === '') return null;
      const n = typeof v === 'number' ? v : parseFloat(v);
      return Number.isNaN(n) ? undefined : n;
    };

    const updateData: any = {};
    if (measurementType !== undefined) {
      if (!measurementType || !String(measurementType).trim()) {
        return res.status(400).json({ success: false, error: 'measurementType cannot be blank' });
      }
      updateData.measurementType = String(measurementType).trim();
    }
    if (phase !== undefined)       updateData.phase = phase || null;
    if (asFoundValue !== undefined) {
      const n = num(asFoundValue);
      if (n === undefined) return res.status(400).json({ success: false, error: 'asFoundValue must be numeric' });
      updateData.asFoundValue = n;
    }
    if (asFoundUnit !== undefined) updateData.asFoundUnit = asFoundUnit || null;
    if (asLeftValue !== undefined) {
      const n = num(asLeftValue);
      if (n === undefined) return res.status(400).json({ success: false, error: 'asLeftValue must be numeric' });
      updateData.asLeftValue = n;
    }
    if (asLeftUnit !== undefined)  updateData.asLeftUnit = asLeftUnit || null;
    if (passFail !== undefined)    updateData.passFail = passFail || null;
    if (expectedRange !== undefined) updateData.expectedRange = expectedRange || null;
    if (testVoltage !== undefined)   updateData.testVoltage = testVoltage || null;
    if (loadPercent !== undefined) {
      const n = num(loadPercent);
      if (n === undefined) return res.status(400).json({ success: false, error: 'loadPercent must be numeric' });
      updateData.loadPercent = n;
    }
    if (severityPriority !== undefined) {
      const sev = parseSeverityPriority(severityPriority);
      if (sev === undefined) {
        return res.status(400).json({ success: false, error: 'severityPriority must be an integer between 1 and 4' });
      }
      updateData.severityPriority = sev;
    }
    if (notes !== undefined)       updateData.notes = notes || null;

    const updated = await prisma.testMeasurement.update({
      where: { id: measurement.id },
      data: updateData,
    });

    res.json({ success: true, data: { measurement: updated } });
  } catch (err) {
    console.error('Update measurement error:', err);
    res.status(500).json({ success: false, error: 'Failed to update measurement' });
  }
});

// ─── DELETE /api/work-orders/measurements/:mid ────────────────────────────────
router.delete('/measurements/:mid', requireManager, async (req, res) => {
  try {
    const measurement = await prisma.testMeasurement.findFirst({
      where: { id: req.params.mid, accountId: req.user.accountId },
    });
    if (!measurement) return res.status(404).json({ success: false, error: 'Measurement not found' });

    await prisma.testMeasurement.delete({ where: { id: measurement.id } });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete measurement error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete measurement' });
  }
});

// ─── POST /api/work-orders/:id/deficiencies ───────────────────────────────────
// Findings recorded DURING a job — assetId derives from the work order, so a
// caller can't attach a finding to an unrelated asset. Standalone walkthrough
// findings (no work order) go through POST /api/deficiencies instead.
router.post('/:id/deficiencies', requireManager, async (req, res) => {
  try {
    const workOrder = await prisma.workOrder.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
      select: { id: true, assetId: true },
    });
    if (!workOrder) return res.status(404).json({ success: false, error: 'Work order not found' });

    const { severity, description, correctiveAction } = req.body;
    if (!severity || !SEVERITIES.includes(severity)) {
      return res.status(400).json({ success: false, error: `severity must be one of ${SEVERITIES.join(', ')}` });
    }
    if (!description || !String(description).trim()) {
      return res.status(400).json({ success: false, error: 'description is required' });
    }

    const deficiency = await prisma.deficiency.create({
      data: {
        accountId:        req.user.accountId,
        workOrderId:      workOrder.id,
        assetId:          workOrder.assetId, // derived — never caller-supplied
        severity,
        description:      String(description).trim(),
        correctiveAction: correctiveAction || null,
      },
    });

    res.status(201).json({ success: true, data: { deficiency } });
  } catch (err) {
    console.error('Create work order deficiency error:', err);
    res.status(500).json({ success: false, error: 'Failed to create deficiency' });
  }
});

// ─── POST /api/work-orders/:id/lab-samples ────────────────────────────────────
// Sample pulled during the job (DGA / oil quality / fuel). Gas columns are
// ppm per IEEE C57.104; non-DGA results ride in resultsData (JSON).
router.post('/:id/lab-samples', requireManager, async (req, res) => {
  try {
    const workOrder = await prisma.workOrder.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
      select: { id: true, assetId: true },
    });
    if (!workOrder) return res.status(404).json({ success: false, error: 'Work order not found' });

    const {
      sampleType, sampleDate, labName,
      h2, ch4, c2h2, c2h4, c2h6, co, co2, o2, n2,
      ieeeStatus, faultCode,
      resultsData, resultRating, reportPdfUrl, notes,
    } = req.body;

    if (!sampleType || !String(sampleType).trim()) {
      return res.status(400).json({ success: false, error: 'sampleType is required' });
    }
    if (resultRating != null && resultRating !== '' && !RESULT_RATINGS.includes(resultRating)) {
      return res.status(400).json({ success: false, error: `resultRating must be one of ${RESULT_RATINGS.join(', ')}` });
    }

    // IEEE C57.104-2019 DGA status: 1 normal, 2 caution, 3 action required.
    let ieee = null;
    if (ieeeStatus !== undefined && ieeeStatus !== null && ieeeStatus !== '') {
      const n = typeof ieeeStatus === 'number' ? ieeeStatus : parseInt(ieeeStatus, 10);
      if (![1, 2, 3].includes(n)) {
        return res.status(400).json({ success: false, error: 'ieeeStatus must be 1, 2, or 3' });
      }
      ieee = n;
    }

    const when = sampleDate ? new Date(sampleDate) : new Date();
    if (Number.isNaN(when.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid sampleDate' });
    }

    // Gas readings: numeric or null; reject garbage rather than storing NaN.
    const gas = (v, field) => {
      if (v === undefined || v === null || v === '') return null;
      const n = typeof v === 'number' ? v : parseFloat(v);
      if (Number.isNaN(n) || n < 0) throw new Error(`${field} must be a non-negative number (ppm)`);
      return n;
    };

    let gasValues;
    try {
      gasValues = {
        h2: gas(h2, 'h2'), ch4: gas(ch4, 'ch4'), c2h2: gas(c2h2, 'c2h2'),
        c2h4: gas(c2h4, 'c2h4'), c2h6: gas(c2h6, 'c2h6'),
        co: gas(co, 'co'), co2: gas(co2, 'co2'),
        // O2 + N2 complete the IEEE C57.104-2019 gas set (sealed vs
        // free-breathing discrimination).
        o2: gas(o2, 'o2'), n2: gas(n2, 'n2'),
      };
    } catch (vErr) {
      return res.status(400).json({ success: false, error: vErr.message });
    }

    const labSample = await prisma.labSample.create({
      data: {
        accountId:   req.user.accountId,
        assetId:     workOrder.assetId, // derived from the work order
        workOrderId: workOrder.id,
        sampleType:  String(sampleType).trim(),
        sampleDate:  when,
        labName:     labName || null,
        ...gasValues,
        ieeeStatus:   ieee,
        faultCode:    faultCode || null,
        resultsData:  resultsData && typeof resultsData === 'object' ? resultsData : undefined,
        resultRating: resultRating || null,
        reportPdfUrl: reportPdfUrl || null,
        notes:        notes || null,
      },
    });

    res.status(201).json({ success: true, data: { labSample } });
  } catch (err) {
    console.error('Create lab sample error:', err);
    res.status(500).json({ success: false, error: 'Failed to create lab sample' });
  }
});

module.exports = router;

export {};
