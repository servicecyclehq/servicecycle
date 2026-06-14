/**
 * /api/contractors — NETA testing contractor directory.
 *
 * Contractors are the testing/maintenance companies a facility hires to
 * perform NFPA 70B work: thermography scans, breaker trip testing, DGA
 * sampling, switchgear cleaning. Each contractor carries a roster of field
 * technicians (ContractorTech) with ANSI/NETA ETT certification levels —
 * work-order assignment validates tech ownership against the contractor.
 *
 * Mounted behind authenticateToken in index.ts. Every query filters
 * accountId = req.user.accountId — a contractor id from another tenant 404s,
 * never leaks. Writes are manager+ (requireManager); reads are any
 * authenticated role.
 *
 * Per-account (accountId, name) uniqueness is enforced at the DB layer;
 * P2002 surfaces as a 409 so concurrent CSV imports of the same contractor
 * can't create duplicates.
 */

const router = require('express').Router();
const { requireManager } = require('../middleware/roles');
const prisma = require('../lib/prisma').default;

// WorkOrderStatus values that count as "open" for the list-view badge.
const OPEN_WO_STATUSES = ['SCHEDULED', 'IN_PROGRESS'];

// ANSI/NETA ETT certification levels (NetaCertLevel enum) — app-layer guard
// so a bad string 400s instead of throwing a Prisma enum error.
const NETA_CERT_LEVELS = ['LEVEL_I', 'LEVEL_II', 'LEVEL_III', 'LEVEL_IV'];

// Thermographer certification levels (Infraspection/ASNT model; Level II is
// the de-facto insurer minimum for signing IR reports). Stored as a plain
// string column — guard here.
const THERMOGRAPHER_LEVELS = ['I', 'II', 'III'];

// Nullable-date normalizer for the tech qualification fields. Returns
// { value } (Date or null) or { error } on garbage input.
function parseNullableDate(v, field) {
  if (v === undefined || v === null || v === '') return { value: null };
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return { error: `Invalid ${field}` };
  return { value: d };
}

// 1–5 score guard for the contractor scorecard fields.
function normalizeScore(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  if (Number.isNaN(n) || n < 1 || n > 5) return null;
  return n;
}

// ─── GET /api/contractors ─────────────────────────────────────────────────────
// Directory list with tech headcount + open work order count per contractor —
// the two signals the list view badges ("4 techs · 2 open WOs").
router.get('/', async (req, res) => {
  try {
    const contractors = await prisma.contractor.findMany({
      where: { accountId: req.user.accountId },
      orderBy: { name: 'asc' },
      include: {
        _count: {
          select: {
            techs: true,
            workOrders: { where: { status: { in: OPEN_WO_STATUSES } } },
          },
        },
      },
    });

    res.json({ success: true, data: { contractors } });
  } catch (err) {
    console.error('List contractors error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch contractors' });
  }
});

