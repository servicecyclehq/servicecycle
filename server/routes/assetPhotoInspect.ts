/**
 * routes/assetPhotoInspect.ts — POST /api/assets/photo-inspect
 *
 * AI photo inspection: upload ONE photo of a piece of electrical equipment
 * and get back structured identification (type guess + legible nameplate
 * fields), a visual-only condition read, and upstream-feed clues matched
 * against this account's assets (Power Path topology helper). See
 * lib/photoInspect for the analysis contract.
 *
 * Multipart form:
 *   image    — required; jpeg/png/webp, 10MB cap (HEIC explicitly rejected
 *              with a convert-first message — sharp builds don't reliably
 *              carry HEIF support)
 *   assetId  — optional uuid; when present the photo is inspected IN THE
 *              CONTEXT of that asset (existing data travels to the model)
 *              and the ORIGINAL upload is persisted as a Document on it.
 *   siteId   — optional uuid; scopes the upstream-candidate list when no
 *              assetId is given.
 *
 * Gate order (copied from routes/assetBrief.ts — keep the two in sync):
 *   0. requireManager role gate (photo-inspect only; it persists a Document)
 *   1. AI_ENABLED kill-switch            → 503 ai_disabled
 *   2. GPC opt-out (Sec-GPC: 1)          → 403 GPC_AI_BLOCKED
 *   3. per-user burst limiter (30/hr)    → 429 (express-rate-limit message)
 *   4. ownership (assetId / siteId, accountId!) → 404
 *   5. account.aiBriefEnabled toggle     → 403 ai_brief_disabled_for_account
 *   6. AI consent (lib/aiConsent)        → 403 ai_consent_required | ai_consent_outdated
 *   7. aiQuota 'photo_inspect'           → 429 ai_daily_cap_reached  (cap-then-act;
 *                                          slot refunded on any downstream failure)
 *   8. demo budget guard (lib/aiBudgetGuard.ensureAiBudget)
 *                                        → 503 ai_demo_*_budget_exhausted
 *   9. build context → vision call → validate → persist photo → respond
 *      catch: refund quota slot, 500
 *
 * Steps 1-2 run in a pre-gate middleware BEFORE multer so a disabled
 * instance never buffers a 10MB upload it will reject anyway.
 *
 * Auth: authenticateToken is applied at the mount point in index.ts
 * (NOT mounted yet — see the integration notes). aiIpLimiter is stacked
 * per-route below, matching the assetBrief pattern.
 *
 * TENANCY: the asset/site lookups AND buildInspectContext all filter by
 * req.user.accountId.
 */

'use strict';

const router    = require('express').Router();
const multer    = require('multer');
const rateLimit = require('express-rate-limit');
const { z }     = require('zod');

const { ensureAiConsent }  = require('../lib/aiConsent');
const { ensureAiBudget }   = require('../lib/aiBudgetGuard');
const { checkAndIncrement: checkAiQuota, refundIncrement: refundAiQuota } = require('../lib/aiQuota');
const { aiIpLimiter }      = require('../middleware/aiIpLimit');
const { requireManager }   = require('../middleware/roles');
const { buildInspectContext, inspectPhoto } = require('../lib/photoInspect');
const { uploadFile }       = require('../lib/storage');
const { recordExtraction } = require('../lib/extractionTelemetry'); // #4 telemetry (scan paths)
import prisma from '../lib/prisma';

// ─── Upload handling ──────────────────────────────────────────────────────────

const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10MB

// HEIC/HEIF accepted — iPhones shoot HEIC by default and this container's sharp
// build carries libheif, so lib/imageNormalize transcodes to JPEG (and applies
// EXIF rotation) before the model call / storage rather than blocking the tech.
const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const MIME_EXT: any = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'jpg', 'image/heif': 'jpg' };

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_PHOTO_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const mt = (file.mimetype || '').toLowerCase();
    const heicName = /\.heic$|\.heif$/i.test(file.originalname || '');
    if (ACCEPTED_MIME.has(mt) || heicName) return cb(null, true);
    return cb(new Error('Only JPEG, PNG, WebP, or HEIC images are accepted.'));
  },
});

// Multer errors (size cap, fileFilter rejections) become 400 JSON in the
// envelope shape rather than the default HTML error page.
function photoUploadMiddleware(req, res, next) {
  photoUpload.single('image')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'Image too large — 10MB maximum.'
        : (err.message || 'Upload failed.');
      return res.status(400).json({ success: false, error: msg });
    }
    return next();
  });
}

