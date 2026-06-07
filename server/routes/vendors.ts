const router = require('express').Router();
const { requireManager } = require('../middleware/roles');
import prisma from '../lib/prisma';
const { findSimilarVendors, resolveViaAliasMap } = require('../lib/vendorNormalizer');

// ─── GET /api/vendors/check?name=<raw> ───────────────────────────────────────
// Live duplicate-check used by the new-vendor form.
// Returns a list of potential duplicate vendors for the given name, so the UI
// can warn the user before they create a near-miss record.
//
// Response shape:
//   { success: true, data: { canonical: string|null, matches: [ { id, name, matchType, score } ] } }
//
// NOTE: this route must appear before /:id so Express doesn't treat "check" as an id.
router.get('/check', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'name query parameter is required' });
    }

    // Fetch all vendors for this account (name + aliases only — keep the payload light)
    const vendors = await prisma.vendor.findMany({
      where: { accountId: req.user.accountId },
      select: { id: true, name: true, aliases: true },
    });

    // Normalize aliases from JSON storage
    const vendorsForCheck = vendors.map(v => ({
      ...v,
      aliases: Array.isArray(v.aliases) ? v.aliases : [],
    }));

    const canonical = resolveViaAliasMap(name.trim());
    const matches   = findSimilarVendors(name.trim(), vendorsForCheck);

    res.json({
      success: true,
      data: {
        canonical,                           // suggested canonical name, or null
        matches: matches.map(m => ({
          id:        m.vendor.id,
          name:      m.vendor.name,
          matchType: m.matchType,
          score:     m.score,
        })),
      },
    });
  } catch (err) {
    console.error('Vendor check error:', err);
    res.status(500).json({ success: false, error: 'Failed to check vendor name' });
  }
});

// ─── GET /api/vendors ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const vendors = await prisma.vendor.findMany({
      where: { accountId: req.user.accountId },
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { contracts: true, contacts: true } },
        // Lightweight spend data (active + under_review contracts only)
        contracts: {
          where: { status: { in: ['active', 'under_review'] } },
          select: { costPerLicense: true, quantity: true, status: true },
        },
        // Most recent communication — one signal for "Last Contacted"
        communications: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
        // Most-recent contact note — the other (often richer) signal. The
        // list view picks max(communications[0].createdAt, contacts[0].lastContactedAt)
        // so vendors with a populated contact card aren't shown as blank
        // when no communication has been logged yet.
        contacts: {
          where: { lastContactedAt: { not: null } },
          orderBy: { lastContactedAt: 'desc' },
          take: 1,
          select: { lastContactedAt: true },
        },
      },
    });

    // Compute a unified lastContactedAt = max(comm.createdAt, contact.lastContactedAt)
    // and surface it as a top-level field so the client doesn't have to know
    // the merge logic.
    const decorated = vendors.map((v) => {
      const commTs    = v.communications?.[0]?.createdAt ? new Date(v.communications[0].createdAt).getTime() : 0;
      const contactTs = v.contacts?.[0]?.lastContactedAt ? new Date(v.contacts[0].lastContactedAt).getTime() : 0;
      const lastContactedAt = Math.max(commTs, contactTs);
      return { ...v, lastContactedAt: lastContactedAt > 0 ? new Date(lastContactedAt).toISOString() : null };
    });

    res.json({ success: true, data: { vendors: decorated } });
  } catch (err) {
    console.error('List vendors error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch vendors' });
  }
});

// ─── GET /api/vendors/:id ─────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const vendor = await prisma.vendor.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
      include: {
        contacts: { orderBy: [{ name: 'asc' }] },
        contracts: {
          orderBy: { endDate: 'asc' },
          select: {
            id: true, product: true, contractNumber: true,
            endDate: true, startDate: true, status: true,
            quantity: true, costPerLicense: true,
            resellerName: true, poNumber: true,
          },
        },
        communications: {
          orderBy: { occurredAt: 'desc' },
          take: 50,
          include: { createdByUser: { select: { id: true, name: true } } },
        },
      },
    });

    if (!vendor) {
      return res.status(404).json({ success: false, error: 'Vendor not found' });
    }

    res.json({ success: true, data: { vendor } });
  } catch (err) {
    console.error('Get vendor error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch vendor' });
  }
});

