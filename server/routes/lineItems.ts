// ─────────────────────────────────────────────────────────────────────────────
// routes/lineItems.js — v0.55.0 contract line-item CRUD
//
// Per-SKU planning rows for a contract's renewal. Editable counts + per-unit
// prices + notes. Server is the source of truth; client uses debounced PUT
// auto-save, so a single user toggling values fires PUT every ~500ms.
//
// Mounted in server/index.js at `/api/contracts/:contractId/line-items` with
// mergeParams:true so this router sees both :contractId and :lineItemId.
//
// All endpoints require an authenticated user (auth middleware is upstream).
// Mutations require `requireManager` to match the rest of the contract write
// surface (POST/PUT/PATCH/DELETE on /api/contracts).
//
// Concurrent-edit safety: PUT accepts an `If-Match` header carrying the row's
// expected `updatedAt` ISO timestamp. If the server's `updatedAt` doesn't
// match, returns 409 { code: 'conflict', current: <the row as it currently is> }
// so the client can surface a "Sarah just edited this" merge prompt.
//
// Cover-field denormalization: every mutation recomputes Contract.totalValue
// from the sum of (originalCount × originalCostPerUnit) across the contract's
// non-archived line items. This keeps the existing contracts-list sort working
// even though the data source migrated from the single-row tuple to multi-line.
//
// See: docs/design/renewal-planning-persistence-v047.md (§7)
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const { z } = require('zod');
import prisma from '../lib/prisma';
const { requireManager } = require('../middleware/roles');

// mergeParams so the parent `:contractId` is visible inside this router.
const router = express.Router({ mergeParams: true });

// ── Validation schemas ──────────────────────────────────────────────────────

// Per design doc §2.1: productName required, originalCount required, the rest
// optional. plannedNewCount + plannedNewCostPerUnit are explicitly nullable
// (null = "owner hasn't decided yet", distinct from 0).
const NULL_OR_INT_NONNEG = z.union([z.number().int().nonnegative(), z.null()]);
const NULL_OR_DECIMAL    = z.union([z.number().nonnegative(), z.null()]);

const CreateBodySchema = z.object({
  sku:                   z.string().max(200).nullish(),
  productName:           z.string().max(500).optional(),
  originalCount:         z.number().int().min(0).max(10_000_000),
  originalCostPerUnit:   NULL_OR_DECIMAL.optional(),
  plannedNewCount:       NULL_OR_INT_NONNEG.optional(),
  plannedNewCostPerUnit: NULL_OR_DECIMAL.optional(),
  notes:                 z.string().max(4000).nullish(),
  sortOrder:             z.number().int().nonnegative().max(100_000).optional(),
});

// PUT is partial — every editable field is optional. Treat undefined as
// "don't touch" and explicit null as "clear this value". originalCount /
// originalCostPerUnit are intentionally NOT editable here (design doc §2.1:
// immutable after insert; delete + recreate to fix wrong baseline).
const UpdateBodySchema = z.object({
  sku:                   z.string().max(200).nullish(),
  productName:           z.string().max(500).nullish(),
  originalCount:         z.number().int().min(0).max(10_000_000).optional(),
  originalCostPerUnit:   NULL_OR_DECIMAL.optional(),
  plannedNewCount:       NULL_OR_INT_NONNEG.optional(),
  plannedNewCostPerUnit: NULL_OR_DECIMAL.optional(),
  notes:                 z.string().max(4000).nullish(),
  sortOrder:             z.number().int().nonnegative().max(100_000).optional(),
});

// ── Helpers ─────────────────────────────────────────────────────────────────

// Asserts the contract exists and belongs to the caller's account. Returns
// the contract row if so; sends 404 and returns null if not.
//
// Used at the top of every endpoint to avoid IDOR (referencing line items on
// a contract the caller can't see).
async function loadContractOrSend404(req, res) {
  const contractId = req.params.contractId;
  if (!contractId) {
    res.status(400).json({ success: false, error: 'contractId path param required' });
    return null;
  }
  // C3 (audit Critical, 2026-05-22): when the caller is a
  // contractScopeRestricted user (manager/viewer assigned to specific
  // contracts), AND internalOwnerId so they cannot URL-poke into a
  // contract outside their assignment. Mirrors `contractWhereForUser`
  // in contracts.js:153-157 -- same chokepoint pattern. 404 (not 403)
  // by design: leaks no information about whether the id exists.
  const contract = await prisma.contract.findFirst({
    where: {
      id: contractId,
      accountId: req.user.accountId,
      ...(req.user.contractScopeRestricted ? { internalOwnerId: req.user.id } : {}),
    },
  });
  if (!contract) {
    res.status(404).json({ success: false, error: 'contract not found' });
    return null;
  }
  return contract;
}

