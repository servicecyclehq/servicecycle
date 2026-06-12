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
const { buildInspectContext, inspectPhoto } = require('../lib/photoInspect');
const { uploadFile }       = require('../lib/storage');
import prisma from '../lib/prisma';

// ─── Upload handling ──────────────────────────────────────────────────────────

const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10MB

const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MIME_EXT: any = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_PHOTO_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const mt = (file.mimetype || '').toLowerCase();
    if (mt === 'image/heic' || mt === 'image/heif' || /\.heic$|\.heif$/i.test(file.originalname || '')) {
      return cb(new Error('HEIC/HEIF photos are not supported — convert to JPEG or PNG first (iPhone: Settings → Camera → Formats → Most Compatible).'));
    }
    if (!ACCEPTED_MIME.has(mt)) {
      return cb(new Error('Only JPEG, PNG, or WebP images are accepted.'));
    }
    return cb(null, true);
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

router.post('/photo-inspect', aiPreGate, aiIpLimiter, photoInspectLimiter, photoUploadMiddleware, async (req, res) => {
  if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
    return res.status(400).json({ success: false, error: 'An image file is required (multipart field "image").' });
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

const OCR_SYSTEM = `You are an expert electrical equipment nameplate reader.
Your job is to extract structured data from photos of equipment nameplates.
Respond ONLY with a JSON object — no markdown fences, no prose.

Extract these fields (use null for any field not visible or legible):
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

Rules:
- Be precise; do not guess if the field is not legible.
- For voltage, preserve the full string from the nameplate.
- For kva, return only the number (e.g. 75, not "75 kVA").
- If multiple values appear (e.g. dual-voltage transformer), use the primary.`;

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

  try {
    // completeWithImage routes by provider (gemini → _geminiImage) and uses
    // ONLY `prompt` for images — settings.system is ignored — so the JSON
    // schema instructions must travel inside the prompt itself.
    const { text } = await completeWithImage({
      imageBuffer: req.file.buffer,
      mediaType:   req.file.mimetype,
      prompt:      `${OCR_SYSTEM}\n\nRead this equipment nameplate and respond with ONLY the JSON object described above.`,
      maxTokens:   512,
    });

    const fields = parseJSON(text, 'ocr-nameplate');

    // Optional: fire-and-forget activity log if assetId provided
    const assetId = (req.body?.assetId || '').trim();
    if (assetId) {
      void logActivity(assetId, userId, accountId, 'nameplate_ocr', {
        manufacturer: fields.manufacturer,
        model:        fields.model,
      });
    }

    return res.json({ success: true, data: fields });
  } catch (err: any) {
    console.error('[ocr-nameplate] error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to read nameplate — try a clearer photo.' });
  }
});

module.exports = router;

export {};