// ─── POST /api/vendors ────────────────────────────────────────────────────────
// Supports an optional { force: true } body flag to bypass duplicate warnings.
// When force is omitted or false and similar vendors exist, returns 409 with the
// list of potential duplicates so the UI can surface a confirmation prompt.
router.post('/', requireManager, async (req, res) => {
    // v0.68.2 (audit Low): server-side vendor name cap (200 chars)
    if (req.body && typeof req.body.name === 'string' && req.body.name.length > 200) {
      return res.status(400).json({ success: false, error: 'Vendor name must be 200 characters or fewer' });
    }
  try {
    const { name, vendorType, cotermComplexity, cotermNotes, criticalityTier, notes, supportEmail, supportPhone, supportPortalUrl, force } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Vendor name is required' });
    }

    // ── Duplicate check (skip when force=true) ────────────────────────────────
    if (!force) {
      const existingVendors = await prisma.vendor.findMany({
        where: { accountId: req.user.accountId },
        select: { id: true, name: true, aliases: true },
      });

      const vendorsForCheck = existingVendors.map(v => ({
        ...v,
        aliases: Array.isArray(v.aliases) ? v.aliases : [],
      }));

      const matches = findSimilarVendors(name.trim(), vendorsForCheck);

      // Surface anything with score >= 70 (strong match) as a warning
      const strongMatches = matches.filter(m => m.score >= 70);

      if (strongMatches.length > 0) {
        return res.status(409).json({
          success: false,
          error:   'Potential duplicate vendor detected',
          data: {
            canonical: resolveViaAliasMap(name.trim()),
            matches:   strongMatches.map(m => ({
              id:        m.vendor.id,
              name:      m.vendor.name,
              matchType: m.matchType,
              score:     m.score,
            })),
          },
        });
      }
    }

    // ── Suggest canonical name if alias map resolves it ───────────────────────
    const canonicalName = resolveViaAliasMap(name.trim());
    const resolvedName  = canonicalName || name.trim();

    const vendor = await prisma.vendor.create({
      data: {
        accountId:      req.user.accountId,
        name:           resolvedName,
        vendorType:     vendorType || null,
        cotermComplexity: cotermComplexity || 'none',
        cotermNotes:    cotermNotes || null,
        criticalityTier: (criticalityTier && ['tier_1','tier_2','tier_3','tier_4'].includes(criticalityTier)) ? criticalityTier : null,
        notes:          notes || null,
        supportEmail:   supportEmail || null,
        supportPhone:   supportPhone || null,
        supportPortalUrl: supportPortalUrl || null,
      },
    });

    res.status(201).json({ success: true, data: { vendor } });
  } catch (err) {
    console.error('Create vendor error:', err);
    res.status(500).json({ success: false, error: 'Failed to create vendor' });
  }
});

// ─── PUT /api/vendors/:id ─────────────────────────────────────────────────────
router.put('/:id', requireManager, async (req, res) => {
  try {
    const existing = await prisma.vendor.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Vendor not found' });
    }

    const {
      name, vendorType, cotermComplexity, cotermNotes, criticalityTier, notes,
      supportEmail, supportPhone, supportPortalUrl,
      scorePriceFlexibility, scoreSupport, scoreStrategicValue, scoreSatisfaction,
      aliases,
    } = req.body;

    const updateData: any = {};
    if (name !== undefined)                updateData.name = name.trim();
    if (vendorType !== undefined)          updateData.vendorType = vendorType || null;
    if (cotermComplexity !== undefined)    updateData.cotermComplexity = cotermComplexity;
    if (cotermNotes !== undefined)         updateData.cotermNotes = cotermNotes || null;
    if (criticalityTier !== undefined) {
      // v0.58.0: app-layer enum validation (stored as TEXT for migration simplicity)
      const t = criticalityTier;
      updateData.criticalityTier = (t && ['tier_1','tier_2','tier_3','tier_4'].includes(t)) ? t : null;
    }
    if (notes !== undefined)              updateData.notes = notes || null;
    if (supportEmail !== undefined)        updateData.supportEmail = supportEmail || null;
    if (supportPhone !== undefined)        updateData.supportPhone = supportPhone || null;
    if (supportPortalUrl !== undefined)    updateData.supportPortalUrl = supportPortalUrl || null;
    if (scorePriceFlexibility !== undefined) updateData.scorePriceFlexibility = scorePriceFlexibility || null;
    if (scoreSupport !== undefined)        updateData.scoreSupport = scoreSupport || null;
    if (scoreStrategicValue !== undefined) updateData.scoreStrategicValue = scoreStrategicValue || null;
    if (scoreSatisfaction !== undefined)   updateData.scoreSatisfaction = scoreSatisfaction || null;
    // aliases: array of custom org-specific alternate names (stored as JSON)
    if (aliases !== undefined) {
      updateData.aliases = Array.isArray(aliases) ? aliases.filter(a => typeof a === 'string' && a.trim()) : null;
    }

    const vendor = await prisma.vendor.update({
      where: { id: req.params.id },
      data: updateData,
    });

    res.json({ success: true, data: { vendor } });
  } catch (err) {
    console.error('Update vendor error:', err);
    res.status(500).json({ success: false, error: 'Failed to update vendor' });
  }
});