// Recompute Contract.totalValue = sum(originalCount * originalCostPerUnit)
// across non-archived line items. Falls back to leaving the existing value
// alone if the contract has no line items yet (legacy single-row path keeps
// working via the existing POST/PUT handlers on Contract).
async function denormalizeContractTotalValue(contractId) {
  const lineItems = await prisma.contractLineItem.findMany({
    where:  { contractId, archivedAt: null },
    select: { originalCount: true, originalCostPerUnit: true },
  });
  if (lineItems.length === 0) return; // legacy path stays authoritative

  let sum = 0;
  for (const li of lineItems) {
    const unit = li.originalCostPerUnit == null ? 0 : Number(li.originalCostPerUnit);
    sum += (li.originalCount || 0) * unit;
  }
  // Round to 2 decimals to match Decimal(14,2) — JS float arithmetic can
  // produce things like 80999.99999998 which would round-trip ugly.
  const rounded = Math.round(sum * 100) / 100;
  await prisma.contract.update({
    where: { id: contractId },
    data:  { totalValue: rounded },
  });
}

// Convert a Prisma row to the JSON shape the client expects. Decimals are
// serialized by Prisma as strings to avoid float precision loss; we coerce
// them to Number for the client because the planning math is sized so 4
// decimals is plenty of precision and a Number is friendlier in JS.
function toApi(li) {
  return {
    id:                    li.id,
    contractId:            li.contractId,
    sku:                   li.sku,
    productName:           li.productName,
    originalCount:         li.originalCount,
    originalCostPerUnit:   li.originalCostPerUnit == null ? null : Number(li.originalCostPerUnit),
    plannedNewCount:       li.plannedNewCount,
    plannedNewCostPerUnit: li.plannedNewCostPerUnit == null ? null : Number(li.plannedNewCostPerUnit),
    notes:                 li.notes,
    sortOrder:             li.sortOrder,
    archivedAt:            li.archivedAt,
    updatedAt:             li.updatedAt,
    lastEditedById:        li.lastEditedById,
  };
}

// ── GET /api/contracts/:contractId/line-items ───────────────────────────────
// List non-archived line items for the contract, plus the cover totals so the
// UI can render "Current annual total" + "Projected new total" without a
// second query.
router.get('/', async (req, res) => {
  const contract = await loadContractOrSend404(req, res);
  if (!contract) return;

  const rows = await prisma.contractLineItem.findMany({
    where:   { contractId: contract.id, archivedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });

  // Cover math. Original total uses what they signed for; projected uses
  // plannedNewCount (falls back to originalCount when null) × the new
  // per-unit (falls back to original per-unit when null).
  let originalTotal = 0;
  let projectedTotal = 0;
  for (const r of rows) {
    const origUnit  = r.originalCostPerUnit == null ? 0 : Number(r.originalCostPerUnit);
    const planUnit  = r.plannedNewCostPerUnit == null ? origUnit : Number(r.plannedNewCostPerUnit);
    const planCount = r.plannedNewCount == null ? r.originalCount : r.plannedNewCount;
    originalTotal  += (r.originalCount || 0) * origUnit;
    projectedTotal += (planCount || 0) * planUnit;
  }

  res.json({
    success: true,
    data: {
      lineItems:      rows.map(toApi),
      originalTotal:  Math.round(originalTotal * 100) / 100,
      projectedTotal: Math.round(projectedTotal * 100) / 100,
      delta:          Math.round((projectedTotal - originalTotal) * 100) / 100,
    },
  });
});

// ── POST /api/contracts/:contractId/line-items ──────────────────────────────
// Create one new line item. Body validated by CreateBodySchema. Returns the
// created row + the contract's updated cover totals.
router.post('/', requireManager, async (req, res) => {
  const contract = await loadContractOrSend404(req, res);
  if (!contract) return;

  const parsed = CreateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error:   'invalid line item payload',
      details: parsed.error.flatten(),
    });
  }

  const created = await prisma.contractLineItem.create({
    data: {
      contractId:            contract.id,
      sku:                   parsed.data.sku ?? null,
      productName:           parsed.data.productName ?? '',
      originalCount:         parsed.data.originalCount,
      originalCostPerUnit:   parsed.data.originalCostPerUnit ?? null,
      plannedNewCount:       parsed.data.plannedNewCount ?? null,
      plannedNewCostPerUnit: parsed.data.plannedNewCostPerUnit ?? null,
      notes:                 parsed.data.notes ?? null,
      sortOrder:             parsed.data.sortOrder ?? 0,
      lastEditedById:        req.user.id,
    },
  });

  await denormalizeContractTotalValue(contract.id);

  res.status(201).json({ success: true, data: { lineItem: toApi(created) } });
});