// ─── Pre-gate: AI kill-switch + GPC BEFORE the body is buffered ──────────────

function aiPreGate(req, res, next) {
  // 1. Instance-level AI kill-switch.
  if (process.env.AI_ENABLED === 'false') {
    return res.status(503).json({
      success: false,
      error:   'ai_disabled',
      message: 'AI features are disabled on this instance.',
    });
  }
  // 2. Global Privacy Control opt-out blocks AI processing (house rule —
  //    every AI endpoint honors Sec-GPC: 1).
  if (req.gpc) {
    return res.status(403).json({
      success: false,
      error:   'AI features are disabled because your browser sent a Global Privacy Control (Sec-GPC: 1) signal.',
      code:    'GPC_AI_BLOCKED',
    });
  }
  return next();
}

// ─── Per-user burst limiter ───────────────────────────────────────────────────
// 30 inspections/hour/user — same shape as the brief limiter. The daily
// aiQuota cap (3/day on demo) is the real cost gate; this stops a stuck
// client on self-host (where quota is UNLIMITED) from racking up vision
// calls inside a single hour.
const photoInspectLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => `photo_inspect:${req.user?.id || 'anon'}`,
  message: { success: false, error: 'Too many photo inspection requests — try again in an hour.' },
});

const OptUuidField = z.string().uuid().optional();

// ─── Activity logging helper ──────────────────────────────────────────────────
// Fire-and-forget, mirrors routes/assets.ts — a logging failure never
// blocks the response.
async function logActivity(assetId, userId, accountId, action, details = null) {
  try {
    await prisma.activityLog.create({
      data: { assetId, userId, accountId: accountId ?? null, action, details: details ?? undefined },
    });
  } catch (err) {
    console.error('logActivity error:', err.message);
  }
}

// ─── POST /photo-inspect ──────────────────────────────────────────────────────

