'use strict';

/**
 * /api/import/assets -- SMART asset importer (generic CSV/XLSX with
 * AI-assisted column mapping). Sibling of routes/assetsImport.ts (the
 * template importer at /api/assets/import): that one expects headers close
 * to our template; THIS one accepts whatever spreadsheet the contractor
 * already has and proposes a mapping (exact / synonym / AI tiers, per-column
 * confidence) for human review before anything is written.
 *
 * Mount (index.ts, with the other import mounts -- report line for the
 * coordinator; namespace /api/import/* is unclaimed so no :id-route shadowing
 * concerns):
 *
 *   const importAssetsRoutes = require('./routes/importAssets'); // SMART CSV/XLSX import (AI mapping)
 *   app.use('/api/import/assets', authenticateToken, ingestLimiter, importAssetsRoutes);
 *
 * Endpoints (both requireManager; every query scoped accountId =
 * req.user.accountId):
 *
 *   POST /preview  multipart `file=<csv|xlsx>` OR form/JSON field
 *                  `text=<pasted CSV>`; optional `mapping` JSON (header ->
 *                  field) to re-validate a user-edited mapping without
 *                  re-running the guess/AI pass. NO writes (only reads the
 *                  account's CustomFieldDefinitions). Returns headers, the
 *                  proposed mapping with per-column confidence + source
 *                  (exact | synonym | ai | user), per-column sample values,
 *                  per-row validation, unmapped columns, and the parsed rows
 *                  (the client holds them and echoes them to /commit -- the
 *                  file is parsed exactly once, server-side).
 *
 *   POST /commit   fields: `rows` (JSON array of row objects keyed by
 *                  header), `mapping` (JSON header->field), `allowCreateSites`
 *                  ('true'|'false', default false). The server RE-VALIDATES
 *                  everything (mapping keys, required fields, every cell) --
 *                  the client payload is never trusted. Writes happen in one
 *                  prisma.$transaction. Per-row outcomes:
 *                    created            asset inserted (assetId returned)
 *                    skipped_duplicate  resolveAsset-style identity hit:
 *                                       normalized-serial match (O->0, I->1,
 *                                       separators stripped -- mirrors
 *                                       lib/assetIdentity.normalizeSerial)
 *                                       strengthened by manufacturer (a
 *                                       conflicting manufacturer on both
 *                                       sides vetoes the match); serial-less
 *                                       rows fall back to the identity tuple
 *                                       site+type+manufacturer+model+position
 *                                       (requires at least one of mfr/model/
 *                                       position -- a bare site+type row has
 *                                       no identity and always creates).
 *                                       In-file repeats skip the same way, so
 *                                       RE-RUNNING THE SAME FILE DOES NOT
 *                                       DUPLICATE.
 *                    error              validation / unknown-site / hierarchy
 *                                       conflict; row not written.
 *                  Unknown sites are created ONLY when allowCreateSites=true
 *                  (rows referencing unknown sites otherwise land as per-row
 *                  errors -- partial success, never all-or-nothing).
 *                  Building/area/position names are matched case-insensitively
 *                  under the row's site and auto-created only under the same
 *                  flag (mirrors assetsImport.ts createMissingSites).
 *
 * Caps: 500 data rows / 5MB per request (shared with lib/importMapping).
 * Activity log: ONE `assets_imported` row per commit with counts.
 * AI fail-soft: lib/importMapping.aiAssistMapping returns {} on AI_ENABLED
 * =false / provider error / bad JSON -- the deterministic tiers always stand
 * alone and AI can never block or degrade an import.
 *
 * Deliberately NOT here (scope): schedule auto-apply (assetsImport.ts N5) --
 * follow-up wiring, see the module trailer comment.
 */

const router = require('express').Router();
const multer = require('multer');

const { requireManager } = require('../middleware/roles');
const { writeLog: writeActivityLog } = require('../lib/activityLog');
const prisma = require('../lib/prisma').default;
const { validateValueForDefinition } = require('./customFields');
const im = require('../lib/importMapping');

const MAX_IMPORT_ROWS  = im.MAX_IMPORT_ROWS;
const MAX_IMPORT_BYTES = im.MAX_IMPORT_BYTES;

const lc = (s: any) => String(s == null ? '' : s).trim().toLowerCase();

