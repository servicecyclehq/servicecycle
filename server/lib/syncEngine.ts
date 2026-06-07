/**
 * lib/syncEngine.js
 *
 * Cloud marketplace sync engine.
 *
 * Takes an array of normalized purchase records from a cloud connector's
 * fetchPurchases() and upserts them into LapseIQ as Contracts.
 *
 * Dedup key: (accountId, syncSource, externalId) -- contracts synced from the
 * same provider+externalId are updated in place rather than duplicated.
 *
 * Vendor lookup/create: vendors are matched by name (case-insensitive, trimmed).
 * If no match exists, a new vendor record is created automatically.
 *
 * Status: returns a summary { created, updated, skipped, errors }.
 */

import prisma from './prisma';

// ── Status normalization ───────────────────────────────────────────────────────

const VALID_STATUSES = new Set(['active', 'under_review', 'renewed', 'cancelled', 'expired']);

function normalizeStatus(rawStatus) {
  if (!rawStatus) return 'active';
  const s = rawStatus.toLowerCase().trim();
  if (VALID_STATUSES.has(s)) return s;
  // Common aliases
  const aliases = {
    complete:    'renewed',
    completed:   'renewed',
    terminated:  'cancelled',
    suspended:   'cancelled',
    inactive:    'expired',
    past_due:    'under_review',
    pending:     'under_review',
    trial:       'active',
  };
  return aliases[s] ?? 'active';
}

// ── Vendor resolution ──────────────────────────────────────────────────────────

/**
 * Find an existing vendor by name (case-insensitive) or create a new one.
 * Caches lookups within a sync run to avoid N+1 queries.
 */
async function resolveVendor(accountId, vendorName, vendorCache, createCtx) {
  // M4: sanitize and cap vendor name length
  const safeName = _sanitizeText(vendorName.trim(), VENDOR_NAME_MAX) || 'Unknown Vendor';
  const key = safeName.toLowerCase();
  if (vendorCache.has(key)) return vendorCache.get(key);

  // Try exact match first, then case-insensitive
  let vendor = await prisma.vendor.findFirst({
    where: {
      accountId,
      name: { equals: safeName, mode: 'insensitive' },
    },
    select: { id: true, name: true },
  });

  if (!vendor) {
    // M4: cap new vendor creations per sync run to prevent publisher-spam bloat
    if (createCtx && createCtx.count >= VENDOR_CREATE_MAX) {
      console.warn(`[syncEngine] Vendor creation cap (${VENDOR_CREATE_MAX}) reached — skipping new vendor "${safeName}"`);
      // Return a minimal stand-in so the record isn't lost
      return { id: null, name: safeName, _capped: true };
    }
    // Create vendor with sensible defaults
    vendor = await prisma.vendor.create({
      data: {
        accountId,
        name: safeName,
        // Cloud vendors don't need co-term complexity by default
        cotermComplexity: 'none',
      },
      select: { id: true, name: true },
    });
    if (createCtx) createCtx.count++;
  }

  vendorCache.set(key, vendor);
  return vendor;
}

// ── Date helpers ───────────────────────────────────────────────────────────────

function safeDate(val) {
  if (!val) return null;
  if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
  try { const d = new Date(val); return isNaN(d.getTime()) ? null : d; } catch { return null; }
}

function computeCancelByDate(endDate, autoRenewal, autoRenewalNoticeDays) {
  if (!endDate || !autoRenewal || !autoRenewalNoticeDays) return null;
  const cancelBy = new Date(endDate);
  // C10 (2026-05-22): use UTC date math so this is stable across DST + non-UTC operators
  cancelBy.setUTCDate(cancelBy.getUTCDate() - autoRenewalNoticeDays);
  return cancelBy;
}

// ── Input sanitization ────────────────────────────────────────────────────────

const VENDOR_NAME_MAX   = 200;  // M4: trim to prevent storage bloat
const LICENSE_KEYS_MAX  = 2048; // L8: 2KB cap per Opus recommendation
const VENDOR_CREATE_MAX = 100;  // M4: max new vendors created per sync run

/**
 * Strip control characters and cap length for free-text fields sourced from
 * cloud provider APIs (L8: attacker-controlled values in licenseKeys etc.)
 */
function _sanitizeText(val, maxLen) {
  if (!val || typeof val !== 'string') return val;
  // Strip C0/C1 control characters (except tab and newline which are fine in keys/notes)
  // eslint-disable-next-line no-control-regex
  const stripped = val.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return stripped.length > maxLen ? stripped.slice(0, maxLen) : stripped;
}

// ── Core sync function ─────────────────────────────────────────────────────────

/**
 * Sync a list of normalized purchase records into LapseIQ contracts.
 *
 * @param {string}   accountId   The LapseIQ account to sync into
 * @param {string}   syncSource  Cloud provider identifier: 'aws' | 'azure' | 'gcp'
 * @param {Array}    records     Normalized purchase records from fetchPurchases()
 * @param {object}   [options]
 * @param {boolean}  [options.dryRun=false]  If true, compute diff but do not write
 * @returns {Promise<SyncResult>}
 */