// RBAC (2026-07-03 acquisition scan, Scan 3): photo-inspect PERSISTS the photo
// as a Document row on the asset, so it is a write path -- requireManager,
// matching the sibling document-write routes (routes/documents.ts POST
// /upload). This does NOT touch field capture: field_tech is default-denied
// off /api/assets entirely (lib/fieldRoleScope allowlist), the field_tech UI
// (FieldJob.jsx) never calls this endpoint, and the client documents
// photo-inspect/OCR as manager-tier features on the full FieldAsset card.
// /ocr-nameplate below stays ungated -- it persists nothing.
router.post('/photo-inspect', requireManager, aiPreGate, aiIpLimiter, photoInspectLimiter, photoUploadMiddleware, async (req, res) => {
  if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
    return res.status(400).json({ success: false, error: 'An image file is required (multipart field "image").' });
  }

  // EXIF-rotate + transcode HEIC→JPEG + cap size before the vision call and
  // before the photo is persisted on the asset's document timeline.
  try {
    const { normalizeImage } = require('../lib/imageNormalize');
    const _n = await normalizeImage(req.file.buffer, req.file.mimetype);
    req.file.buffer = _n.buffer; req.file.mimetype = _n.mimeType;
  } catch (ne: any) {
    return res.status(400).json({ success: false, error: ne.message || 'Could not process that image.' });
  }

  // Optional context fields arrive as multipart text fields.
  const assetIdCheck = OptUuidField.safeParse(req.body?.assetId || undefined);
  if (!assetIdCheck.success) {
    return res.status(400).json({ success: false, error: 'Invalid asset id' });
  }
  const siteIdCheck = OptUuidField.safeParse(req.body?.siteId || undefined);
  if (!siteIdCheck.success) {
    return res.status(400).json({ success: false, error: 'Invalid site id' });
  }
  const assetId   = assetIdCheck.data || null;
  const siteId    = siteIdCheck.data || null;
  const userId    = req.user.id;
  const accountId = req.user.accountId;

  let quotaCharged = false;
  try {
    // 4. Ownership — accountId filter is the tenancy boundary.
    if (assetId) {
      const asset = await prisma.asset.findFirst({
        where:  { id: assetId, accountId },
        select: { id: true },
      });
      if (!asset) {
        return res.status(404).json({ success: false, error: 'Asset not found' });
      }
    }
    if (siteId) {
      const site = await prisma.site.findFirst({
        where:  { id: siteId, accountId },
        select: { id: true },
      });
      if (!site) {
        return res.status(404).json({ success: false, error: 'Site not found' });
      }
    }

    // 5. Per-account AI feature toggle (Account.aiBriefEnabled — the single
    //    per-account AI switch; default OFF on self-host, demo seed flips
    //    it on). Same code as assetBrief so the client modal keys match.
    const account = await prisma.account.findUnique({
      where:  { id: accountId },
      select: { aiBriefEnabled: true },
    });
    if (!account?.aiBriefEnabled) {
      return res.status(403).json({
        success: false,
        error:   'ai_brief_disabled_for_account',
        message: 'AI features are disabled for this account. An admin can enable them in Settings.',
      });
    }

    // 6. Per-user AI consent. ensureAiConsent sends the 403 itself with
    //    error 'ai_consent_required' / 'ai_consent_outdated'.
    if (!(await ensureAiConsent(req, res))) return;

    // 7. Daily per-user quota — 'photo_inspect' action (demo cap 3/day,
    //    UNLIMITED self-host). Cap-then-act; every downstream failure path
    //    refunds the slot.
    const quota = await checkAiQuota(userId, 'photo_inspect', accountId, req.user.role);
    if (!quota.ok) {
      return res.status(429).json({
        success: false,
        error:   'ai_daily_cap_reached',
        message: `You've used ${quota.count}/${quota.cap} of your daily AI photo inspections. Resets at midnight UTC.`,
        data:    { count: quota.count, cap: quota.cap, capReason: quota.capReason || 'action', resetAt: quota.resetAt },
      });
    }
    quotaCharged = true;

    // 8. Demo budget guard (global monthly $/daily-call fuse). Sends its
    //    own 503 when tripped; the quota slot is refunded — the user got
    //    nothing for it.
    if (!ensureAiBudget(req, res)) {
      await refundAiQuota(userId, 'photo_inspect', accountId);
      return;
    }

    // 9. Build context + run the vision call.
    const context = await buildInspectContext(prisma, accountId, { assetId, siteId });
    if (!context) {
      // Asset vanished between the ownership check and here (concurrent
      // delete) — treat as not-found, refund the slot.
      await refundAiQuota(userId, 'photo_inspect', accountId);
      return res.status(404).json({ success: false, error: 'Asset not found' });
    }

    if (context._meta?.sanitizerRedactions > 0) {
      console.warn(`[assetPhotoInspect] sanitizer redacted ${context._meta.sanitizerRedactions} injection marker(s) for asset=${assetId} account=${accountId}`);
    }

    const { analysis, model, generatedAt } = await inspectPhoto({
      imageBuffer: req.file.buffer,
      mediaType:   req.file.mimetype,
      context,
    });

    // ── Persist the ORIGINAL (pre-downscale) photo on the asset ─────────────
    // Inspection evidence belongs on the asset's document timeline. Failure
    // here is non-fatal — the user already paid for and received the
    // analysis; they just don't get the attachment.
    let documentId = null;
    if (assetId) {
      try {
        const ext = MIME_EXT[(req.file.mimetype || '').toLowerCase()] || 'jpg';
        const filename = `photo-inspect-${Date.now()}.${ext}`;
        const { storageKey } = await uploadFile(accountId, assetId, filename, req.file.buffer, req.file.mimetype);
        const doc = await prisma.document.create({
          data: {
            accountId,
            assetId,
            filename,
            filePath:   storageKey,
            fileType:   req.file.mimetype,
            uploadedBy: req.user.id,
          },
          select: { id: true },
        });
        documentId = doc.id;
      } catch (persistErr) {
        console.error('[assetPhotoInspect] photo persistence failed (non-fatal):', persistErr.message);
      }
    }

    void logActivity(assetId, userId, accountId, 'photo_inspect_run', {
      equipmentTypeGuess: analysis.identification.equipmentTypeGuess,
      confidence:         analysis.identification.confidence,
      observations:       analysis.visibleCondition.observations.length,
    });

    // #4 telemetry: one extraction row for the vision scan path too, so QA/field
    // accuracy is measured across EVERY ingest + scan path, not just PDFs.
    const _confMap: any = { high: 0.9, medium: 0.6, low: 0.3 };
    void recordExtraction({
      accountId, userId, kind: 'photo_inspect', engine: String(model || 'vision'), aiUsed: true,
      fieldsExtracted: Array.isArray(analysis?.identification?.nameplate)
        ? analysis.identification.nameplate.length
        : Object.keys(analysis?.identification?.nameplate || {}).length,
      confMean: _confMap[String(analysis?.identification?.confidence || '').toLowerCase()] ?? null,
    });

    return res.json({
      success: true,
      data: {
        analysis,
        model,
        generatedAt,
        ...(documentId ? { documentId } : {}),
      },
    });
  } catch (err) {
    console.error('Photo inspection error:', err);
    // Refund-on-failure: the user should not be penalized for a provider
    // 5xx / timeout / unparseable response.
    if (quotaCharged) {
      void refundAiQuota(userId, 'photo_inspect', accountId);
    }
    return res.status(500).json({ success: false, error: 'Failed to analyze photo' });
  }
});