// --- Upload plumbing (multer memoryStorage, same posture as assetsImport) ---
// fieldSize is raised above the global express.json 200kb cap because pasted
// CSV text (preview) and the rows echo (commit) travel as multipart form
// fields; the global JSON body limit stays untouched (SEC-011).
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 20, fieldSize: MAX_IMPORT_BYTES + 1024 * 1024 },
  fileFilter: (req: any, file: any, cb: any) => {
    const name = file.originalname || '';
    if (!/\.csv$/i.test(name) && !/\.(xlsx|xls)$/i.test(name)) {
      return cb(new Error('Only .csv or .xlsx files are accepted'));
    }
    return cb(null, true);
  },
});

function handleUpload(req: any, res: any, next: any) {
  importUpload.single('file')(req, res, (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FIELD_VALUE') {
        return res.status(413).json({ success: false, error: `Payload exceeds ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)}MB cap` });
      }
      return res.status(400).json({ success: false, error: err.message || 'Upload failed' });
    }
    return next();
  });
}

// --- Shared helpers ----------------------------------------------------------

/** Active custom-field definitions for this account (tenancy: accountId). */
async function loadCustomFieldDefs(accountId: string): Promise<any[]> {
  return prisma.customFieldDefinition.findMany({
    where:   { accountId, archivedAt: null },
    orderBy: { displayOrder: 'asc' },
  });
}

/**
 * Parse the request into { headers, rows }: uploaded file (multer buffer) or
 * pasted CSV text. Returns { error: { status, message } } on any input problem.
 */
async function readTabularInput(req: any): Promise<any> {
  if (req.file && req.file.buffer) {
    try {
      return await im.parseUploadBuffer(req.file.buffer, req.file.originalname);
    } catch (e: any) {
      return { error: { status: 400, message: `File parse error: ${e.message}` } };
    }
  }
  const text = req.body ? req.body.text : null;
  if (typeof text === 'string' && text.trim() !== '') {
    if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) {
      return { error: { status: 413, message: `Pasted text exceeds ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)}MB cap` } };
    }
    return im.parseCsvText(text);
  }
  return { error: { status: 400, message: 'Provide a .csv/.xlsx file upload or pasted CSV text' } };
}

/**
 * Sanitize a client-supplied { header: fieldKey|null } map: JSON-parse when it
 * arrives as a multipart string, require a plain object, and null out target
 * keys that are neither core fields nor cf:<id> of an ACTIVE definition on
 * THIS account -- a stale/hostile client cannot write arbitrary columns.
 */
function sanitizeClientMapping(raw: any, validKeys: Set<string>): any {
  let mapping = raw;
  if (typeof mapping === 'string') {
    try { mapping = JSON.parse(mapping); }
    catch { return { error: 'mapping must be valid JSON' }; }
  }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return { error: 'mapping must be a JSON object of { column: field }' };
  }
  const clean: any = {};
  for (const [header, field] of Object.entries<any>(mapping)) {
    clean[header] = (typeof field === 'string' && validKeys.has(field)) ? field : null;
  }
  return { mapping: clean };
}

/** Labels of required target fields missing from a { header: field } map. */
function missingRequiredFields(fieldByHeader: any): string[] {
  const mapped = new Set(Object.values<any>(fieldByHeader || {}).filter(Boolean));
  const missing: string[] = [];
  for (const f of im.TARGET_FIELDS) {
    if (f.required && !mapped.has(f.key)) missing.push(f.label);
  }
  return missing;
}

function validationSummary(rowResults: any[]): any {
  const errors = rowResults.filter((r) => !r.ok).map((r) => ({ row: r.row, errors: r.errors }));
  return {
    totalRows:  rowResults.length,
    validCount: rowResults.length - errors.length,
    errorCount: errors.length,
    errors:     errors.slice(0, 200), // response-size guard; counts stay exact
  };
}

