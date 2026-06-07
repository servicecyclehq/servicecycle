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
      name, netaAccredited, notes,
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
      name, netaAccredited, notes,
      supportEmail, supportPhone, supportPortalUrl, portalUrl,
      scoreSupport, scoreSatisfaction, aliases,
    } = req.body;

    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 200)) {
      return res.status(400).json({ success: false, error: 'Contractor name must be a non-empty string of 200 characters or fewer' });
    }

    const updateData: any = {};
    if (name !== undefined)             updateData.name = name.trim();
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

    const { name, title, email, phone, netaCertLevel, notes } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Tech name is required' });
    }
    if (netaCertLevel != null && netaCertLevel !== '' && !NETA_CERT_LEVELS.includes(netaCertLevel)) {
      return res.status(400).json({ success: false, error: `netaCertLevel must be one of ${NETA_CERT_LEVELS.join(', ')}` });
    }

    const tech = await prisma.contractorTech.create({
      data: {
        contractorId: contractor.id,
        name:          name.trim(),
        title:         title || null,
        email:         email || null,
        phone:         phone || null,
        netaCertLevel: netaCertLevel || null,
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

    const { name, title, email, phone, netaCertLevel, notes, lastContactedAt } = req.body;

    if (netaCertLevel !== undefined && netaCertLevel !== null && netaCertLevel !== ''
        && !NETA_CERT_LEVELS.includes(netaCertLevel)) {
      return res.status(400).json({ success: false, error: `netaCertLevel must be one of ${NETA_CERT_LEVELS.join(', ')}` });
    }

    const updateData: any = {};
    if (name !== undefined)            updateData.name = String(name).trim();
    if (title !== undefined)           updateData.title = title || null;
    if (email !== undefined)           updateData.email = email || null;
    if (phone !== undefined)           updateData.phone = phone || null;
    if (netaCertLevel !== undefined)   updateData.netaCertLevel = netaCertLevel || null;
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