// ─── POST /ocr-nameplate ─────────────────────────────────────────────────────
//
// Lightweight nameplate OCR: upload a photo of an electrical equipment
// nameplate and receive structured identity fields back as JSON. Intended
// for the field mobile write flow so technicians can auto-populate asset
// records without typing.
//
// Extracted fields:
//   manufacturer, model, serialNumber, voltage, kva, amperage, phases,
//   frequency, year, enclosureRating
//
// Gate order: AI_ENABLED kill-switch → IP limiter → multer → consent check
// → completeWithImage → respond. No aiQuota slot consumed (text extraction
// is cheaper and fails gracefully; quota is reserved for photo_inspect).
//
// Auth: authenticateToken applied at mount point in index.ts.
// ─────────────────────────────────────────────────────────────────────────────

// Each field returns BOTH a value and the model's self-assessed confidence so
// the client can flag the low/medium fields for a human to verify while still
// in front of the nameplate (red/yellow/green review-before-save). This mirrors
// the ServiceCycle contract-ingestion review pattern.
const OCR_SYSTEM = `You are an expert electrical equipment nameplate reader.
Extract structured data from a photo of an equipment nameplate.
Respond ONLY with a JSON object — no markdown fences, no prose.

For EACH field below return an object:
  { "value": <value-or-null>, "confidence": "high" | "medium" | "low", "sourceText": <verbatim-nameplate-snippet-or-null> }

Confidence rubric:
- "high"   — the characters are crisp and unambiguous.
- "medium" — legible but partly obscured / glare / you inferred the formatting.
- "low"    — barely legible or guessed, OR the field is not visibly present (then value = null).

"sourceText" is the VERBATIM text on the nameplate that you read the value from — including
the unit label ("kVA", "V", "A", "Hz") so a downstream check can verify the value came from
the right line. Copy it exactly as printed (e.g. "75 kVA", "480/277 V", "60 Hz", "YEAR 2015").
Return null only when the field itself is not visibly present.

Fields and their value types:
{
  "manufacturer":    string | null,   // company name on nameplate
  "model":           string | null,   // model number or designation
  "serialNumber":    string | null,   // serial number
  "voltage":         string | null,   // full voltage rating e.g. "480V" or "480/277V"
  "kva":             number | null,   // transformer kVA rating (numeric only)
  "amperage":        string | null,   // amperage / current rating e.g. "100A" or "100/200A"
  "phases":          number | null,   // 1 or 3
  "frequency":       string | null,   // e.g. "60 Hz"
  "year":            number | null,   // 4-digit manufacture year
  "enclosureRating": string | null    // NEMA or IP rating e.g. "NEMA 12" or "IP54"
}

Example element: "kva": { "value": 75, "confidence": "high", "sourceText": "KVA 75" }

Rules:
- NEVER guess a value you cannot actually see — use { "value": null, "confidence": "low", "sourceText": null }.
- For voltage, preserve the full string from the nameplate.
- For kva, return only the number (e.g. 75, not "75 kVA").
- If multiple values appear (e.g. dual-voltage transformer), use the primary.
- The "sourceText" MUST contain the unit label for that field (kVA / V / A / Hz / year).
  If you cannot see the unit label next to the value, downgrade confidence to "medium" or "low".`;

const ocrLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => `ocr_nameplate:${(req as any).user?.id || 'anon'}`,
  message: { success: false, error: 'Too many OCR requests — try again in an hour.' },
});

// Reuse same multer middleware (memory storage, 10MB, JPEG/PNG/WebP only).
const ocrUploadMiddleware = photoUpload.single('image');