// --- POST /api/import/assets/preview ----------------------------------------
router.post('/preview', requireManager, handleUpload, async (req: any, res: any) => {
  try {
    const parsed = await readTabularInput(req);
    if (parsed.error) return res.status(parsed.error.status).json({ success: false, error: parsed.error.message });

    const { headers, rows } = parsed;
    if (!headers || headers.length === 0) {
      return res.status(400).json({ success: false, error: 'No header row found' });
    }
    if (!rows || rows.length === 0) {
      return res.status(400).json({ success: false, error: 'No data rows found' });
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      return res.status(400).json({ success: false, error: `Import exceeds ${MAX_IMPORT_ROWS}-row cap (${rows.length} rows)` });
    }

    const defs         = await loadCustomFieldDefs(req.user.accountId);
    const targetFields = im.TARGET_FIELDS.concat(im.customFieldTargets(defs));
    const validKeys    = new Set<string>(targetFields.map((f: any) => f.key));

    // Mapping: user-edited re-validation pass, or fresh guess + AI assist.
    let proposals: any;
    let aiUsed = false;
    if (req.body && req.body.mapping != null) {
      const s = sanitizeClientMapping(req.body.mapping, validKeys);
      if (s.error) return res.status(400).json({ success: false, error: s.error });
      proposals = {};
      for (const h of headers) {
        const field = Object.prototype.hasOwnProperty.call(s.mapping, h) ? s.mapping[h] : null;
        proposals[h] = field
          ? { field, confidence: 1, source: 'user' }
          : { field: null, confidence: 0, source: null };
      }
    } else {
      proposals = im.guessMapping(headers, rows, defs);

      // AI assist for whatever the deterministic tiers left unresolved.
      // Fail-soft by contract: any AI problem returns {} and we proceed.
      const unresolved = headers.filter((h: string) => !proposals[h] || !proposals[h].field);
      if (unresolved.length > 0) {
        const allSamples  = im.sampleColumns(headers, rows);
        const aiColumns   = allSamples.filter((c: any) => unresolved.includes(c.header));
        const aiProposals = await im.aiAssistMapping(aiColumns, targetFields);
        const claimed     = new Set(Object.values<any>(proposals).map((p: any) => p && p.field).filter(Boolean));
        for (const [header, p] of Object.entries<any>(aiProposals)) {
          if (!proposals[header] || proposals[header].field) continue; // AI never overrides deterministic
          if (claimed.has(p.field)) continue;                          // ...nor steals a claimed target
          proposals[header] = p;
          claimed.add(p.field);
          aiUsed = true;
        }
      }
      proposals = im.dedupeMapping(proposals);
    }

    const fieldByHeader: any = {};
    for (const h of headers) fieldByHeader[h] = proposals[h] ? proposals[h].field : null;

    const customFieldById = new Map(defs.map((d: any) => [d.id, d]));
    const rowResults = im.validateRows(rows, fieldByHeader, {
      customFieldById,
      validateCustomValue: validateValueForDefinition,
    });

    return res.json({
      success: true,
      data: {
        step:            'preview',
        totalRows:       rows.length,
        headers,
        mapping:         proposals,                    // { header: { field, confidence, source } }
        targetFields,                                  // dropdown vocabulary (core + cf:*)
        columns:         im.sampleColumns(headers, rows),
        sampleRows:      rows.slice(0, 10),
        rows,                                          // client echoes these to /commit
        validation:      validationSummary(rowResults),
        unmappedColumns: headers.filter((h: string) => !fieldByHeader[h]),
        missingRequired: missingRequiredFields(fieldByHeader),
        duplicateTargets: im.findDuplicateTargets(fieldByHeader),
        aiUsed,
        limits: { maxRows: MAX_IMPORT_ROWS, maxBytes: MAX_IMPORT_BYTES },
      },
    });
  } catch (err: any) {
    console.error('POST /api/import/assets/preview error:', err);
    return res.status(500).json({ success: false, error: 'Import preview failed' });
  }
});

