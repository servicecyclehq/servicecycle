/**
 * lib/arcFlashDevice.ts — Slice 2.7 field-collection helpers.
 *
 * The moat: the hardest-to-get arc-flash inputs are the upstream PROTECTIVE
 * DEVICE (frame/sensor rating + LSIG trip settings, or fuse class/rating) and the
 * FEEDER CABLE — read by opening the equipment door down to 480V panels. This
 * module turns an ingest's gap punch-list into field-collection TASKS, maps a
 * collected device back onto a bus for re-gapping, and reads a breaker/fuse PHOTO
 * into a structured device draft (the easy-button for the invasive part).
 *
 * Honest by design: photo-read is a "strong draft you correct," never a stamp;
 * confidence/gap scoring stays deterministic in lib/arcFlashGap.ts.
 */

'use strict';

const ai = require('./ai');
const { analyzeBusGaps, summarizeIngestBands } = require('./arcFlashGap');
const { SC_DATA_LAYER_DISCLAIMER } = require('./arcFlashCopy');

const PHOTO_PROMPT_VERSION = 'af-device-photo-v1';

// ── small local normalizers (kept independent of arcFlashExtract) ─────────────
function cleanStr(v: any): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s || /^(null|n\/a|na|none|-|unknown)$/i.test(s)) return null;
  return s;
}
function coerceNum(v: any): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  const m = String(v).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function parseVolts(raw: any): number | null {
  if (raw == null) return null;
  const m = String(raw).match(/([\d.]+)\s*(kv|v)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /kv/i.test(m[2] || '') ? n * 1000 : n;
}

const DEVICE_TYPES = new Set(['breaker', 'fuse', 'relay', 'switch']);
function normDeviceType(v: any): string | null {
  const s = cleanStr(v);
  if (!s) return null;
  const l = s.toLowerCase();
  if (DEVICE_TYPES.has(l)) return l;
  if (/breaker|cb\b|mccb|icb|acb|molded|insulated/.test(l)) return 'breaker';
  if (/fuse/.test(l)) return 'fuse';
  if (/relay|51|50|protective relay/.test(l)) return 'relay';
  if (/switch|disconnect|fusible/.test(l)) return 'switch';
  return null;
}

// [F6, 2026-07-07] The photo-extraction contract used to ask for trip
// SETTINGS but never asked the model to classify the trip UNIT TYPE itself
// (none|thermal_magnetic|electronic_lsi|electronic_lsig) -- so a photo of an
// adjustable electronic LSIG breaker came back with tripUnitType un-set, and
// arcFlashGap.ts's evalMusts() treats a bare "breaker" with no tripUnitType
// as fixed-trip (satisfied by type+rating alone), silently skipping the
// follow-up task to record its LSIG settings. A field tech reading the
// device's own display/dial layout can usually tell adjustable from fixed at
// a glance, so this is a askable, not a guessable, gap.
const TRIP_UNIT_TYPES = new Set(['none', 'thermal_magnetic', 'electronic_lsi', 'electronic_lsig']);
function normTripUnitType(v: any): string | null {
  // NOTE: deliberately does not reuse cleanStr() -- "none" is a real,
  // meaningful enum value here ("this breaker has no trip unit at all"), not
  // a stand-in for "no data", which is what cleanStr's null-equivalent list
  // treats it as.
  if (v == null) return null;
  const raw = String(v).trim();
  if (!raw || /^(null|n\/a|na|-|unknown)$/i.test(raw)) return null;
  const lower = raw.toLowerCase();          // for word-boundary regex checks (keeps spaces/punctuation)
  const packed = lower.replace(/[\s-]+/g, '_'); // for the exact-enum lookup only
  if (TRIP_UNIT_TYPES.has(packed)) return packed;
  if (/\blsig\b/.test(lower)) return 'electronic_lsig';
  // Word-boundary "lsi" (not "lsig") before the broader ground-fault check,
  // so phrasing like "LSI (no ground fault)" classifies correctly -- a naive
  // ground-fault substring match would misfire on the word "ground" even when
  // explicitly negated.
  if (/\blsi\b/.test(lower)) return 'electronic_lsi';
  if (/ground.?fault/.test(lower)) return 'electronic_lsig';
  if (/electronic|micrologic|digitrip|ekip|digital|adjustable/.test(lower)) return 'electronic_lsi';
  if (/thermal|magnetic|fixed/.test(lower)) return 'thermal_magnetic';
  return null;
}

/**
 * Map a durable ProtectiveDevice (or a collected draft) onto the bus device
 * fields the gap engine reads. sensorRatingA drives the curve; fall back to frame.
 */
export function deviceToBusFields(device: any): any {
  if (!device || typeof device !== 'object') return {};
  return {
    deviceType: cleanStr(device.deviceType) || null,
    tripUnitType: cleanStr(device.tripUnitType) || null,
    fuseClass: cleanStr(device.fuseClass) || null,
    deviceManufacturer: cleanStr(device.manufacturer) || null,
    deviceModel: cleanStr(device.model) || null,
    deviceRatingA: coerceNum(device.sensorRatingA) ?? coerceNum(device.frameRatingA),
    deviceSettings: device.settings && typeof device.settings === 'object' && Object.keys(device.settings).length ? device.settings : null,
  };
}

// Conservative hazard class for a collection task: only WARNING when we KNOW the
// bus is LV (<=600 V) and not high-energy; otherwise DANGER (incl. unknown) so the
// collector PPEs up for the worst case until the study proves otherwise.
function hazardForBus(bus: any): string {
  const v = parseVolts(bus.nominalVoltage);
  const ie = coerceNum(bus.incidentEnergyCalCm2);
  const ppe = coerceNum(bus.ppeCategory);
  if (v != null && v <= 600 && (ie == null || ie <= 40) && (ppe == null || ppe <= 2)) return 'WARNING';
  return 'DANGER';
}

const PPE_NOTE_DANGER = 'Treat as DANGER until a study proves otherwise: de-energize and verify absence of voltage where possible; if energized work is unavoidable, a qualified person in arc-rated PPE for the worst-case incident energy, per NFPA 70E.';
const PPE_NOTE_WARNING = 'Qualified person only; arc-rated PPE appropriate to the equipment, per NFPA 70E. Prefer an electrically safe (de-energized) condition before opening.';

/**
 * Turn the gap punch-list into field-collection task drafts — one per BLOCKED
 * bus. Each task spells out exactly what to open and record, carries the missing
 * must-obtain fields, and is sequenced for safety (PPE / outage / qualified).
 * Pure: returns drafts; the caller persists + dedups.
 */
export function buildCollectionTasks(buses: any[]): any[] {
  const tasks: any[] = [];
  for (const b of buses || []) {
    const gaps = (b.gaps || {}) as any;
    const fields = Array.isArray(gaps.fields) ? gaps.fields : [];
    const missingMusts = fields.filter((f: any) => f.category === 'must_obtain' && f.status === 'missing');
    // Only blocked buses need collection; a ready/defaultable bus has its musts.
    if (b.readiness !== 'blocked' && !missingMusts.length) continue;

    const needDevice = missingMusts.some((f: any) => f.field === 'protectiveDevice');
    const needFault = missingMusts.some((f: any) => f.field === 'faultCurrent');
    const needVoltage = missingMusts.some((f: any) => f.field === 'nominalVoltage');

    const todo: string[] = [];
    if (needVoltage) todo.push('read the system voltage at this bus');
    if (needDevice) todo.push('record the UPSTREAM protective device: type + frame/sensor rating + trip settings (long/short/inst/ground-fault), or fuse class + rating');
    if (needFault) todo.push('record the available fault current (short-circuit study / utility), OR the feeder cable length + size + material so it can be computed');
    if (!todo.length) continue;

    const where = b.busName || 'this bus';
    const instructions = `Open ${where} and ${todo.join('; ')}.`;
    const hazardClass = hazardForBus(b);
    tasks.push({
      ingestBusId: b.id || null,
      busName: b.busName || 'Unnamed bus',
      instructions,
      neededFields: missingMusts.map((f: any) => ({ field: f.field, label: f.label })),
      hazardClass,
      ppeNote: hazardClass === 'DANGER' ? PPE_NOTE_DANGER : PPE_NOTE_WARNING,
      // Reading device settings / cable means opening the door -> prefer an outage.
      requiresOutage: needDevice || needFault,
      requiresQualifiedPerson: true,
      disclaimer: SC_DATA_LAYER_DISCLAIMER,
    });
  }
  return tasks;
}

// ── photo-read: breaker trip-unit / fuse / relay photo -> device draft ────────
const PHOTO_CONTRACT = `Return STRICT JSON only (no prose, no markdown fences) matching exactly:
{
  "deviceType": "breaker|fuse|relay|switch|null",
  "manufacturer": "string|null",
  "model": "string|null (series / catalog, e.g. \\"PowerPact H\\", \\"Micrologic 6.0\\")",
  "partNumber": "string|null",
  "frameRatingA": number_or_null,
  "sensorRatingA": number_or_null,
  "tripUnitType": "none|thermal_magnetic|electronic_lsi|electronic_lsig|null — for a BREAKER only: \"none\" if it has no trip unit at all (rare), \"thermal_magnetic\" if it's a simple fixed-trip breaker with no digital display or adjustment dials, \"electronic_lsi\" if it has an electronic trip unit / display with Long-time, Short-time, and Instantaneous adjustments but no visible Ground-fault setting, \"electronic_lsig\" if it also has a Ground-fault (G) setting. null if you cannot tell from the photo. Not applicable to a fuse, relay, or switch — leave null.",
  "settings": "object|null — for a breaker: {longTimePickup, longTimeDelay, shortTimePickup, shortTimeDelay, instantaneous, groundFault} reading dial positions / display values; for a fuse: {fuseClass, fuseRatingA}",
  "confidenceNote": "string|null (what was hard to read)"
}
Rules: read ONLY what is visible. Use null for anything you cannot read — NEVER guess a rating, a trip unit type, or a trip setting. Dial positions and displayed setpoints are values; transcribe them as shown.`;

const PHOTO_PROMPT =
  'This image shows an electrical protective device: a molded-case/insulated-case circuit breaker trip unit (possibly with rotary dials or an electronic display), a fuse, or a protective relay. Read the nameplate and any visible trip settings (dial positions, displayed setpoints). Extract the structured device record for arc-flash data collection. ' +
  PHOTO_CONTRACT;

function normalizeDevice(parsed: any): any {
  const r = parsed && typeof parsed === 'object' ? parsed : {};
  const s = r.settings && typeof r.settings === 'object' ? r.settings : null;
  return {
    deviceType: normDeviceType(r.deviceType),
    manufacturer: cleanStr(r.manufacturer),
    model: cleanStr(r.model),
    partNumber: cleanStr(r.partNumber),
    frameRatingA: coerceNum(r.frameRatingA),
    sensorRatingA: coerceNum(r.sensorRatingA),
    tripUnitType: normTripUnitType(r.tripUnitType),
    settings: s && Object.keys(s).length ? s : null,
    confidenceNote: cleanStr(r.confidenceNote),
  };
}

function normalizeMedia(mimeType: any): string {
  const m = String(mimeType || '').toLowerCase();
  if (m.includes('png')) return 'image/png';
  if (m.includes('webp')) return 'image/webp';
  return 'image/jpeg';
}

/**
 * Read a device photo into a structured draft via the BYO-AI vision path. Fails
 * SOFT: an unreadable image yields an empty draft + a clear warning rather than
 * throwing, so the field flow never dead-ends.
 */
export async function extractDeviceFromPhoto(opts: { buffer: Buffer; mimeType?: string; settings?: any }): Promise<any> {
  const { buffer, mimeType, settings = {} } = opts;
  let out: any;
  try {
    // Gemini 2.5 flash reasoning tokens bill against maxOutputTokens, so 1500
    // truncated the JSON on any multi-setting trip unit (nameplate route hit
    // the same trap — see 919d389). 8192 leaves room for thinking + the full
    // PHOTO_CONTRACT with all 6 trip settings. responseMimeType opts into
    // Gemini JSON mode. Anthropic/Groq ignore it (Groq forces json_object).
    out = await ai.completeWithImage({
      imageBuffer:      buffer,
      mediaType:        normalizeMedia(mimeType),
      prompt:           PHOTO_PROMPT,
      maxTokens:        8192,
      responseMimeType: 'application/json',
      settings,
    });
  } catch (e: any) {
    return { device: null, warnings: ['Photo read failed: ' + (e && e.message ? e.message : String(e))], promptVersion: PHOTO_PROMPT_VERSION, rawJsonText: '' };
  }
  const text = out && out.text ? out.text : '';
  let parsed: any;
  try { parsed = ai.parseJSON(text, 'arc-flash-device-photo'); }
  catch { return { device: null, warnings: ['Could not parse the AI response as JSON — re-take the photo with the nameplate/dials in focus.'], promptVersion: PHOTO_PROMPT_VERSION, rawJsonText: text }; }
  const device = normalizeDevice(parsed);
  const warnings: string[] = [];
  if (!device.deviceType && !device.manufacturer && !device.model && device.sensorRatingA == null && device.frameRatingA == null) {
    warnings.push('Nothing recognizable was read from the photo — confirm it shows the device nameplate / trip unit.');
  }
  return { device, warnings, promptVersion: PHOTO_PROMPT_VERSION, aiProvider: out && out.provider ? out.provider : null, rawJsonText: text };
}

// Shape an ingest-bus row for the gap engine (Decimals -> numbers — present()
// in arcFlashGap can't read a Prisma Decimal object directly).
function busForGap(b: any) {
  return {
    busName: b.busName, equipmentTypeGuess: b.equipmentTypeGuess, nominalVoltage: b.nominalVoltage,
    boltedFaultCurrentKA: coerceNum(b.boltedFaultCurrentKA), clearingTimeMs: coerceNum(b.clearingTimeMs),
    electrodeConfig: b.electrodeConfig, conductorGapMm: coerceNum(b.conductorGapMm), workingDistanceIn: coerceNum(b.workingDistanceIn),
    deviceType: b.deviceType, tripUnitType: b.tripUnitType, deviceRatingA: coerceNum(b.deviceRatingA), deviceSettings: b.deviceSettings,
    cableLengthFt: coerceNum(b.cableLengthFt), cableSize: b.cableSize,
  };
}

/**
 * Apply a collected device (+ optional feeder cable) onto an ingest bus, re-run
 * the gap engine, and re-roll the parent ingest's readiness summary. Closes the
 * loop: field collection -> the blocked bus moves toward ready. Returns null if
 * the bus is gone. Caller owns auth/tenancy.
 */
export async function regapIngestBusAfterDevice(prisma: any, busId: string, opts: { device?: any; cable?: any } = {}): Promise<any> {
  const bus = await prisma.arcFlashIngestBus.findUnique({ where: { id: busId } });
  if (!bus) return null;
  const df = deviceToBusFields(opts.device || {});
  const cable = opts.cable || {};
  const data: any = {};
  if (df.deviceType != null) data.deviceType = df.deviceType;
  if (df.tripUnitType != null) data.tripUnitType = df.tripUnitType;
  if (df.fuseClass != null) data.fuseClass = df.fuseClass;
  if (df.deviceManufacturer != null) data.deviceManufacturer = df.deviceManufacturer;
  if (df.deviceModel != null) data.deviceModel = df.deviceModel;
  if (df.deviceRatingA != null) data.deviceRatingA = df.deviceRatingA;
  if (df.deviceSettings != null) data.deviceSettings = df.deviceSettings;
  if (cable.cableLengthFt != null && cable.cableLengthFt !== '') data.cableLengthFt = coerceNum(cable.cableLengthFt);
  if (cable.cableSize != null && cable.cableSize !== '') data.cableSize = String(cable.cableSize).slice(0, 100);
  if (cable.cableMaterial != null && cable.cableMaterial !== '') data.cableMaterial = String(cable.cableMaterial).slice(0, 40);

  const merged = { ...bus, ...data };
  const g = analyzeBusGaps(busForGap(merged));
  data.gaps = g; data.readiness = g.readiness; data.confidence = g.confidence;
  const updated = await prisma.arcFlashIngestBus.update({ where: { id: bus.id }, data });

  const all = await prisma.arcFlashIngestBus.findMany({ where: { ingestId: bus.ingestId } });
  const summary = summarizeIngestBands(all.map((x: any) => x.gaps).filter(Boolean));
  await prisma.arcFlashIngest.update({ where: { id: bus.ingestId }, data: { overallBand: summary.overallBand, readyBusCount: summary.readyBusCount, totalBusCount: all.length } });
  return { bus: updated, readiness: g.readiness, confidence: g.confidence, summary };
}

export { PHOTO_PROMPT_VERSION, normalizeDevice, hazardForBus };