router.post('/ocr-nameplate', aiPreGate, aiIpLimiter, ocrLimiter, ocrUploadMiddleware, async (req: any, res: any) => {
  const { completeWithImage, parseJSON } = require('../lib/ai');
  const { ensureAiBudget } = require('../lib/aiBudgetGuard');
  const { checkAndIncrement: meterScan, refundIncrement: refundScan } = require('../lib/aiQuota');

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No image uploaded. Send the photo as multipart field "image".' });
  }

  const { accountId, id: userId } = req.user;

  // AI consent — same gate as photo_inspect. ensureAiConsent(req,res) returns
  // a boolean and sends its OWN 403 (ai_consent_required / _outdated) when the
  // user hasn't acknowledged the current provider+version.
  if (!(await ensureAiConsent(req, res))) return;

  // Demo AI budget guard — returns false and sends its own 503 when the
  // monthly-$/daily-call fuse is tripped.
  if (!ensureAiBudget(req, res, 'ocr_nameplate')) return;

  // Demo scan meter — per-user daily cap on AI nameplate scans. ONLY the AI
  // camera scan is metered; the deterministic PDF/document import path is free
  // (it's the moat — never throttle it). Cap is env-tunable
  // (AI_DAILY_CAP_PER_USER_NAMEPLATE_SCAN); UNLIMITED on self-host / BYO-AI.
  // Refunded in the catch below so a failed read never burns a preview scan.
  const scan = await meterScan(userId, 'nameplate_scan', accountId, req.user.role);
  if (!scan.ok) {
    return res.status(429).json({
      success: false,
      error:   'ai_daily_cap_reached',
      message: `You've used all ${scan.cap} of your preview nameplate scans.`,
      data:    { count: scan.count, cap: scan.cap, resetAt: scan.resetAt },
    });
  }

  try {
    // Normalize first: EXIF-rotate, transcode HEIC→JPEG, cap size. A decode
    // failure (e.g. a corrupt upload) becomes a 400 the tech can act on.
    const { normalizeImage } = require('../lib/imageNormalize');
    let img: any;
    try { img = await normalizeImage(req.file.buffer, req.file.mimetype); }
    catch (ne: any) { return res.status(400).json({ success: false, error: ne.message || 'Could not process that image.' }); }

    // completeWithImage routes by provider (gemini → _geminiImage) and uses
    // ONLY `prompt` for images — settings.system is ignored — so the JSON
    // schema instructions must travel inside the prompt itself.
    const { text, model: readerModel } = await completeWithImage({
      imageBuffer: img.buffer,
      mediaType:   img.mimeType,
      prompt:      `${OCR_SYSTEM}\n\nRead this equipment nameplate and respond with ONLY the JSON object described above.`,
      // gemini-2.5-flash is a THINKING model and its reasoning tokens bill
      // against maxOutputTokens. The V7 evidence-string prompt (value+confidence+
      // sourceText per field × 10 fields) roughly doubled the JSON, so 1536
      // truncated it mid-object on any multi-field plate → JSON.parse failed →
      // 500 (2026-07-04: read rate fell to 1/7, only the near-blank plate fit).
      // 8192 leaves ample room for thinking AND the full nested object;
      // responseMimeType forces JSON mode (valid, fence-free, escaped output).
      maxTokens:        8192,
      responseMimeType: 'application/json',
    });

    let parsed: any;
    try {
      parsed = parseJSON(text, 'ocr-nameplate');
    } catch (parseErr) {
      // Robust fallback: if the model wrapped the JSON in prose or fences,
      // pull the first balanced {...} object out and parse that. Only a
      // genuinely truncated/empty response falls through to the 500 below.
      const m = (text || '').match(/\{[\s\S]*\}/);
      if (!m) throw parseErr;
      parsed = JSON.parse(m[0]);
    }

    // Split each field's { value, confidence } cell into a flat values map and
    // a parallel confidence map (high|medium|low) the client renders as
    // green/yellow/red so the tech verifies the uncertain fields before saving.
    // Tolerant of a model that regresses to flat values (present=medium).
    const KEYS = ['manufacturer','model','serialNumber','voltage','kva','amperage','phases','frequency','year','enclosureRating'];
    const normConf = (c: any) => (c === 'high' || c === 'medium' || c === 'low') ? c : null;
    const fields: any = {};
    const confidence: any = {};
    for (const k of KEYS) {
      const cell = parsed ? parsed[k] : null;
      if (cell && typeof cell === 'object' && 'value' in cell) {
        fields[k] = (cell.value === '' ? null : cell.value) ?? null;
        confidence[k] = fields[k] == null ? 'low' : (normConf(cell.confidence) || 'medium');
      } else {
        fields[k] = (cell === '' ? null : cell) ?? null;
        confidence[k] = fields[k] == null ? 'low' : 'medium';
      }
    }
    // Deterministic sanity downgrades — cheap guards the model can't talk past.
    // Logic lives in lib/measurementSanity so the full set (serialNumber, year,
    // phases, voltage, kva, amperage, enclosureRating) is unit-testable without
    // spinning up this route.  Mutates `confidence` in-place.
    const { applyNameplateDowngrades } = require('../lib/measurementSanity');
    applyNameplateDowngrades(fields, confidence);

    // Cross-field domain-consistency layer (2026-07-03 nameplate review §4).
    // Catches the observed failure class: an OCR that reads a crisp value from
    // the wrong line (e.g. kva=60 grabbed from a "60 Hz" frequency row).
    // POSTURE: routes suspect fields to review — NEVER auto-corrects, NEVER
    // asserts compliance. Findings become tooltip reasons for red fields.
    // See docs/NAMEPLATE_INGESTION_REVIEW_2026-07-03.md §4.
    const { checkNameplateConsistency, checkNameplateEvidence } = require('../lib/nameplateValidators');
    const consistencyFindings = checkNameplateConsistency(fields, confidence);
    // V7 evidence-string check — only fires if the model returned a `sourceText`
    // map alongside the value/confidence cells (prompt asks for it; older
    // responses regress to no evidence and this is a no-op).
    let evidenceMap: Record<string, string> | null = null;
    if (parsed && typeof parsed === 'object') {
      evidenceMap = {};
      for (const k of KEYS) {
        const cell = parsed[k];
        if (cell && typeof cell === 'object' && typeof cell.sourceText === 'string' && cell.sourceText.trim() !== '') {
          evidenceMap[k] = String(cell.sourceText);
        }
      }
      if (Object.keys(evidenceMap).length === 0) evidenceMap = null;
    }
    const evidenceFindings = checkNameplateEvidence(fields, confidence, evidenceMap);
    // Machine-readable reasons per field so the client tooltip can say WHY
    // a field is red ("60 also appears as the frequency — verify the kVA line").
    const reasons: Record<string, string[]> = {};
    for (const f of [...consistencyFindings, ...evidenceFindings]) {
      if (!reasons[f.field]) reasons[f.field] = [];
      reasons[f.field].push(f.message);
    }

    const assetId = (req.body?.assetId || '').trim();
    if (assetId) {
      void logActivity(assetId, userId, accountId, 'nameplate_ocr', {
        manufacturer: fields.manufacturer, model: fields.model,
      });
    }

    // #4 telemetry: nameplate OCR is a scan path too — log engine/coverage/
    // confidence so field accuracy is measured here as well. fieldsExtracted =
    // non-null nameplate fields; confMean from the green/yellow/red rubric.
    {
      const _cMap: any = { high: 0.9, medium: 0.6, low: 0.3 };
      const _present = KEYS.filter((k) => fields[k] != null);
      const _confs = _present.map((k) => _cMap[confidence[k]] ?? 0.6);
      void recordExtraction({
        accountId, userId: userId || null, kind: 'nameplate',
        // Actual model used (Gemini cascade hop, Groq fallback, etc.) so
        // per-provider accuracy is comparable — the sibling photo_inspect
        // path uses this same pattern at :308.
        engine: String(readerModel || 'nameplate-vision'), aiUsed: true,
        fieldsExtracted: _present.length,
        confMean: _confs.length ? _confs.reduce((a: number, b: number) => a + b, 0) / _confs.length : null,
        confMin: _confs.length ? Math.min(..._confs) : null,
      });
    }

    return res.json({ success: true, data: {
      fields, confidence, reasons,
      // Model surfaced so the client can round-trip it to the save route,
      // where it's persisted alongside the ORIGINAL AI read (below) as free
      // ground-truth. Never blank the field — 'nameplate-vision' is the
      // legacy engine label the telemetry table understands.
      readerModel: String(readerModel || 'nameplate-vision'),
      scansRemaining: Number.isFinite(scan.cap) ? Math.max(0, scan.cap - scan.count) : null,
    } });
  } catch (err: any) {
    void refundScan(userId, 'nameplate_scan', accountId); // a failed read must not burn a preview scan
    console.error('[ocr-nameplate] error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to read nameplate — try a clearer photo.' });
  }
});

module.exports = router;

export {};