// --- Duplicate detection (commit) --------------------------------------------
// Serial tier: account-wide normalized-serial map (the fold cannot be pushed
// into SQL, so we pull the serialed slice once -- same bound resolveAsset
// uses). Manufacturer strengthens the match: when BOTH sides carry one and
// they disagree, the serial hit is vetoed (two vendors can share a serial
// format). Tuple tier for serial-less rows: site+type+mfr+model+position.
async function buildDuplicateIndexes(accountId: string, creatable: any[], siteByLc: Map<string, any>): Promise<any> {
  const bySerial = new Map<string, any[]>(); // normSerial -> [{ id, manufacturer }]
  const anySerial = creatable.some((c) => c.normalized.serialNumber);
  if (anySerial) {
    const serialed = await prisma.asset.findMany({
      where:  { accountId, archivedAt: null, serialNumber: { not: null } },
      select: { id: true, serialNumber: true, manufacturer: true },
      take:   5000,
    });
    for (const a of serialed) {
      const k = im.normalizeSerial(a.serialNumber);
      if (!k) continue;
      if (!bySerial.has(k)) bySerial.set(k, []);
      bySerial.get(k)!.push(a);
    }
  }

  const byTuple = new Map<string, string>(); // siteId|type|mfr|model|position -> assetId
  const knownSiteIds = [...new Set([...siteByLc.values()].map((s: any) => s.id))];
  const tupleTypes = [...new Set(
    creatable
      .filter((c) => !c.normalized.serialNumber &&
        (c.normalized.manufacturer || c.normalized.model || c.normalized.positionName))
      .map((c) => c.normalized.equipmentType)
  )];
  if (knownSiteIds.length > 0 && tupleTypes.length > 0) {
    const tupleAssets = await prisma.asset.findMany({
      where:  { accountId, archivedAt: null, siteId: { in: knownSiteIds }, equipmentType: { in: tupleTypes as any } },
      select: { id: true, siteId: true, equipmentType: true, manufacturer: true, model: true, position: { select: { name: true } } },
    });
    for (const a of tupleAssets) {
      const k = `${a.siteId}|${a.equipmentType}|${lc(a.manufacturer)}|${lc(a.model)}|${lc(a.position ? a.position.name : '')}`;
      if (!byTuple.has(k)) byTuple.set(k, a.id);
    }
  }
  return { bySerial, byTuple };
}

/**
 * Classify creatable rows against the DB indexes + in-file repeats.
 * Returns Map<rowNum, { existingAssetId, reason }> for rows to skip.
 */
function findDuplicates(creatable: any[], indexes: any, siteByLc: Map<string, any>): Map<number, any> {
  const dupByRow = new Map<number, any>();
  const seenSerials = new Set<string>();
  const seenTuples  = new Set<string>();

  for (const c of creatable) {
    const n = c.normalized;
    const serialNorm = im.normalizeSerial(n.serialNumber);

    if (serialNorm) {
      if (seenSerials.has(serialNorm)) {
        dupByRow.set(c.row, { existingAssetId: null, reason: 'Serial number repeats earlier in this file' });
        continue;
      }
      const rowMfr = lc(n.manufacturer);
      const hit = (indexes.bySerial.get(serialNorm) || []).find((a: any) => {
        const exMfr = lc(a.manufacturer);
        return !rowMfr || !exMfr || rowMfr === exMfr; // conflicting manufacturers veto
      });
      if (hit) {
        dupByRow.set(c.row, { existingAssetId: hit.id, reason: 'Serial number matches an existing asset' });
        continue;
      }
      seenSerials.add(serialNorm);
      continue;
    }

    // Serial-less: identity tuple, only when something distinguishes the row.
    if (!(n.manufacturer || n.model || n.positionName)) continue;
    const tail = `${n.equipmentType}|${lc(n.manufacturer)}|${lc(n.model)}|${lc(n.positionName)}`;
    const nameKey = `${lc(n.siteName)}|${tail}`;
    if (seenTuples.has(nameKey)) {
      dupByRow.set(c.row, { existingAssetId: null, reason: 'Identical asset repeats earlier in this file' });
      continue;
    }
    const site = siteByLc.get(lc(n.siteName));
    const existingId = site ? indexes.byTuple.get(`${site.id}|${tail}`) : null;
    if (existingId) {
      dupByRow.set(c.row, { existingAssetId: existingId, reason: 'Matching asset already exists at this site (type, manufacturer, model, position)' });
      continue;
    }
    seenTuples.add(nameKey);
  }
  return dupByRow;
}