// ── PUT /api/contracts/:contractId/line-items/:lineItemId ───────────────────
// Partial update. Header `If-Match` carries the row's expected `updatedAt` ISO
// timestamp; mismatch returns 409 with the current row so the client can run
// merge UI.
//
// Body fields not present are left untouched. Explicit null clears the field
// (e.g. PUT { plannedNewCount: null } sets "owner hasn't decided yet").
router.put('/:lineItemId', requireManager, async (req, res) => {
  const contract = await loadContractOrSend404(req, res);
  if (!contract) return;

  const lineItemId = req.params.lineItemId;
  const existing = await prisma.contractLineItem.findFirst({
    where: { id: lineItemId, contractId: contract.id },
  });
  if (!existing) {
    return res.status(404).json({ success: false, error: 'line item not found' });
  }

  // If-Match concurrent-edit guard. Only enforced if the header is sent;
  // bulk/offline flows may omit it.
  const ifMatch = req.get('If-Match');
  if (ifMatch) {
    const currentStamp = existing.updatedAt instanceof Date
      ? existing.updatedAt.toISOString()
      : new Date(existing.updatedAt).toISOString();
    if (ifMatch !== currentStamp) {
      return res.status(409).json({
        success: false,
        code:    'conflict',
        error:   'line item changed by another editor — pull current state and re-apply',
        current: toApi(existing),
      });
    }
  }

  const parsed = UpdateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error:   'invalid line item update',
      details: parsed.error.flatten(),
    });
  }

  // Build the update payload — only fields explicitly present in the body get
  // written. zod's parser returns the body as-is; we walk keys to distinguish
  // "field absent" (skip) from "field present and null" (clear).
  const updateData: any = { lastEditedById: req.user.id };
  for (const k of ['sku', 'productName', 'originalCount', 'originalCostPerUnit', 'plannedNewCount', 'plannedNewCostPerUnit', 'notes', 'sortOrder']) {
    if (k in parsed.data) {
      updateData[k] = parsed.data[k];
    }
  }
  // #17: productName is NOT NULL in schema; a cleared name arrives as null
  // (placeholder-driven). Coerce to '' so a row can exist nameless.
  if ('productName' in updateData && updateData.productName == null) updateData.productName = '';

  const updated = await prisma.contractLineItem.update({
    where: { id: existing.id },
    data:  updateData,
  });

  // Only recompute totalValue when something affecting it changed — for now
  // that's plannedNewCount (no effect since totalValue uses originalCount),
  // but kept for forward-compat in case originalCount/originalCostPerUnit
  // become editable later.
  await denormalizeContractTotalValue(contract.id);

  res.json({ success: true, data: { lineItem: toApi(updated) } });
});

// ── DELETE /api/contracts/:contractId/line-items/:lineItemId ────────────────
// Soft-archive (sets archivedAt). Hard delete intentionally not exposed —
// snapshots preserve the historical record and an accidentally-archived row
// can be restored by clearing archivedAt (admin SQL for now; UI in v0.56).
router.delete('/:lineItemId', requireManager, async (req, res) => {
  const contract = await loadContractOrSend404(req, res);
  if (!contract) return;

  const lineItemId = req.params.lineItemId;
  const existing = await prisma.contractLineItem.findFirst({
    where: { id: lineItemId, contractId: contract.id },
  });
  if (!existing) {
    return res.status(404).json({ success: false, error: 'line item not found' });
  }
  if (existing.archivedAt) {
    return res.json({ success: true, data: { lineItem: toApi(existing), noop: true } });
  }

  const archived = await prisma.contractLineItem.update({
    where: { id: existing.id },
    data:  { archivedAt: new Date(), lastEditedById: req.user.id },
  });

  await denormalizeContractTotalValue(contract.id);

  res.json({ success: true, data: { lineItem: toApi(archived) } });
});

// -- POST /api/contracts/:contractId/line-items/seed --------------------------
// #14 contract-section-refresh: auto-populate the planning table from the
// contract's invoiced baseline (product, quantity, costPerLicense) the first
// time the panel is viewed. Idempotent + guarded on the TOTAL count (including
// archived rows) so archiving the seeded row does NOT make it reappear.
router.post('/seed', requireManager, async (req, res) => {
  const contract = await loadContractOrSend404(req, res);
  if (!contract) return;

  const total = await prisma.contractLineItem.count({ where: { contractId: contract.id } });
  if (total > 0) {
    return res.json({ success: true, data: { seeded: false, reason: 'already-has-line-items' } });
  }
  if (!contract.product || !String(contract.product).trim()) {
    return res.json({ success: true, data: { seeded: false, reason: 'no-product' } });
  }

  const created = await prisma.contractLineItem.create({
    data: {
      contractId:            contract.id,
      sku:                   null,
      productName:           contract.product,
      originalCount:         contract.quantity ?? 0,
      originalCostPerUnit:   contract.costPerLicense == null ? null : Number(contract.costPerLicense),
      plannedNewCount:       null,
      plannedNewCostPerUnit: null,
      notes:                 null,
      sortOrder:             0,
      lastEditedById:        req.user.id,
    },
  });

  await denormalizeContractTotalValue(contract.id);
  res.status(201).json({ success: true, data: { seeded: true, lineItem: toApi(created) } });
});

module.exports = router;

export {};
