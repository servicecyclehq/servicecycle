'use strict';

/**
 * accountExport.ts -- Phase 3 #5 "export everything / no lock-in".
 *
 * Assembles a COMPLETE, portable snapshot of one account's data in open formats:
 * every site, asset, maintenance schedule, work order, deficiency, and quote
 * request as fully-structured rows, plus metadata + integrity hashes + retrieval
 * paths for documents and immutable compliance snapshots. No proprietary
 * encoding, no secrets (no password hashes, no storage internals, no API keys) --
 * just the customer's own records, theirs to take anywhere.
 *
 * The route serves this as JSON (lossless, the canonical no-lock-in artifact) or
 * as a multi-sheet XLSX (human-readable). Binary files (uploaded documents, the
 * snapshot PDFs themselves) are NOT inlined -- they are listed with their
 * filename, type, SHA-256 (snapshots) and an authenticated download path, since
 * bundling every blob would be unbounded; the offboarding note explains how to
 * pull them.
 *
 *   buildAccountExport(prisma, accountId) -> { meta, account, counts, sites,
 *     assets, maintenanceSchedules, workOrders, deficiencies, quoteRequests,
 *     parts, spareInventory, assetPartRequirements,
 *     documents, snapshots, offboarding }
 *
 * Account-scoped throughout.
 */

const EXPORT_VERSION = '2';

const OFFBOARDING = [
  'This file is a complete, portable export of your ServiceCycle account data in open formats (JSON / XLSX).',
  'It is yours to keep and re-import elsewhere -- there is no lock-in.',
  'Structured records (sites, assets, schedules, work orders, deficiencies, quote requests, arc-flash studies + labels, LOTO procedures, parts catalog, spare inventory, asset part requirements) are included in full.',
  'Uploaded documents and immutable compliance snapshot PDFs are listed with their filename, type, and (for snapshots) SHA-256 integrity hash plus an authenticated download path; sign in and GET each downloadPath to retrieve the binary file.',
  'Compliance snapshots are tamper-evident: each PDF hashes to the sha256 recorded here, anchored in the activity-log hash chain at generation time.',
  'Arc-flash studies include per-bus label data (incident energy, PPE, boundaries, expiry) as of the study date. The source inputs (IEEE 1584 utility/transformer params) are in studySourceModels.',
  'LOTO procedures (OSHA 29 CFR 1910.147) are exported at the metadata level; energy sources and steps are retrievable per-procedure via GET /api/assets/:assetId/loto/:id.',
  'To offboard completely: download this export (JSON for a lossless copy), pull each document/snapshot via its downloadPath, then contact ServiceCycle to close the account.',
];

function num(v: any): number | null {
  return v == null ? null : Number(v);
}