// ─── POST /api/vendors/:id/contacts ──────────────────────────────────────────
router.post('/:id/contacts', requireManager, async (req, res) => {
  try {
    const vendor = await prisma.vendor.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found' });

    const { name, title, email, phone, notes } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Contact name is required' });
    }

    const contact = await prisma.vendorContact.create({
      data: {
        vendorId: req.params.id,
        name: name.trim(),
        title: title || null,
        email: email || null,
        phone: phone || null,
        notes: notes || null,
      },
    });

    res.status(201).json({ success: true, data: { contact } });
  } catch (err) {
    console.error('Create contact error:', err);
    res.status(500).json({ success: false, error: 'Failed to create contact' });
  }
});

// ─── PUT /api/vendors/:id/contacts/:contactId ─────────────────────────────────
router.put('/:id/contacts/:contactId', requireManager, async (req, res) => {
  try {
    const contact = await prisma.vendorContact.findFirst({
      where: { id: req.params.contactId, vendorId: req.params.id, vendor: { accountId: req.user.accountId } },
    });
    if (!contact) return res.status(404).json({ success: false, error: 'Contact not found' });

    const { name, title, email, phone, notes } = req.body;
    const updateData: any = {};
    if (name !== undefined)  updateData.name = name.trim();
    if (title !== undefined) updateData.title = title || null;
    if (email !== undefined) updateData.email = email || null;
    if (phone !== undefined) updateData.phone = phone || null;
    if (notes !== undefined) updateData.notes = notes || null;

    const updated = await prisma.vendorContact.update({
      where: { id: contact.id },
      data: updateData,
    });

    res.json({ success: true, data: { contact: updated } });
  } catch (err) {
    console.error('Update contact error:', err);
    res.status(500).json({ success: false, error: 'Failed to update contact' });
  }
});

// ─── DELETE /api/vendors/:id/contacts/:contactId ──────────────────────────────
router.delete('/:id/contacts/:contactId', requireManager, async (req, res) => {
  try {
    const contact = await prisma.vendorContact.findFirst({
      where: { id: req.params.contactId, vendorId: req.params.id, vendor: { accountId: req.user.accountId } },
    });
    if (!contact) return res.status(404).json({ success: false, error: 'Contact not found' });

    await prisma.vendorContact.delete({ where: { id: contact.id } });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete contact error:', err);
    res.status(500).json({ success: false, error: 'Failed to delete contact' });
  }
});

// ─── POST /api/vendors/:id/communications ─────────────────────────────────────
router.post('/:id/communications', requireManager, async (req, res) => {
  try {
    const vendor = await prisma.vendor.findFirst({
      where: { id: req.params.id, accountId: req.user.accountId },
    });
    if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found' });

    const { type, subject, body, occurredAt } = req.body;
    if (!type) return res.status(400).json({ success: false, error: 'type is required' });

    const comm = await prisma.communication.create({
      data: {
        accountId:  req.user.accountId,
        vendorId:   req.params.id,
        type,
        subject:    subject || null,
        body:       body || null,
        occurredAt: occurredAt ? new Date(occurredAt) : new Date(),
        createdBy:  req.user.id,
      },
      include: { createdByUser: { select: { id: true, name: true } } },
    });

    res.status(201).json({ success: true, data: { communication: comm } });
  } catch (err) {
    console.error('Create communication error:', err);
    res.status(500).json({ success: false, error: 'Failed to create communication' });
  }
});

module.exports = router;

export {};