// ─── GET /api/contractors/qemw-wallet ─────────────────────────────────────────
// #37 QEMW credential wallet: the whole-account technician roster with credential
// status (QEMW + NETA ETT + 70E qualified-person + thermographer) AND the
// assignment-vs-requirement gap ("3 jobs next month require a certified tech; 2
// qualified techs available"). ANSI/NETA EMW-2026 first-mover window. Any
// authenticated role (read). NOTE: must be declared BEFORE GET /:id so the
// literal path isn't captured by the :id param.
const QEMW_EXPIRING_DAYS = 60; // matches the qemwAlerts 60d expiry tier
router.get('/qemw-wallet', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const now = new Date();
    const windowDays = Math.min(365, Math.max(1, parseInt(String(req.query.windowDays || '30'), 10) || 30));
    const windowEnd = new Date(now.getTime() + windowDays * 86_400_000);

    const [techs, requireQemwRow, upcomingNetaJobs] = await Promise.all([
      prisma.contractorTech.findMany({
        where: { contractor: { accountId } },
        orderBy: [{ name: 'asc' }],
        select: {
          id: true, name: true, email: true, title: true,
          netaCertLevel: true,
          qualifiedPersonDesignatedAt: true, trainingExpiresAt: true,
          thermographerCertLevel: true,
          qemwCertNumber: true, qemwExpiresAt: true, qemwIssuingBody: true,
          contractor: { select: { id: true, name: true } },
        },
      }),
      prisma.accountSetting.findFirst({ where: { accountId, key: 'REQUIRE_QEMW' }, select: { value: true } }),
      // Jobs in the window that require a NETA-certified tech (the QEMW-relevant
      // population): active schedules due soon on live assets with a
      // requiresNetaCertified task definition.
      prisma.maintenanceSchedule.count({
        where: {
          accountId, isActive: true,
          nextDueDate: { gte: now, lte: windowEnd },
          asset: { archivedAt: null, inService: true },
          taskDefinition: { requiresNetaCertified: true },
        },
      }),
    ]);

    function qemwStatus(t: any): { status: string; daysUntilExpiry: number | null } {
      if (!t.qemwCertNumber) return { status: 'none', daysUntilExpiry: null };
      if (!t.qemwExpiresAt) return { status: 'valid', daysUntilExpiry: null };
      const days = Math.ceil((new Date(t.qemwExpiresAt).getTime() - now.getTime()) / 86_400_000);
      if (days < 0) return { status: 'expired', daysUntilExpiry: days };
      if (days <= QEMW_EXPIRING_DAYS) return { status: 'expiring', daysUntilExpiry: days };
      return { status: 'valid', daysUntilExpiry: days };
    }
    function trainingStatus(t: any): string {
      if (!t.trainingExpiresAt) return 'unknown';
      const days = Math.ceil((new Date(t.trainingExpiresAt).getTime() - now.getTime()) / 86_400_000);
      if (days < 0) return 'expired';
      if (days <= QEMW_EXPIRING_DAYS) return 'expiring';
      return 'current';
    }

    const roster = techs.map((t: any) => {
      const q = qemwStatus(t);
      return {
        id: t.id,
        name: t.name,
        email: t.email,
        title: t.title,
        contractorId: t.contractor?.id ?? null,
        contractorName: t.contractor?.name ?? null,
        netaCertLevel: t.netaCertLevel,
        qualifiedPersonDesignatedAt: t.qualifiedPersonDesignatedAt,
        thermographerCertLevel: t.thermographerCertLevel,
        trainingExpiresAt: t.trainingExpiresAt,
        trainingStatus: trainingStatus(t),
        qemwCertNumber: t.qemwCertNumber,
        qemwExpiresAt: t.qemwExpiresAt,
        qemwIssuingBody: t.qemwIssuingBody,
        qemwStatus: q.status,
        qemwDaysUntilExpiry: q.daysUntilExpiry,
      };
    });

    const counts = { valid: 0, expiring: 0, expired: 0, none: 0 };
    for (const r of roster) counts[r.qemwStatus as keyof typeof counts]++;
    // "Qualified and available" = a currently-honourable QEMW (valid or expiring
    // but not yet expired). Expired does not count as coverage.
    const qualifiedTechsAvailable = counts.valid + counts.expiring;
    const requireQemw = requireQemwRow?.value === 'true';

    res.json({
      success: true,
      data: {
        techs: roster,
        summary: {
          totalTechs: roster.length,
          qemwValid: counts.valid,
          qemwExpiring: counts.expiring,
          qemwExpired: counts.expired,
          qemwNone: counts.none,
          requireQemw,
          windowDays,
          upcomingCertifiedJobs: upcomingNetaJobs,
          qualifiedTechsAvailable,
          hasCoverageGap: upcomingNetaJobs > 0 && qualifiedTechsAvailable === 0,
        },
      },
    });
  } catch (err) {
    console.error('QEMW wallet error:', err);
    res.status(500).json({ success: false, error: 'Failed to build QEMW wallet' });
  }
});

// ─── GET /api/contractors/:id ─────────────────────────────────────────────────
// Full contractor card: tech roster + recent work order history.
router.get('/:id', async (req, res) => {
  try {
    const contractor = await prisma.contractor.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
      include: {
        techs: { orderBy: [{ name: 'asc' }] },
        workOrders: {
          orderBy: { scheduledDate: 'desc' },
          take: 50,
          select: {
            id: true, status: true, scheduledDate: true, completedDate: true,
            netaDecal: true, netaCertLevel: true,
            asset: {
              select: {
                id: true, equipmentType: true, manufacturer: true, model: true,
                site: { select: { id: true, name: true } },
              },
            },
            assignedTech: { select: { id: true, name: true } },
          },
        },
        communications: {
          orderBy: { occurredAt: 'desc' },
          take: 50,
          include: { createdByUser: { select: { id: true, name: true } } },
        },
      },
    });

    if (!contractor) {
      return res.status(404).json({ success: false, error: 'Contractor not found' });
    }

    res.json({ success: true, data: { contractor } });
  } catch (err) {
    console.error('Get contractor error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch contractor' });
  }
});