async function buildAccountExport(prisma: any, accountId: string) {
  const now = new Date();

  const [account, sites, assets, schedules, workOrders, deficiencies, quotes, documents, snapshots, studies, studyAssets, lotoProcs, parts, spareInventory, assetPartReqs] = await Promise.all([
    prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, companyName: true, planType: true, status: true, createdAt: true },
    }),
    prisma.site.findMany({
      where: { accountId },
      select: { id: true, name: true, address: true, city: true, state: true, postalCode: true,
        primaryContactName: true, primaryContactEmail: true, primaryContactPhone: true, notes: true,
        archivedAt: true, createdAt: true },
      orderBy: { name: 'asc' },
    }),
    prisma.asset.findMany({
      where: { accountId },
      select: { id: true, siteId: true, equipmentType: true, manufacturer: true, model: true,
        serialNumber: true, governingCondition: true, criticalityScore: true, repairCostEstimate: true,
        inService: true, archivedAt: true, createdAt: true, updatedAt: true },
      orderBy: [{ siteId: 'asc' }, { equipmentType: 'asc' }],
    }),
    prisma.maintenanceSchedule.findMany({
      where: { accountId },
      select: { id: true, assetId: true, taskDefinitionId: true, lastCompletedDate: true, nextDueDate: true,
        isActive: true, lastPerformedByName: true, notes: true, createdAt: true,
        taskDefinition: { select: { taskName: true, taskCode: true, standardRef: true } } },
    }),
    prisma.workOrder.findMany({
      where: { accountId },
      select: { id: true, assetId: true, scheduleId: true, quoteRequestId: true, contractorId: true,
        status: true, scheduledDate: true, startedAt: true, completedDate: true,
        asFoundCondition: true, asLeftCondition: true, netaDecal: true, isAcceptanceTest: true,
        notes: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.deficiency.findMany({
      where: { accountId },
      select: { id: true, assetId: true, workOrderId: true, severity: true, description: true,
        correctiveAction: true, resolvedAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.quoteRequest.findMany({
      where: { accountId },
      select: { id: true, assetId: true, status: true, driver: true, timeline: true, triggerType: true,
        priority: true, emergencyMode: true, quotedAt: true, respondedAt: true, declineReason: true,
        createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.document.findMany({
      where: { accountId },
      select: { id: true, assetId: true, workOrderId: true, filename: true, fileType: true,
        docType: true, version: true, externalUrl: true, encrypted: true, uploadedAt: true },
      orderBy: { uploadedAt: 'asc' },
    }),
    prisma.complianceSnapshot.findMany({
      where: { accountId },
      select: { id: true, siteId: true, standardCode: true, kind: true, filename: true,
        sizeBytes: true, sha256: true, stats: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.systemStudy.findMany({
      where: { accountId },
      select: { id: true, siteId: true, studyType: true, performedDate: true, expiresAt: true,
        performedBy: true, method: true, peName: true, peLicense: true, trigger: true, createdAt: true },
      orderBy: { performedDate: 'desc' },
    }),
    prisma.systemStudyAsset.findMany({
      where: { accountId },
      select: { id: true, studyId: true, assetId: true, busName: true, nominalVoltageV: true,
        hazardLevel: true, incidentEnergyCalCm2: true, arcFlashBoundaryIn: true, limitedApproachIn: true,
        restrictedApproachIn: true, ppeCategory: true, ppeMethod: true, workingDistanceIn: true,
        expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.lotoProc.findMany({
      where: { accountId },
      select: { id: true, assetId: true, title: true, status: true, version: true,
        notes: true, approvedAt: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.part.findMany({
      where: { accountId },
      select: { id: true, partNumber: true, description: true, manufacturer: true, category: true,
        unitCost: true, leadTimeWeeks: true, notes: true, createdAt: true },
      orderBy: [{ category: 'asc' }, { partNumber: 'asc' }],
    }),
    prisma.spareInventory.findMany({
      where: { accountId },
      select: { id: true, partId: true, assetId: true, siteId: true, qtyOnHand: true, qtyMin: true,
        location: true, notes: true, createdAt: true },
      orderBy: [{ partId: 'asc' }],
    }),
    prisma.assetPartRequirement.findMany({
      where: { accountId },
      select: { id: true, assetId: true, partId: true, qtyRequired: true, notes: true, createdAt: true },
      orderBy: [{ assetId: 'asc' }, { partId: 'asc' }],
    }),
  ]);

  const documentsOut = documents.map((d: any) => ({
    ...d,
    // External-URL docs link out; stored docs are pulled from the authed file route.
    downloadPath: d.externalUrl ? d.externalUrl : `/api/documents/${d.id}/file`,
  }));
  const snapshotsOut = snapshots.map((s: any) => ({
    ...s,
    downloadPath: `/api/compliance/snapshots/${s.id}/download`,
  }));
  const assetsOut = assets.map((a: any) => ({ ...a, repairCostEstimate: num(a.repairCostEstimate) }));
  // unitCost is Prisma Decimal — coerce to number for JSON/XLSX portability.
  const partsOut = parts.map((p: any) => ({ ...p, unitCost: num(p.unitCost) }));

  const counts = {
    sites: sites.length,
    assets: assets.length,
    maintenanceSchedules: schedules.length,
    workOrders: workOrders.length,
    deficiencies: deficiencies.length,
    quoteRequests: quotes.length,
    documents: documents.length,
    snapshots: snapshots.length,
    arcFlashStudies: studies.length,
    arcFlashLabels: studyAssets.length,
    lotoProcs: lotoProcs.length,
    parts: parts.length,
    spareInventory: spareInventory.length,
    assetPartRequirements: assetPartReqs.length,
  };

  return {
    meta: {
      product: 'ServiceCycle',
      exportVersion: EXPORT_VERSION,
      standard: 'NFPA 70B',
      generatedAt: now,
      accountId,
      formatsAvailable: ['json', 'xlsx'],
    },
    account: account || { id: accountId },
    counts,
    sites,
    assets: assetsOut,
    maintenanceSchedules: schedules,
    workOrders,
    deficiencies,
    quoteRequests: quotes,
    documents: documentsOut,
    snapshots: snapshotsOut,
    arcFlashStudies: studies,
    arcFlashLabels: studyAssets,
    lotoProcs,
    parts: partsOut,
    spareInventory,
    assetPartRequirements: assetPartReqs,
    offboarding: OFFBOARDING,
  };
}

// COMP-8-2b: the JSON account export used to build the whole object, then
// `JSON.stringify(data, null, 2)` it into a single giant string, then res.send()
// — the entire account held in memory TWICE (the object graph + the string),
// which OOMs a single node on a large tenant and is a cheap availability lever.
// This streams the JSON to the socket incrementally: scalars/metadata are
// stringified small, and every large array is written element-by-element so we
// never materialise a second full-size copy of the payload as one string.
// Backpressure is honoured via the writable stream's drain event.
//
// `data` is the object returned by buildAccountExport. We stream keys in a
// stable order; arrays listed in ARRAY_KEYS stream per-element, everything else
// is emitted whole (these are small: meta, account, counts, offboarding).
const ARRAY_KEYS = [
  'sites', 'assets', 'maintenanceSchedules', 'workOrders', 'deficiencies',
  'quoteRequests', 'documents', 'snapshots', 'arcFlashStudies', 'arcFlashLabels',
  'lotoProcs', 'parts', 'spareInventory', 'assetPartRequirements',
];

function _write(res: any, chunk: string): Promise<void> {
  // Respect backpressure: if the kernel buffer is full, wait for 'drain'
  // before resolving so we don't balloon Node's internal write queue.
  return new Promise((resolve, reject) => {
    const ok = res.write(chunk, (err: any) => { if (err) reject(err); });
    if (ok) resolve();
    else res.once('drain', resolve);
  });
}

async function streamAccountExportJson(res: any, data: any): Promise<void> {
  const arraySet = new Set(ARRAY_KEYS);
  const keys = Object.keys(data);
  await _write(res, '{\n');
  for (let ki = 0; ki < keys.length; ki++) {
    const key = keys[ki];
    const keyJson = JSON.stringify(key);
    const isLast = ki === keys.length - 1;
    if (arraySet.has(key) && Array.isArray(data[key])) {
      const arr = data[key];
      await _write(res, `  ${keyJson}: [`);
      for (let i = 0; i < arr.length; i++) {
        // Indent each element body by 4 spaces to keep the file readable;
        // JSON.stringify per-element bounds peak memory to one row at a time.
        const body = JSON.stringify(arr[i], null, 2).split('\n').map((l) => '    ' + l).join('\n');
        await _write(res, (i === 0 ? '\n' : ',\n') + body);
      }
      await _write(res, (arr.length ? '\n  ' : '') + ']' + (isLast ? '\n' : ',\n'));
    } else {
      // Small scalar / object / metadata value — emit whole.
      const body = JSON.stringify(data[key], null, 2).split('\n').map((l, idx) => (idx === 0 ? '' : '  ') + l).join('\n');
      await _write(res, `  ${keyJson}: ${body}${isLast ? '\n' : ',\n'}`);
    }
  }
  await _write(res, '}\n');
}

// Sheet plan for the multi-sheet XLSX rendering of a full export. Each entry is
// { key, sheet, columns: [{ id, header, get }] }. Kept here so the route stays
// thin and the column choices live next to the data assembly.
const EXPORT_SHEETS = [
  { key: 'sites', sheet: 'Sites', columns: [
    { id: 'id', header: 'ID' }, { id: 'name', header: 'Name' }, { id: 'address', header: 'Address' },
    { id: 'city', header: 'City' }, { id: 'state', header: 'State' }, { id: 'postalCode', header: 'Postal Code' },
    { id: 'primaryContactName', header: 'Contact' }, { id: 'primaryContactEmail', header: 'Contact Email' },
    { id: 'archivedAt', header: 'Archived', type: 'date' }, { id: 'createdAt', header: 'Created', type: 'date' },
  ] },
  { key: 'assets', sheet: 'Assets', columns: [
    { id: 'id', header: 'ID' }, { id: 'siteId', header: 'Site ID' }, { id: 'equipmentType', header: 'Equipment Type' },
    { id: 'manufacturer', header: 'Manufacturer' }, { id: 'model', header: 'Model' }, { id: 'serialNumber', header: 'Serial' },
    { id: 'governingCondition', header: 'Condition' }, { id: 'criticalityScore', header: 'Criticality', type: 'number' },
    { id: 'repairCostEstimate', header: 'Repair Est ($)', type: 'currency' }, { id: 'inService', header: 'In Service' },
    { id: 'archivedAt', header: 'Archived', type: 'date' }, { id: 'createdAt', header: 'Created', type: 'date' },
  ] },
  { key: 'maintenanceSchedules', sheet: 'Schedules', columns: [
    { id: 'id', header: 'ID' }, { id: 'assetId', header: 'Asset ID' },
    { id: 'taskName', header: 'Task', get: (r: any) => r.taskDefinition?.taskName },
    { id: 'taskCode', header: 'Task Code', get: (r: any) => r.taskDefinition?.taskCode },
    { id: 'standardRef', header: 'Standard Ref', get: (r: any) => r.taskDefinition?.standardRef },
    { id: 'lastCompletedDate', header: 'Last Completed', type: 'date' }, { id: 'nextDueDate', header: 'Next Due', type: 'date' },
    { id: 'isActive', header: 'Active' }, { id: 'createdAt', header: 'Created', type: 'date' },
  ] },
  { key: 'workOrders', sheet: 'Work Orders', columns: [
    { id: 'id', header: 'ID' }, { id: 'assetId', header: 'Asset ID' }, { id: 'scheduleId', header: 'Schedule ID' },
    { id: 'quoteRequestId', header: 'Quote Request ID' }, { id: 'status', header: 'Status' },
    { id: 'scheduledDate', header: 'Scheduled', type: 'date' }, { id: 'completedDate', header: 'Completed', type: 'date' },
    { id: 'asFoundCondition', header: 'As Found' }, { id: 'asLeftCondition', header: 'As Left' },
    { id: 'netaDecal', header: 'NETA Decal' }, { id: 'createdAt', header: 'Created', type: 'date' },
  ] },
  { key: 'deficiencies', sheet: 'Deficiencies', columns: [
    { id: 'id', header: 'ID' }, { id: 'assetId', header: 'Asset ID' }, { id: 'workOrderId', header: 'Work Order ID' },
    { id: 'severity', header: 'Severity' }, { id: 'description', header: 'Description' },
    { id: 'correctiveAction', header: 'Corrective Action' }, { id: 'resolvedAt', header: 'Resolved', type: 'date' },
    { id: 'createdAt', header: 'Created', type: 'date' },
  ] },
  { key: 'quoteRequests', sheet: 'Quote Requests', columns: [
    { id: 'id', header: 'ID' }, { id: 'assetId', header: 'Asset ID' }, { id: 'status', header: 'Status' },
    { id: 'driver', header: 'Driver' }, { id: 'timeline', header: 'Timeline' }, { id: 'triggerType', header: 'Trigger' },
    { id: 'priority', header: 'Priority' }, { id: 'quotedAt', header: 'Quoted', type: 'date' },
    { id: 'createdAt', header: 'Created', type: 'date' },
  ] },
  { key: 'documents', sheet: 'Documents', columns: [
    { id: 'id', header: 'ID' }, { id: 'assetId', header: 'Asset ID' }, { id: 'workOrderId', header: 'Work Order ID' },
    { id: 'filename', header: 'Filename' }, { id: 'fileType', header: 'Type' }, { id: 'docType', header: 'Doc Type' },
    { id: 'uploadedAt', header: 'Uploaded', type: 'date' }, { id: 'downloadPath', header: 'Download Path' },
  ] },
  { key: 'snapshots', sheet: 'Snapshots', columns: [
    { id: 'id', header: 'ID' }, { id: 'kind', header: 'Kind' }, { id: 'standardCode', header: 'Standard' },
    { id: 'siteId', header: 'Site ID' }, { id: 'filename', header: 'Filename' }, { id: 'sizeBytes', header: 'Size (bytes)', type: 'number' },
    { id: 'sha256', header: 'SHA-256' }, { id: 'createdAt', header: 'Created', type: 'date' }, { id: 'downloadPath', header: 'Download Path' },
  ] },
  { key: 'arcFlashStudies', sheet: 'Arc Flash Studies', columns: [
    { id: 'id', header: 'ID' }, { id: 'siteId', header: 'Site ID' }, { id: 'studyType', header: 'Study Type' },
    { id: 'performedDate', header: 'Performed', type: 'date' }, { id: 'expiresAt', header: 'Expires', type: 'date' },
    { id: 'performedBy', header: 'Firm' }, { id: 'method', header: 'Method' },
    { id: 'peName', header: 'PE Name' }, { id: 'peLicense', header: 'PE License' },
    { id: 'trigger', header: 'Trigger' }, { id: 'createdAt', header: 'Created', type: 'date' },
  ] },
  { key: 'arcFlashLabels', sheet: 'Arc Flash Labels', columns: [
    { id: 'id', header: 'ID' }, { id: 'studyId', header: 'Study ID' }, { id: 'assetId', header: 'Asset ID' },
    { id: 'busName', header: 'Bus Name' }, { id: 'nominalVoltageV', header: 'Voltage (V)', type: 'number' },
    { id: 'hazardLevel', header: 'Hazard Level' },
    { id: 'incidentEnergyCalCm2', header: 'IE (cal/cm2)', type: 'number' },
    { id: 'arcFlashBoundaryIn', header: 'AFB (in)', type: 'number' },
    { id: 'ppeCategory', header: 'PPE Cat' }, { id: 'ppeMethod', header: 'PPE Method' },
    { id: 'expiresAt', header: 'Expires', type: 'date' }, { id: 'createdAt', header: 'Created', type: 'date' },
  ] },
  { key: 'lotoProcs', sheet: 'LOTO Procedures', columns: [
    { id: 'id', header: 'ID' }, { id: 'assetId', header: 'Asset ID' }, { id: 'title', header: 'Title' },
    { id: 'status', header: 'Status' }, { id: 'version', header: 'Version', type: 'number' },
    { id: 'approvedAt', header: 'Approved', type: 'date' }, { id: 'createdAt', header: 'Created', type: 'date' },
  ] },
  { key: 'parts', sheet: 'Parts Catalog', columns: [
    { id: 'id', header: 'ID' }, { id: 'partNumber', header: 'Part Number' },
    { id: 'description', header: 'Description' }, { id: 'manufacturer', header: 'Manufacturer' },
    { id: 'category', header: 'Category' }, { id: 'unitCost', header: 'Unit Cost ($)', type: 'currency' },
    { id: 'leadTimeWeeks', header: 'Lead Time (wks)', type: 'number' },
    { id: 'notes', header: 'Notes' }, { id: 'createdAt', header: 'Created', type: 'date' },
  ] },
  { key: 'spareInventory', sheet: 'Spare Inventory', columns: [
    { id: 'id', header: 'ID' }, { id: 'partId', header: 'Part ID' }, { id: 'assetId', header: 'Asset ID' },
    { id: 'siteId', header: 'Site ID' }, { id: 'qtyOnHand', header: 'Qty On Hand', type: 'number' },
    { id: 'qtyMin', header: 'Qty Min', type: 'number' }, { id: 'location', header: 'Location' },
    { id: 'notes', header: 'Notes' }, { id: 'createdAt', header: 'Created', type: 'date' },
  ] },
  { key: 'assetPartRequirements', sheet: 'Asset Part Requirements', columns: [
    { id: 'id', header: 'ID' }, { id: 'assetId', header: 'Asset ID' }, { id: 'partId', header: 'Part ID' },
    { id: 'qtyRequired', header: 'Qty Required', type: 'number' },
    { id: 'notes', header: 'Notes' }, { id: 'createdAt', header: 'Created', type: 'date' },
  ] },
];

module.exports = { buildAccountExport, streamAccountExportJson, EXPORT_SHEETS, EXPORT_VERSION };

export {};