// --- POST /api/import/assets/commit ------------------------------------------
router.post('/commit', requireManager, handleUpload, async (req: any, res: any) => {
  try {
    const accountId = req.user.accountId;

    // rows -- JSON array of { header: cell } objects (multipart string or JSON body).
    let rows = req.body ? req.body.rows : null;
    if (typeof rows === 'string') {
      try { rows = JSON.parse(rows); }
      catch { return res.status(400).json({ success: false, error: 'rows must be valid JSON' }); }
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ success: false, error: 'rows must be a non-empty JSON array' });
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      return res.status(400).json({ success: false, error: `Import exceeds ${MAX_IMPORT_ROWS}-row cap (${rows.length} rows)` });
    }
    if (rows.some((r: any) => !r || typeof r !== 'object' || Array.isArray(r))) {
      return res.status(400).json({ success: false, error: 'Every row must be an object of { column: value }' });
    }

    // mapping -- required; server-side sanitize against THIS account's targets.
    if (req.body.mapping == null) {
      return res.status(400).json({ success: false, error: 'mapping is required on commit' });
    }
    const defs      = await loadCustomFieldDefs(accountId);
    const validKeys = new Set<string>(im.TARGET_FIELDS.map((f: any) => f.key));
    for (const d of defs) validKeys.add(`cf:${d.id}`);
    const s = sanitizeClientMapping(req.body.mapping, validKeys);
    if (s.error) return res.status(400).json({ success: false, error: s.error });
    const mapping = s.mapping;

    const dupTargets = im.findDuplicateTargets(mapping);
    if (dupTargets.length > 0) {
      return res.status(400).json({ success: false, error: `Multiple columns map to the same field: ${dupTargets.join(', ')}` });
    }
    const missingRequired = missingRequiredFields(mapping);
    if (missingRequired.length > 0) {
      return res.status(400).json({ success: false, error: `Missing required column(s): ${missingRequired.join(', ')}. Map a column to each.` });
    }

    const allowCreateSites = String(req.body.allowCreateSites || '').toLowerCase() === 'true';

    // Server re-validation of every row -- the preview's verdicts are not trusted.
    const customFieldById = new Map(defs.map((d: any) => [d.id, d]));
    const rowResults = im.validateRows(rows, mapping, {
      customFieldById,
      validateCustomValue: validateValueForDefinition,
    });

    // Site resolution -- case-insensitive, scoped to the file's distinct names
    // (assetsImport COMP-8-12 / REGRESS-9-1 pattern).
    const creatable = rowResults.filter((r: any) => r.ok);
    const siteNames = [...new Set(
      creatable.map((c: any) => String(c.normalized.siteName).trim()).filter((t: string) => t.length > 0)
    )];
    const siteRecords = siteNames.length === 0 ? [] : await prisma.site.findMany({
      where:  { accountId, OR: siteNames.map((name: string) => ({ name: { equals: name, mode: 'insensitive' as const } })) },
      select: { id: true, name: true },
    });
    const siteByLc = new Map<string, any>(siteRecords.map((r: any) => [lc(r.name), r]));

    // Duplicates (DB + in-file) among creatable rows.
    const indexes  = await buildDuplicateIndexes(accountId, creatable, siteByLc);
    const dupByRow = findDuplicates(creatable, indexes, siteByLc);

    // Unknown sites referenced by rows that would actually be created.
    const unknownSiteByRow = new Map<number, string>();
    const unknownSites: string[] = [];
    for (const c of creatable) {
      if (dupByRow.has(c.row)) continue;
      const key = lc(c.normalized.siteName);
      if (siteByLc.has(key)) continue;
      unknownSiteByRow.set(c.row, c.normalized.siteName);
      if (!unknownSites.some((n) => lc(n) === key)) unknownSites.push(c.normalized.siteName);
    }

    // Hierarchy caches -- preload for sites that already exist (created-in-tx
    // sites are brand new and have nothing to preload).
    const knownSiteIds = [...new Set([...siteByLc.values()].map((r: any) => r.id))];
    const [allBuildings, allAreas, allPositions] = knownSiteIds.length === 0
      ? [[], [], []]
      : await Promise.all([
          prisma.building.findMany({ where: { accountId, siteId: { in: knownSiteIds } }, select: { id: true, siteId: true, name: true } }),
          prisma.area.findMany({ where: { accountId, siteId: { in: knownSiteIds } }, select: { id: true, siteId: true, buildingId: true, name: true } }),
          prisma.equipmentPosition.findMany({ where: { accountId, siteId: { in: knownSiteIds } }, select: { id: true, siteId: true, areaId: true, name: true } }),
        ]);
    const buildingCache = new Map(allBuildings.map((b: any) => [`${b.siteId}|${lc(b.name)}`, b]));
    const areaCache     = new Map(allAreas.map((a: any) => [`${a.siteId}|${lc(a.name)}`, a]));
    const positionCache = new Map(allPositions.map((p: any) => [`${p.siteId}|${lc(p.name)}`, p]));

    const resultByRow = new Map<number, any>(); // rowNum -> outcome object (sans row key)

    let txResult;
    try {
      txResult = await prisma.$transaction(async (tx: any) => {
        let sitesCreated = 0;
        if (allowCreateSites) {
          for (const name of unknownSites) {
            const site = await tx.site.create({
              data:   { accountId, name: im.sanitizeFormulaPrefix(String(name).trim()) },
              select: { id: true, name: true },
            });
            siteByLc.set(lc(name), site);
            sitesCreated++;
          }
        }

        let created = 0;
        for (const r of rowResults) {
          if (!r.ok) {
            resultByRow.set(r.row, { outcome: 'error', errors: r.errors });
            continue;
          }
          const dup = dupByRow.get(r.row);
          if (dup) {
            resultByRow.set(r.row, { outcome: 'skipped_duplicate', existingAssetId: dup.existingAssetId, reason: dup.reason });
            continue;
          }
          if (!allowCreateSites && unknownSiteByRow.has(r.row)) {
            resultByRow.set(r.row, {
              outcome: 'error',
              errors:  [{ field: 'siteName', error: `Unknown site "${unknownSiteByRow.get(r.row)}" -- enable "create missing sites" or fix the name` }],
            });
            continue;
          }

          const n = r.normalized;
          const site = siteByLc.get(lc(n.siteName));
          if (!site) {
            // Unreachable in practice (either created above or flagged), kept defensive.
            resultByRow.set(r.row, { outcome: 'error', errors: [{ field: 'siteName', error: 'Site not found in account' }] });
            continue;
          }

          // Hierarchy: match case-insensitively under the site; create only
          // under allowCreateSites; chain-consistency rules from assetsImport.
          let buildingId: any = null, areaId: any = null, positionId: any = null;
          let linkError: any = null;

          if (n.buildingName) {
            const bKey = `${site.id}|${lc(n.buildingName)}`;
            let b: any = buildingCache.get(bKey);
            if (!b && allowCreateSites) {
              b = await tx.building.create({
                data:   { accountId, siteId: site.id, name: im.sanitizeFormulaPrefix(String(n.buildingName).trim()) },
                select: { id: true, siteId: true, name: true },
              });
              buildingCache.set(bKey, b);
            }
            if (b) buildingId = b.id;
          }

          if (n.areaName) {
            const aKey = `${site.id}|${lc(n.areaName)}`;
            let a: any = areaCache.get(aKey);
            if (!a && allowCreateSites) {
              a = await tx.area.create({
                data:   { accountId, siteId: site.id, buildingId: buildingId || null, name: im.sanitizeFormulaPrefix(String(n.areaName).trim()) },
                select: { id: true, siteId: true, buildingId: true, name: true },
              });
              areaCache.set(aKey, a);
            }
            if (a) {
              if (buildingId && a.buildingId && a.buildingId !== buildingId) {
                linkError = { field: 'areaName', error: `Area "${n.areaName}" belongs to a different building at this site` };
              } else {
                areaId = a.id;
                if (!buildingId && a.buildingId) buildingId = a.buildingId;
              }
            }
          }

          if (!linkError && n.positionName) {
            const pKey = `${site.id}|${lc(n.positionName)}`;
            let p: any = positionCache.get(pKey);
            if (!p && allowCreateSites) {
              p = await tx.equipmentPosition.create({
                data:   { accountId, siteId: site.id, areaId: areaId || null, name: im.sanitizeFormulaPrefix(String(n.positionName).trim()) },
                select: { id: true, siteId: true, areaId: true, name: true },
              });
              positionCache.set(pKey, p);
            }
            if (p) {
              if (areaId && p.areaId && p.areaId !== areaId) {
                linkError = { field: 'positionName', error: `Position "${n.positionName}" belongs to a different area at this site` };
              } else {
                positionId = p.id;
              }
            }
          }

          if (linkError) {
            resultByRow.set(r.row, { outcome: 'error', errors: [linkError] });
            continue;
          }

          // NFPA 70B defaults: each unset axis is C2; governing = worst axis.
          const physical    = n.conditionPhysical    || 'C2';
          const criticality = n.conditionCriticality || 'C2';
          const environment = n.conditionEnvironment || 'C2';

          const conditionScore   = n.conditionScore   ?? null;
          const criticalityScore = n.criticalityScore ?? null;
          const priorityScore = (conditionScore != null && criticalityScore != null)
            ? conditionScore * criticalityScore
            : null;

          const nameplateData = (n.nameplate && Object.keys(n.nameplate).length > 0) ? n.nameplate : undefined;

          const asset = await tx.asset.create({
            data: {
              accountId,
              siteId:               site.id,
              buildingId,
              areaId,
              positionId,
              equipmentType:        n.equipmentType,
              manufacturer:         n.manufacturer || null,
              model:                n.model || null,
              serialNumber:         n.serialNumber || null,
              installDate:          n.installDate || null,
              conditionPhysical:    physical,
              conditionCriticality: criticality,
              conditionEnvironment: environment,
              governingCondition:   im.worstCondition(physical, criticality, environment) as any,
              inService:            n.inService === null || n.inService === undefined ? true : n.inService,
              notes:                n.notes || null,
              conditionScore,
              criticalityScore,
              priorityScore,
              repairCostEstimate:            n.repairCostEstimate ?? null,
              spareLeadTimeWeeks:            n.spareLeadTimeWeeks ?? null,
              redundancyStatus:              n.redundancyStatus ?? null,
              requiresPredictiveMaintenance: n.requiresPredictiveMaintenance === true,
              nameplateData,
            },
            select: { id: true },
          });

          // Custom-field values -- validateRows already ran each through
          // validateValueForDefinition; store the canonical strings.
          const cfEntries = Object.entries<any>(n.customFields || {})
            .filter(([, v]) => v !== null && v !== undefined)
            .map(([definitionId, value]) => ({ assetId: asset.id, definitionId, value: String(value) }));
          if (cfEntries.length > 0) {
            await tx.customFieldValue.createMany({ data: cfEntries });
          }

          resultByRow.set(r.row, { outcome: 'created', assetId: asset.id });
          created++;
        }

        return { created, sitesCreated };
      }, { timeout: 60000 });
    } catch (txErr: any) {
      console.error('POST /api/import/assets/commit -- transaction failed:', txErr);
      return res.status(500).json({ success: false, error: `Import failed: ${txErr.message}` });
    }

    const outcomes = rowResults.map((r: any) => ({ row: r.row, ...(resultByRow.get(r.row) || { outcome: 'error', errors: [{ field: '', error: 'Row was not processed' }] }) }));
    const skippedDuplicates = outcomes.filter((o: any) => o.outcome === 'skipped_duplicate').length;
    const errorCount        = outcomes.filter((o: any) => o.outcome === 'error').length;

    // ONE audit row per import with counts (no per-row rows -- they would
    // dilute asset timelines). Report for routes/activity.ts ACTION_LABELS:
    //   assets_imported: 'Assets imported (bulk)',
    writeActivityLog({
      userId:    req.user.id,
      accountId,
      action:    'assets_imported',
      details: {
        source:            'smart_import',
        totalRows:         rows.length,
        created:           txResult.created,
        skippedDuplicates,
        errorRows:         errorCount,
        sitesCreated:      txResult.sitesCreated,
        allowCreateSites,
      },
    });

    return res.json({
      success: true,
      data: {
        step:              'commit',
        totalRows:         rows.length,
        created:           txResult.created,
        skippedDuplicates,
        errorCount,
        sitesCreated:      txResult.sitesCreated,
        allowCreateSites,
        outcomes,
      },
    });
  } catch (err: any) {
    console.error('POST /api/import/assets/commit error:', err);
    return res.status(500).json({ success: false, error: 'Import failed' });
  }
});

module.exports = router;

// Deferred follow-ups (deliberate scope cuts, in priority order):
//   1. Schedule auto-apply for created assets (mirror assetsImport.ts N5
//      autoApplySchedules + unbaselined createMany, skipDuplicates) so smart-
//      imported gear lands on Path-to-100 too.
//   2. AI budget/quota metering for the single 'classify' call (lib/aiQuota
//      checkAndIncrement + lib/aiBudgetGuard) -- the call is already fail-soft
//      and capped at 40 columns; wiring the meters must NOT let a 429 block
//      the deterministic path.

export {};