// ─── POST /api/contractors ────────────────────────────────────────────────────
router.post('/', requireManager, async (req, res) => {
  // Server-side name cap (200 chars) — mirrors the directory-wide guard.
  if (req.body && typeof req.body.name === 'string' && req.body.name.length > 200) {
    return res.status(400).json({ success: false, error: 'Contractor name must be 200 characters or fewer' });
  }
  try {
    const {
      name, isInternal, netaAccredited, notes,
      supportEmail, supportPhone, supportPortalUrl, portalUrl,
      scoreSupport, scoreSatisfaction, aliases,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Contractor name is required' });
    }

    const contractor = await prisma.contractor.create({
      data: {
        accountId:        req.user.accountId,
        name:             name.trim(),
        // In-house maintenance crew flag — same qualified-person rules,
        // honest UI labeling.
        isInternal:       isInternal === true,
        netaAccredited:   netaAccredited === true,
        notes:            notes || null,
        supportEmail:     supportEmail || null,
        supportPhone:     supportPhone || null,
        supportPortalUrl: supportPortalUrl || null,
        portalUrl:        portalUrl || null,
        scoreSupport:     normalizeScore(scoreSupport),
        scoreSatisfaction: normalizeScore(scoreSatisfaction),
        aliases:          Array.isArray(aliases)
          ? aliases.filter(a => typeof a === 'string' && a.trim())
          : undefined,
      },
    });

    res.status(201).json({ success: true, data: { contractor } });
  } catch (err) {
    // (accountId, name) unique — the duplicate-create race lands here.
    if (err && err.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'A contractor with this name already exists' });
    }
    console.error('Create contractor error:', err);
    res.status(500).json({ success: false, error: 'Failed to create contractor' });
  }
});

// ─── PUT /api/contractors/:id ─────────────────────────────────────────────────
router.put('/:id', requireManager, async (req, res) => {
  try {
    const existing = await prisma.contractor.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Contractor not found' });
    }

    const {
      name, isInternal, netaAccredited, notes,
      supportEmail, supportPhone, supportPortalUrl, portalUrl,
      scoreSupport, scoreSatisfaction, aliases,
    } = req.body;

    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 200)) {
      return res.status(400).json({ success: false, error: 'Contractor name must be a non-empty string of 200 characters or fewer' });
    }

    const updateData: any = {};
    if (name !== undefined)             updateData.name = name.trim();
    if (isInternal !== undefined)       updateData.isInternal = isInternal === true;
    if (netaAccredited !== undefined)   updateData.netaAccredited = netaAccredited === true;
    if (notes !== undefined)            updateData.notes = notes || null;
    if (supportEmail !== undefined)     updateData.supportEmail = supportEmail || null;
    if (supportPhone !== undefined)     updateData.supportPhone = supportPhone || null;
    if (supportPortalUrl !== undefined) updateData.supportPortalUrl = supportPortalUrl || null;
    if (portalUrl !== undefined)        updateData.portalUrl = portalUrl || null;
    if (scoreSupport !== undefined)     updateData.scoreSupport = normalizeScore(scoreSupport);
    if (scoreSatisfaction !== undefined) updateData.scoreSatisfaction = normalizeScore(scoreSatisfaction);
    // aliases: org-specific alternate names / procurement codes (stored as JSON)
    if (aliases !== undefined) {
      updateData.aliases = Array.isArray(aliases)
        ? aliases.filter(a => typeof a === 'string' && a.trim())
        : null;
    }

    const contractor = await prisma.contractor.update({
      where: { id: existing.id },
      data: updateData,
    });

    res.json({ success: true, data: { contractor } });
  } catch (err) {
    if (err && err.code === 'P2002') {
      return res.status(409).json({ success: false, error: 'A contractor with this name already exists' });
    }
    console.error('Update contractor error:', err);
    res.status(500).json({ success: false, error: 'Failed to update contractor' });
  }
});

// ═══ Tech roster (ContractorTech) ═════════════════════════════════════════════
// Techs hang off a contractor; tenancy is verified through the contractor
// relation on every per-tech query so a techId from another account 404s.

// ─── POST /api/contractors/:id/techs ──────────────────────────────────────────
router.post('/:id/techs', requireManager, async (req, res) => {
  try {
    const contractor = await prisma.contractor.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!contractor) return res.status(404).json({ success: false, error: 'Contractor not found' });

    const {
      name, title, email, phone, netaCertLevel, notes,
      qualifiedPersonDesignatedAt, trainingExpiresAt, thermographerCertLevel,
    } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Tech name is required' });
    }
    if (netaCertLevel != null && netaCertLevel !== '' && !NETA_CERT_LEVELS.includes(netaCertLevel)) {
      return res.status(400).json({ success: false, error: `netaCertLevel must be one of ${NETA_CERT_LEVELS.join(', ')}` });
    }
    if (thermographerCertLevel != null && thermographerCertLevel !== ''
        && !THERMOGRAPHER_LEVELS.includes(thermographerCertLevel)) {
      return res.status(400).json({ success: false, error: `thermographerCertLevel must be one of ${THERMOGRAPHER_LEVELS.join(', ')} (or null to clear)` });
    }

    // NFPA 70E qualification provenance dates.
    const qpDate = parseNullableDate(qualifiedPersonDesignatedAt, 'qualifiedPersonDesignatedAt');
    if (qpDate.error) return res.status(400).json({ success: false, error: qpDate.error });
    const trainDate = parseNullableDate(trainingExpiresAt, 'trainingExpiresAt');
    if (trainDate.error) return res.status(400).json({ success: false, error: trainDate.error });

    const tech = await prisma.contractorTech.create({
      data: {
        contractorId: contractor.id,
        name:          name.trim(),
        title:         title || null,
        email:         email || null,
        phone:         phone || null,
        netaCertLevel: netaCertLevel || null,
        qualifiedPersonDesignatedAt: qpDate.value,
        trainingExpiresAt:           trainDate.value,
        thermographerCertLevel:      thermographerCertLevel || null,
        notes:         notes || null,
      },
    });

    res.status(201).json({ success: true, data: { tech } });
  } catch (err) {
    console.error('Create tech error:', err);
    res.status(500).json({ success: false, error: 'Failed to create tech' });
  }
});