async function syncPurchases(accountId, syncSource, records, options: any = {}) {
  const { dryRun = false } = options;
  const result = { created: 0, updated: 0, skipped: 0, errors: [], dryRun };

  if (!records || records.length === 0) {
    return result;
  }

  const vendorCache    = new Map();
  let vendorCreateCount = 0; // M4: track new vendor creations this run

  const vendorCreateCtx = { count: 0 }; // M4: mutable counter passed to _syncOneRecord
  for (const record of records) {
    try {
      await _syncOneRecord(accountId, syncSource, record, vendorCache, result, dryRun, vendorCreateCtx);
    } catch (err) {
      console.error(`[syncEngine] Error syncing record ${record.externalId}:`, err.message);
      result.errors.push({
        externalId: record.externalId,
        productName: record.productName,
        error: err.message,
      });
    }
  }

  // Update connector's lastSyncAt timestamp
  if (!dryRun) {
    try {
      await prisma.cloudConnector.updateMany({
        where: { accountId, provider: syncSource },
        data:  { lastSyncAt: new Date(), status: 'connected', lastError: null },
      });
    } catch (err) {
      console.warn('[syncEngine] Failed to update connector lastSyncAt:', err.message);
    }
  }

  return result;
}

async function _syncOneRecord(accountId, syncSource, record, vendorCache, result, dryRun, vendorCreateCtx) {
  // Validate required fields
  if (!record.externalId) {
    result.skipped++;
    return;
  }
  if (!record.productName?.trim()) {
    result.skipped++;
    return;
  }

  const externalId  = record.externalId.trim();
  const vendorName  = (record.vendorName || 'Unknown Vendor').trim();
  const productName = record.productName.trim();

  // Look up or create vendor (M4: passes create counter)
  const vendor = await resolveVendor(accountId, vendorName, vendorCache, vendorCreateCtx);
  if (vendor._capped) {
    // Vendor creation was capped — skip this record rather than writing with null vendorId
    result.skipped++;
    return;
  }

  // Check if a contract with this externalId already exists
  const existing = await prisma.contract.findFirst({
    where: { accountId, syncSource, externalId },
    select: { id: true, status: true },
  });

  // Compute dates
  const startDate          = safeDate(record.startDate);
  const endDate            = safeDate(record.endDate);
  const autoRenewal        = record.autoRenewal === true;
  const autoRenewalDays    = record.autoRenewalNoticeDays ?? null;
  const cancelByDate       = computeCancelByDate(endDate, autoRenewal, autoRenewalDays);
  const status             = normalizeStatus(record.status);

  // Compute total value
  let totalValue = null;
  if (record.totalValue != null && !isNaN(parseFloat(record.totalValue))) {
    totalValue = parseFloat(record.totalValue);
  } else if (record.quantity != null && record.unitPrice != null) {
    totalValue = parseFloat(record.quantity) * parseFloat(record.unitPrice);
  }

  const contractData = {
    vendorId:          vendor.id,
    product:           productName,
    status,
    contractNumber:    record.contractNumber || null,
    customerNumber:    record.customerNumber || null,
    poNumber:          record.poNumber       || null,
    invoiceNumber:     record.invoiceNumber  || null,
    licenseKeys:       record.licenseKeys ? _sanitizeText(record.licenseKeys, LICENSE_KEYS_MAX) : null, // L8
    quantity:          record.quantity != null ? parseInt(record.quantity) : null,
    costPerLicense:    record.unitPrice  != null ? parseFloat(record.unitPrice)  : null,
    totalValue:        totalValue != null ? totalValue : null,
    startDate,
    endDate,
    autoRenewal,
    autoRenewalNoticeDays: autoRenewalDays,
    cancelByDate,
    notes:             record.notes || null,
    // Sync metadata
    externalId,
    syncSource,
  };

  if (dryRun) {
    existing ? result.updated++ : result.created++;
    return;
  }

  if (existing) {
    // Update: only overwrite fields that the cloud provider actually provided.
    // Don't overwrite manually-edited fields like notes or department if the
    // provider sends null -- keep whatever the user set.
    const updateData: any = {};
    for (const [k, v] of Object.entries(contractData)) {
      if (v != null) updateData[k] = v;  // skip null -- preserve existing value
    }
    // Status is always updated (it may have changed upstream)
    updateData.status = status;

    await prisma.contract.update({
      where: { id: existing.id },
      data:  updateData,
    });
    result.updated++;
  } else {
    // Create
    await prisma.contract.create({
      data: {
        accountId,
        ...contractData,
      },
    });
    result.created++;
  }
}

module.exports = { syncPurchases };

export {};