// ─── PUT /api/contractors/techs/:techId ───────────────────────────────────────
router.put('/techs/:techId', requireManager, async (req, res) => {
  try {
    const tech = await prisma.contractorTech.findFirst({
      where: { id: req.params.techId, contractor: { accountId: req.user.accountId } },
    });
    if (!tech) return res.status(404).json({ success: false, error: 'Tech not found' });

    const {
      name, title, email, phone, netaCertLevel, notes, lastContactedAt,
      qualifiedPersonDesignatedAt, trainingExpiresAt, thermographerCertLevel,
    } = req.body;

    if (netaCertLevel !== undefined && netaCertLevel !== null && netaCertLevel !== ''
        && !NETA_CERT_LEVELS.includes(netaCertLevel)) {
      return res.status(400).json({ success: false, error: `netaCertLevel must be one of ${NETA_CERT_LEVELS.join(', ')}` });
    }
    if (thermographerCertLevel !== undefined && thermographerCertLevel !== null
        && thermographerCertLevel !== '' && !THERMOGRAPHER_LEVELS.includes(thermographerCertLevel)) {
      return res.status(400).json({ success: false, error: `thermographerCertLevel must be one of ${THERMOGRAPHER_LEVELS.join(', ')} (or null to clear)` });
    }

    const updateData: any = {};
    if (name !== undefined)            updateData.name = String(name).trim();
    if (title !== undefined)           updateData.title = title || null;
    if (email !== undefined)           updateData.email = email || null;
    if (phone !== undefined)           updateData.phone = phone || null;
    if (netaCertLevel !== undefined)   updateData.netaCertLevel = netaCertLevel || null;
    if (thermographerCertLevel !== undefined) updateData.thermographerCertLevel = thermographerCertLevel || null;
    if (qualifiedPersonDesignatedAt !== undefined) {
      const qpDate = parseNullableDate(qualifiedPersonDesignatedAt, 'qualifiedPersonDesignatedAt');
      if (qpDate.error) return res.status(400).json({ success: false, error: qpDate.error });
      updateData.qualifiedPersonDesignatedAt = qpDate.value;
    }
    if (trainingExpiresAt !== undefined) {
      const trainDate = parseNullableDate(trainingExpiresAt, 'trainingExpiresAt');
      if (trainDate.error) return res.status(400).json({ success: false, error: trainDate.error });
      updateData.trainingExpiresAt = trainDate.value;
    }
    if (notes !== undefined)           updateData.notes = notes || null;
    if (lastContactedAt !== undefined) updateData.lastContactedAt = lastContactedAt ? new Date(lastContactedAt) : null;

    const updated = await prisma.contractorTech.update({
      where: { id: tech.id },
      data: updateData,
    });

    res.json({ success: true, data: { tech: updated } });
  } catch (err) {
    console.error('Update tech error:', err);
    res.status(500).json({ success: false, error: 'Failed to update tech' });
  }
});

// ─── DELETE /api/contractors/techs/:techId ────────────────────────────────────
// Hard delete. The WorkOrder.assignedTechId FK has no cascade, so a tech with
// work-order history fails with P2003 — surfaced as a 409 telling the user to
// reassign those work orders first (history must stay attributable).
router.delete('/techs/:techId', requireManager, async (req, res) => {
  try {
    const tech = await prisma.contractorTech.findFirst({
      where: { id: req.params.techId, contractor: { accountId: req.user.accountId } },
    });
    if (!tech) return res.status(404).json({ success: false, error: 'Tech not found' });

    await prisma.contractorTech.delete({ where: { id: tech.id } });
    res.json({ success: true });
  } catch (err) {
    if (err && err.code === 'P2003') {
      return res.status(409).json({ success: false, error: 'Tech is assigned to existing work orders — reassign them first' });
    }
    console.error('Delete tech error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete tech' });
  }
});

module.exports = router;

export {};
