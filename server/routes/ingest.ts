const express = require('express');
const multer = require('multer');
const { uploadFile }      = require('../lib/storage');
const { encrypt }         = require('../lib/docCrypto');
const { extractText, extractContractFields, extractFieldsFromImage, isImageType, isTextType, isEmlType } = require('../lib/extractor');
import prisma from '../lib/prisma';
const { findDefinitiveMatch, resolveViaAliasMap } = require('../lib/vendorNormalizer');
const { checkAndIncrement: checkAiQuota, refundIncrement: refundAiQuota } = require('../lib/aiQuota'); // (L1) + H3 refund-on-failure
const { ensureAiConsent } = require('../lib/aiConsent');               // Phase 4: per-session AI consent gate
const { ensureAiBudget } = require('../lib/aiBudgetGuard');            // v0.32.4: process-wide demo Gemini free-tier budget guard

const { requireManager } = require('../middleware/roles');

const router = express.Router();

// #28: load this account configurable evaluation lead-time model. Returns the
// parsed config object or null (null => built-in defaults in utils/dates).
// Defensive: a missing row or bad JSON quietly falls back and never throws.
async function loadEvalLeadTimes(accountId) {
  try {
    const row = await prisma.accountSetting.findUnique({
      where: { accountId_key: { accountId, key: 'EVALUATION_LEAD_TIMES' } },
    });
    if (!row || !row.value) return null;
    return JSON.parse(row.value);
  } catch { return null; }
}

// ── Freemium helpers ──────────────────────────────────────────────────────────

const FREE_INGEST_LIMIT = 3; // default limit, aligned with the demo AI extract cap (aiQuota DEMO_DEFAULT_CAPS.extract); can be overridden per-account via AI_INGEST_LIMIT

async function getIngestUsage(accountId) {
  const rows = await prisma.accountSetting.findMany({
    where: { accountId, key: { in: ['AI_INGEST_COUNT', 'AI_INGEST_LIMIT'] } },
  });
  const map: any = {};
  rows.forEach(r => { map[r.key] = r.value; });
  return {
    count: parseInt(map['AI_INGEST_COUNT'] || '0', 10),
    limit: parseInt(map['AI_INGEST_LIMIT'] || String(FREE_INGEST_LIMIT), 10),
  };
}

async function incrementIngestCount(accountId) {
  const existing = await prisma.accountSetting.findUnique({
    where: { accountId_key: { accountId, key: 'AI_INGEST_COUNT' } },
  });
  const next = String(parseInt(existing?.value || '0', 10) + 1);
  await prisma.accountSetting.upsert({
    where: { accountId_key: { accountId, key: 'AI_INGEST_COUNT' } },
    update: { value: next },
    create: { accountId, key: 'AI_INGEST_COUNT', value: next },
  });
}

// ── GET /api/ingest/usage ────────────────────────────────────────────────────
// Returns AI ingest usage for the current account (count + limit).
// Must be declared before upload/approve routes to avoid :sessionId conflict.
router.get('/usage', async (req, res) => {
  try {
    const usage = await getIngestUsage(req.user.accountId);
    return res.json({ success: true, data: usage });
  } catch (err) {
    console.error('Get ingest usage error:', err);
    return res.status(500).json({ success: false, error: 'Failed to fetch usage' });
  }
});

// N5: role gate — viewers cannot trigger AI extraction even via direct API calls.
// Placed after /usage so the usage endpoint remains accessible to all roles.
// Consultants are read-only-with-attribution; they hit the same 403 here
// as a plain viewer would, which matches the in-app "Changes are logged"
// banner promise.
router.use(requireManager); // (N5)

// Gate all ingest routes — AI must be enabled
router.use((req, res, next) => {
  if (process.env.AI_ENABLED === 'false') {
    return res.status(403).json({ success: false, error: 'AI features are disabled on this instance' });
  }
  next();
});

// Multer: memory storage (buffer routed through lib/storage to local FS or
// configured S3 backend per STORAGE_DEST). 25MB cap.
//
// Pass-5 / Agent 3 (2026-05-17): cap lowered from 50MB to 25MB. The original
// 50MB allowance was sized for the largest realistic procurement contracts
// in PDF form, but on a 1GB demo droplet a single 50MB upload + parallel
// Claude vision extraction can spike RSS past the OOM-killer threshold.
// 25MB still comfortably handles every real contract we have on file
// (largest observed: 18MB scanned-PDF from a state-government MSA). If a
// legitimate operator hits the cap, raising it locally via patched MIME
// allowlist is far cheaper than the droplet-OOM blast radius.
//
// F014 (2026-05-03 audit): the previous filter blanket-accepted
// `application/octet-stream` AND fell back to extension whitelist with `||`,
// which let attacker-controlled `originalname` extensions bypass the MIME
// allowlist entirely. Tightened to:
//   1. MIME must be on the explicit allowlist, OR
//   2. application/octet-stream is accepted ONLY when the extension is .lic
//      (the legitimate case — browsers don't have a registered MIME for
//      license files so they fall back to octet-stream).
// A magic-byte verifier (looksLikePlausibleIngest) runs at the route handler
// after multer accepts so attacker-controlled MIME labels can't smuggle
// arbitrary bytes past extraction. Defense in depth.
const ALLOWED_INGEST_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'message/rfc822',          // .eml (vendor renewal notices, forwarded quotes)
  'image/tiff', 'image/tif',
  'image/jpeg', 'image/jpg',
  'image/png',
]);

function getExt(name) {
  return String(name || '').toLowerCase().split('.').pop();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_INGEST_MIME.has(file.mimetype)) return cb(null, true);
    // Narrow octet-stream exemptions — browsers send octet-stream for .lic and .eml
    if (file.mimetype === 'application/octet-stream') {
      const ext = getExt(file.originalname);
      if (ext === 'lic' || ext === 'eml') return cb(null, true);
    }
    const err = new Error('Accepted file types: PDF, Word (.doc/.docx), plain text (.txt), license files (.lic), email files (.eml), images (.tiff, .jpg, .png)');
    (err as any).status = 415;
    (err as any).code = 'UNSUPPORTED_MEDIA_TYPE';
    return cb(err);
  },
});

// F014 magic-byte verifier. Trusts the *content* over the attacker-controlled
// Content-Type header. Returns true when the buffer's signature is consistent
// with the declared MIME (or, for .lic, with printable-text content).
function looksLikePlausibleIngest(buf, mime, originalname) {
  if (!buf || buf.length < 4) return false;
  // PDF: "%PDF"
  if (mime === 'application/pdf') {
    return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
  }
  // DOCX (OOXML ZIP container): "PK\x03\x04"
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
  }
  // Legacy .doc / OLE2 compound: D0 CF 11 E0 A1 B1 1A E1
  if (mime === 'application/msword') {
    if (buf.length < 8) return false;
    return buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0
        && buf[4] === 0xA1 && buf[5] === 0xB1 && buf[6] === 0x1A && buf[7] === 0xE1;
  }
  // Plain text (.txt), license files (.lic), and email files (.eml /
  // message/rfc822) — verify the first 256 bytes are printable ASCII
  // (allow tab/CR/LF). Catches binary smuggling via these permissive MIMEs.
  // .eml files are RFC 2822 messages: human-readable headers at the start,
  // so the ASCII-printability gate is a reliable and cheap signal.
  if (mime === 'text/plain' || mime === 'message/rfc822' ||
      (mime === 'application/octet-stream' && (getExt(originalname) === 'lic' || getExt(originalname) === 'eml'))) {
    const sample = buf.slice(0, Math.min(256, buf.length));
    for (let i = 0; i < sample.length; i++) {
      const b = sample[i];
      const ok = b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126);
      if (!ok) return false;
    }
    return true;
  }
  // Image types — same magic-byte tests used in routes/documents.js.
  if (mime === 'image/png') {
    return buf.length >= 8
        && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
        && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A;
  }
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  }
  if (mime === 'image/tiff' || mime === 'image/tif') {
    return (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00)
        || (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A);
  }
  return false;
}

// ── POST /api/ingest/upload ───────────────────────────────────────────────────
// Accepts a PDF or Word file, persists it via lib/storage (local FS by
// default, S3-compatible if STORAGE_DEST=s3), runs Claude extraction,
// and returns the ingestion session for the review UI.
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  // F014 (2026-05-03 audit): magic-byte verification AFTER multer accepts
  // but BEFORE we hand the buffer to storage / extraction / Claude. Catches
  // forged Content-Type headers — the attacker controls both the MIME and the
  // filename, so byte-level verification is the only honest gate.
  if (!looksLikePlausibleIngest(req.file.buffer, req.file.mimetype, req.file.originalname)) {
    return res.status(415).json({
      success: false,
      error: 'File contents do not match the declared type — only genuine PDF/Word/text/license/email (.eml)/image files are accepted.',
    });
  }

  const { accountId, id: userId } = req.user;
  const { contractId } = req.body; // optional — link to existing contract

  // ── Freemium gate — check before doing any work ──────────────────────────
  //
  // Pass-4.5 AI-P0-4 (2026-05-17) — pre-fix this caught the freemium
  // limit error and continued ("Non-fatal — allow upload to proceed if
  // usage check fails"), making the cap fail-open under transient DB
  // hiccups. Combined with no per-document idempotency the audit
  // (audit/ai-safety/02-document-upload.md Scenario 10) modelled
  // attackers re-uploading the same document on consecutive UTC days
  // to bleed the shared Anthropic key. Now we fail CLOSED on freemium
  // check errors — better to short-circuit a legitimate user with a
  // retryable 503 than to silently let an attacker through.
  try {
    const usage = await getIngestUsage(accountId);
    if (usage.count >= usage.limit) {
      return res.status(402).json({
        success: false,
        error: 'free_limit_reached',
        data: { count: usage.count, limit: usage.limit },
      });
    }
  } catch (err) {
    console.error('Ingest usage check error (failing CLOSED — Pass-4.5 AI-P0-4):', err);
    return res.status(503).json({
      success: false,
      error: 'ingest_usage_check_unavailable',
      message: 'The freemium usage check is temporarily unavailable. Please try again in a moment.',
    });
  }

  // Pass-4.5 AI-P0-4 (2026-05-17) — per-account re-extraction cooldown.
  //
  // Re-uploading the same content (renamed file, slightly modified
  // metadata) within a short window is overwhelmingly likely to be a
  // budget-burn attempt rather than a legitimate flow. We hash the
  // file buffer and reject within INGEST_REEXTRACT_COOLDOWN_SECONDS
  // (default 600 = 10 minutes) per (accountId, contentHash). The
  // Document table already has filename + filePath + uploadedBy; we
  // use a lightweight per-(accountId, contentSha256) cooldown via an
  // in-memory Map for now (single-process demo). When we move to a
  // multi-replica setup this lives in Redis or a Postgres advisory
  // lock; for the single demo droplet a per-process Map is sufficient.
  try {
    const crypto = require('crypto');
    const contentHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const cooldownSec = parseInt(process.env.INGEST_REEXTRACT_COOLDOWN_SECONDS || '600', 10);
    if (!global.__lapseiq_ingest_cooldown) global.__lapseiq_ingest_cooldown = new Map();
    const cooldownMap = global.__lapseiq_ingest_cooldown;
    const key = `${accountId}:${contentHash}`;
    const now = Date.now();
    const last = cooldownMap.get(key);
    if (last && (now - last) < cooldownSec * 1000) {
      const remainSec = Math.ceil((cooldownSec * 1000 - (now - last)) / 1000);
      return res.status(429).json({
        success: false,
        error: 'ingest_reextract_cooldown',
        message: `This document was just extracted. Please wait ${remainSec}s before re-extracting the same content.`,
        data: { cooldownSec: remainSec },
      });
    }
    cooldownMap.set(key, now);
    // Lightweight prune: when the map grows past 10k entries, drop ones
    // older than the cooldown window. Bounded memory under sustained
    // hostile load.
    if (cooldownMap.size > 10000) {
      const cutoff = now - cooldownSec * 1000;
      for (const [k, v] of cooldownMap) if (v < cutoff) cooldownMap.delete(k);
    }
  } catch (err) {
    // Hashing failure is implausible; if it happens, log + proceed (the
    // hash is defense-in-depth on top of the per-user daily cap below).
    console.error('Ingest re-extract cooldown check error (continuing):', err);
  }

  // ── Phase 4: per-session AI consent gate ─────────────────────────────────
  // Server-side enforcement before any AI work. 403 with
  // 'ai_consent_required' the first time a user hits ANY AI endpoint.
  if (!(await ensureAiConsent(req, res))) return;

  // ── v0.32.4: global-day budget guard (DEMO_MODE only) ────────────────────
  // No-op on self-host. On demo, increments a process-wide counter and
  // returns 503 ai_demo_budget_exhausted when GEMINI_DAILY_CALL_BUDGET
  // (default 1300) is hit. Runs BEFORE the per-user quota so a leaky
  // slot is on the global counter (invisible to user) rather than the
  // user counter (visible). See lib/aiBudgetGuard.js for rationale.
  if (!ensureAiBudget(req, res)) return;

  // ── L1: AI daily-cap gate (per user, per action, per UTC day) ────────────
  // Sits AFTER the per-account freemium gate but BEFORE any storage / Anthropic
  // work. Cap is unlimited on self-hosted by default; DEMO_MODE forces 2.
  //
  // 'extract' is the SHARED bucket — PDF ingest + signature reading both
  // decrement the same per-user daily counter, matching the Demo Sandbox
  // Notice's "PDF and signature share a combined cap of 2/day per user."
  try {
    const quota = await checkAiQuota(userId, 'extract', req.user.accountId, req.user.role);
    if (!quota.ok) {
      return res.status(402).json({
        success: false,
        error: 'ai_daily_cap_reached',
        data: { count: quota.count, cap: quota.cap, resetAt: quota.resetAt },
      });
    }
  } catch (err) {
    // Quota infra failure: log + allow through. Fail-open is the right choice
    // here — better to over-spend a few credits than to lock paying customers
    // out because a single Postgres call hiccuped.
    console.error('AI quota check error (failing open):', err);
  }

  let session = null;

  try {
    // 1. Check whether this account has document encryption enabled
    const encSetting = await prisma.accountSetting.findUnique({
      where: { accountId_key: { accountId, key: 'ENCRYPTION_ENABLED' } },
    });
    const shouldEncrypt = encSetting?.value === 'true';

    // 2. Pre-generate the document ID so it can be used as the encryption salt
    //    before we write to the DB (key derivation requires a stable identifier).
    const { v4: uuidv4 } = require('uuid');
    const documentId = uuidv4();

    // 3. Encrypt the file buffer if encryption is enabled for this account
    let fileBuffer = req.file.buffer;
    if (shouldEncrypt) {
      fileBuffer = encrypt(fileBuffer, documentId);
    }

    // 4. Upload to storage (local filesystem or S3-compatible)
    const { storageKey } = await uploadFile(
      accountId,
      contractId || null,
      req.file.originalname,
      fileBuffer,
      req.file.mimetype
    );

    // 5. Create Document record
    const document = await prisma.document.create({
      data: {
        id:         documentId,
        accountId,
        contractId: contractId || null,
        filename:   req.file.originalname,
        filePath:   storageKey,
        fileType:   req.file.mimetype,
        encrypted:  shouldEncrypt,
        uploadedBy: userId,
      },
    });

    // 6. Create IngestionSession (status: processing)
    session = await prisma.ingestionSession.create({
      data: {
        accountId,
        documentId: document.id,
        originalFilename: req.file.originalname,
        status: 'processing',
      },
    });

    // 7. Extract fields — image files go via Claude vision, everything else via text
    let rawText = null;
    let extracted;

    if (isImageType(req.file.mimetype)) {
      // Image file (TIFF/JPEG/PNG): send directly to Claude vision
      extracted = await extractFieldsFromImage(req.file.buffer, req.file.mimetype);
      rawText = `[Extracted from image (${req.file.mimetype}) via Claude vision]`;
    } else {
      // PDF, Word, TXT, LIC: extract text first then send to Claude
      rawText = await extractText(req.file.buffer, req.file.mimetype, req.file.originalname);
      extracted = await extractContractFields(rawText);
    }

    const { confidenceScores, aiNotes, flags, ...fields } = extracted;

    // 8. Persist extraction results in a single atomic update so a failure
    //    here never leaves the session in an inconsistent half-written state.
    session = await prisma.ingestionSession.update({
      where: { id: session.id },
      data: {
        rawText,
        extractedFields: fields,
        confidenceScores: confidenceScores || {},
        // Merge aiNotes text + flags together so the review UI gets both in one read.
        aiNotes: { notes: aiNotes || null, flags: flags || [] },
        status: 'review_pending',
      },
    });

    // 8b. v0.10.0: look up active contracts that look like the master
    //     agreement this extraction belongs under. The Microsoft MPSA /
    //     Adobe VIP pattern is one contractNumber with many PO deliverables;
    //     when extraction surfaces a contractNumber that ALREADY exists for
    //     the same vendor, the right action is to add a PO under it, not
    //     create a new Contract. The review UI uses this candidate list to
    //     branch its primary CTA.
    //
    //     Normalisation rules (mirror /api/contracts/match):
    //       - vendor: case-insensitive containment in either direction
    //       - contract number: equality after stripping non-alphanumeric
    //     Fails open: an error here doesn't block the review screen.
    let matchCandidates = [];
    try {
      const vendorRaw = String(fields?.vendorName || '').trim();
      const cnRaw     = String(fields?.contractNumber || '').trim();
      if (vendorRaw || cnRaw) {
        const candidatePool = await prisma.contract.findMany({
          where: {
            accountId,
            archivedAt: null,
            status: { in: ['active', 'under_review'] },
            ...(vendorRaw
              ? { vendor: { name: { contains: vendorRaw.split(/\s+/)[0], mode: 'insensitive' } } }
              : {}),
          },
          include: {
            vendor: { select: { id: true, name: true } },
            purchaseOrders: {
              where:   { archivedAt: null },
              select:  { id: true, poNumber: true },
              orderBy: { orderDate: 'desc' },
              take:    3,
            },
          },
          orderBy: { endDate: 'desc' },
          take:    50,
        });
        const norm   = (s) => String(s || '').trim().toLowerCase();
        const normCN = (s) => norm(s).replace(/[^a-z0-9]/g, '');
        const vN     = norm(vendorRaw);
        const cnN    = normCN(cnRaw);
        matchCandidates = candidatePool.filter((c) => {
          const vendorN  = norm(c.vendor?.name);
          const vendorOK = vN === '' || vendorN.includes(vN) || vN.includes(vendorN);
          const cnOK     = cnN === '' || normCN(c.contractNumber) === cnN;
          return vendorOK && cnOK && (vN !== '' || cnN !== '');
        }).slice(0, 5);
      }
    } catch (matchErr) {
      console.warn('[ingest] match-candidate lookup failed (failing open):', matchErr.message);
    }

    // 6. Increment freemium usage counter (non-blocking — don't fail the upload if this errors)
    incrementIngestCount(accountId).catch(e => console.error('Ingest count increment error:', e));

    return res.json({
      success: true,
      data: {
        sessionId: session.id,
        documentId: document.id,
        status: session.status,
        extractedFields: fields,
        confidenceScores: confidenceScores || {},
        aiNotes: aiNotes || null,
        flags: flags || [],
        matchCandidates,
      },
    });
  } catch (err) {
    console.error('Ingest error:', err);

    // Mark session as failed if it was created
    if (session) {
      await prisma.ingestionSession.update({
        where: { id: session.id },
        data: { status: 'failed' },
      }).catch(() => {});
    }

    // H3 (audit High, 2026-05-22): refund the 'extract' quota slot we
    // charged at the top of the handler. Without this, every CF Workers AI
    // 502 / S3 hiccup / extractor throw permanently burned one of the
    // user's 2-per-day extract slots.
    await refundAiQuota(userId, 'extract', req.user.accountId);

    console.error('Ingest upload error:', err);
    return res.status(500).json({ success: false, error: 'Failed to process upload. Please try again.' });
  }
});

// ── GET /api/ingest/:sessionId ────────────────────────────────────────────────
// Fetch a session for the review UI (re-load after page refresh)
router.get('/:sessionId', async (req, res) => {
  const { accountId } = req.user;

  const session = await prisma.ingestionSession.findFirst({
    where: { id: req.params.sessionId, accountId },
    include: { document: true },
  });

  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  return res.json({ success: true, data: session });
});

// ── POST /api/ingest/:sessionId/approve ──────────────────────────────────────
// User has reviewed + optionally corrected fields. Two modes (v0.10.0):
//
//   mode='create' (default — pre-v0.10.0 behavior):
//     Creates a new Contract row from the extracted fields.
//     Body: { mode?: 'create', fields, vendorId, createVendor }
//
//   mode='attach' (v0.10.0):
//     Creates a PurchaseOrder under an existing Contract instead of a new
//     Contract. Used for the Microsoft MPSA / Adobe VIP case where the
//     extraction's contractNumber + vendor matched one of the candidates
//     surfaced in the upload response's matchCandidates array.
//     Body: { mode: 'attach', attachToContractId, fields }
router.post('/:sessionId/approve', async (req, res) => {
  const { accountId, id: userId } = req.user;
  const { fields, vendorId, createVendor, mode, attachToContractId } = req.body;

  try {
    const session = await prisma.ingestionSession.findFirst({
      where: { id: req.params.sessionId, accountId },
    });

    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    if (session.status === 'imported') {
      return res.status(400).json({ success: false, error: 'Already imported' });
    }

    // ── v0.10.0: attach-as-PO branch ─────────────────────────────────────────
    // Triggered when the review UI presented a matchCandidate and the user
    // confirmed "add this as a PO under [existing contract]." Skips all the
    // vendor resolution + contract create logic and just writes a single
    // PurchaseOrder row under the target contract.
    if (mode === 'attach') {
      const targetId = String(attachToContractId || '').trim();
      if (!targetId) {
        return res.status(400).json({ success: false, error: 'attachToContractId is required when mode=attach' });
      }
      // Account scoping — the target contract MUST belong to the caller's
      // account. Without this an attacker could submit any contract id.
      const target = await prisma.contract.findFirst({
        where: { id: targetId, accountId, archivedAt: null },
        select: { id: true, contractNumber: true, vendorId: true },
      });
      if (!target) {
        return res.status(404).json({ success: false, error: 'Target contract not found' });
      }

      const storedFields: any = session.extractedFields || {};
      const merged: any = { ...storedFields, ...(fields || {}) };
      const poNumber     = String(merged.poNumber || '').trim();
      if (!poNumber) {
        return res.status(400).json({ success: false, error: 'Extracted poNumber is empty; cannot attach without a PO number. Edit the fields or use create mode.' });
      }

      const parseAmount = (v) => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const parseDate = (v) => {
        if (!v) return null;
        const d = new Date(v);
        return isNaN(d.getTime()) ? null : d;
      };

      const result = await prisma.$transaction(async (tx) => {
        const po = await tx.purchaseOrder.create({
          data: {
            contractId:        target.id,
            poNumber,
            description:       merged.product ? String(merged.product).slice(0, 500) : null,
            amount:            parseAmount(merged.totalValue ?? (merged.costPerLicense && merged.quantity ? merged.costPerLicense * merged.quantity : null) ?? merged.costPerLicense),
            quantity:          parseAmount(merged.quantity),
            orderDate:         parseDate(merged.startDate),
            coverageStartDate: parseDate(merged.startDate),
            coverageEndDate:   parseDate(merged.endDate),
            notes:             'Imported via AI ingestion (attached to existing master agreement).',
          },
        });

        // IngestionSession has no importedContractId field by design (the
        // audit trail lives on the contract's ActivityLog instead). Mark
        // imported + stamp importedAt so the session stops appearing in the
        // review queue.
        await tx.ingestionSession.update({
          where: { id: session.id },
          data:  { status: 'imported', importedAt: new Date() },
        });

        await tx.activityLog.create({
          data: {
            contractId: target.id,
            userId,
            action:     'po_added_via_ingest',
            details:    { poNumber, poId: po.id, sessionId: session.id },
          },
        }).catch(() => { /* non-fatal */ });

        return { contractId: target.id, purchaseOrder: po };
      });

      return res.json({
        success: true,
        data: { mode: 'attach', contractId: result.contractId, purchaseOrder: result.purchaseOrder },
      });
    }

    // ── Resolve vendor (outside the transaction so we can return early) ────────
    let resolvedVendorId = vendorId;

    // SECURITY: when the caller supplies vendorId directly (the non-createVendor
    // branch), verify it belongs to the caller's account before any of the
    // downstream tx writes run. Without this, a legitimate manager/admin in
    // account A could submit a vendorId from account B and the transaction
    // below would mutate that vendor's row, inject contacts under it, and
    // create a contract in A that references B's vendor (cross-account FK).
    // Same shape as the ownership checks in routes/contracts.js POST and
    // routes/budget.js PUT vendor-uplift.
    if (resolvedVendorId) {
      const owned = await prisma.vendor.findFirst({
        where:  { id: resolvedVendorId, accountId },
        select: { id: true },
      });
      if (!owned) {
        return res.status(404).json({ success: false, error: 'Vendor not found' });
      }
    }

    if (!resolvedVendorId && createVendor) {
      const rawName = createVendor.trim();

      // Use the normalizer for smarter matching — catches abbreviations, aliases,
      // and slight name variations that a plain case-insensitive compare would miss.
      const allVendors = await prisma.vendor.findMany({
        where: { accountId },
        select: { id: true, name: true, aliases: true },
      });
      const vendorsForCheck = allVendors.map(v => ({
        ...v,
        aliases: Array.isArray(v.aliases) ? v.aliases : [],
      }));

      const definitive = findDefinitiveMatch(rawName, vendorsForCheck);

      if (definitive) {
        // Strong match — reuse the existing vendor
        resolvedVendorId = definitive.vendor.id;
      } else {
        // No match — resolve canonical name from alias map before creating
        const canonicalName = resolveViaAliasMap(rawName) || rawName;
        resolvedVendorId = (await prisma.vendor.create({
          data: { accountId, name: canonicalName },
        })).id;
      }
    }

    if (!resolvedVendorId) {
      return res.status(400).json({ success: false, error: 'vendorId is required' });
    }

    // ── All remaining writes run in a single transaction ──────────────────────
    // If anything fails (contract create, flag create, session update, etc.) the
    // entire set of changes rolls back — no orphaned contracts or stuck sessions.
    const { calculateEvaluationStartByDate } = require('../utils/dates');
    const _eltCfg = await loadEvalLeadTimes(accountId); // #28 configurable lead times

    const storedFields: any  = session.extractedFields || {};
    const vendorSupport = storedFields.vendorSupport || {};
    const reseller      = storedFields.reseller || {};
    const vendorContacts = storedFields.vendorContacts || [];

    const contractId = await prisma.$transaction(async (tx) => {

      // 1. Update vendor with any support info extracted from the document
      const vendorUpdateData: any = {};
      if (vendorSupport.supportEmail)     vendorUpdateData.supportEmail     = vendorSupport.supportEmail;
      if (vendorSupport.supportPhone)     vendorUpdateData.supportPhone     = vendorSupport.supportPhone;
      if (vendorSupport.supportPortalUrl) vendorUpdateData.supportPortalUrl = vendorSupport.supportPortalUrl;
      if (Object.keys(vendorUpdateData).length > 0) {
        await tx.vendor.update({ where: { id: resolvedVendorId }, data: vendorUpdateData });
      }

      // 2. Create any vendor contacts that were extracted (skip email duplicates)
      for (const c of vendorContacts) {
        if (!c.name) continue;
        const exists = c.email
          ? await tx.vendorContact.findFirst({ where: { vendorId: resolvedVendorId, email: c.email } })
          : null;
        if (!exists) {
          await tx.vendorContact.create({
            data: {
              vendorId: resolvedVendorId,
              name: c.name,
              title: c.title || null,
              email: c.email || null,
              phone: c.phone || null,
            },
          });
        }
      }

      // 3. Build and create the contract
      const contractData: any = {
        accountId,
        vendorId: resolvedVendorId,
        product:               fields.product || 'Unknown Product',
        contractNumber:        fields.contractNumber || null,
        customerNumber:        fields.customerNumber || null,
        quantity:              fields.quantity ? parseInt(fields.quantity) : null,
        costPerLicense:        fields.costPerLicense ? parseFloat(fields.costPerLicense) : null,
        startDate:             fields.startDate ? new Date(fields.startDate) : null,
        endDate:               fields.endDate   ? new Date(fields.endDate)   : null,
        autoRenewal:           fields.autoRenewal === true || fields.autoRenewal === 'true',
        autoRenewalNoticeDays: fields.autoRenewalNoticeDays ? parseInt(fields.autoRenewalNoticeDays) : null,
        poNumber:              fields.poNumber    || null,
        invoiceNumber:         fields.invoiceNumber || null,
        department:            fields.department  || null,
        requestor:             fields.requestor   || null,
        notes:                 fields.notes       || null,
        resellerName:          fields.resellerName          || reseller.resellerName          || null,
        resellerAccountNumber: fields.resellerAccountNumber || reseller.resellerAccountNumber || null,
        resellerContactName:   fields.resellerContactName   || reseller.resellerContactName   || null,
        resellerContactEmail:  fields.resellerContactEmail  || reseller.resellerContactEmail  || null,
        status: 'active',
      };

      const totalValue =
        contractData.quantity && contractData.costPerLicense
          ? contractData.quantity * contractData.costPerLicense
          : null;
      // (A3 5/02) Persist denormalized totalValue so the contracts list can
      // sort by computed value in DB.
      contractData.totalValue = totalValue;
      contractData.evaluationStartByDate = calculateEvaluationStartByDate(contractData.endDate, contractData.costPerLicense, contractData.quantity, _eltCfg);

      if (contractData.autoRenewal && contractData.autoRenewalNoticeDays && contractData.endDate) {
        const cancelBy = new Date(contractData.endDate);
        cancelBy.setDate(cancelBy.getDate() - contractData.autoRenewalNoticeDays);
        contractData.cancelByDate = cancelBy;
      }

      const contract = await tx.contract.create({ data: contractData });

      // 4. Link the uploaded document to the new contract
      if (session.documentId) {
        await tx.document.update({
          where: { id: session.documentId },
          data: { contractId: contract.id },
        });
      }

      // 5. Create any AI-detected risk flags
      const aiNotes: any = session.aiNotes || {};
      const flags   = aiNotes.flags || [];
      if (flags.length > 0) {
        await tx.contractFlag.createMany({
          data: flags.map((f) => ({
            contractId:  contract.id,
            flagType:    f.flagType    || 'other',
            description: f.description || '',
            sourceText:  f.sourceText  || null,
          })),
        });
      }

      // 6. Mark session imported — must be last so a mid-transaction crash
      //    leaves the session still in review_pending (retryable).
      await tx.ingestionSession.update({
        where: { id: session.id },
        data: {
          status:             'imported',
          reviewedBy:         userId,
          reviewCompletedAt:  new Date(),
          importedAt:         new Date(),
          extractedFields:    fields,
        },
      });

      return contract.id;
    });

    return res.json({ success: true, data: { contractId } });

  } catch (err) {
    console.error('Approve error:', err);
    return res.status(500).json({ success: false, error: 'Failed to approve contract. Please try again.' });
  }
});

// ── POST /api/ingest/:sessionId/reject ───────────────────────────────────────
// User discards the extracted data (no contract created)
router.post('/:sessionId/reject', async (req, res) => {
  const { accountId, id: userId } = req.user;

  const session = await prisma.ingestionSession.findFirst({
    where: { id: req.params.sessionId, accountId },
  });

  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  await prisma.ingestionSession.update({
    where: { id: session.id },
    data: {
      status: 'failed',
      reviewedBy: userId,
      reviewCompletedAt: new Date(),
    },
  });

  return res.json({ success: true });
});

// ── POST /api/ingest/csv-import ───────────────────────────────────────────────
// Bulk-create contracts from parsed CSV rows sent by the client.
// Vendor names are matched case-insensitively or created on the fly.
// Returns { imported: N, failed: [{ line, error }] }
router.post('/csv-import', async (req, res) => {
  const { accountId, id: userId } = req.user;
  const { rows } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ success: false, error: 'No rows provided' });
  }

  const { calculateEvaluationStartByDate, calculateCancelByDate } = require('../utils/dates');

  const _eltCfg = await loadEvalLeadTimes(accountId); // #28 configurable lead times

  // Cache vendor lookups to avoid repeated DB hits for the same vendor name
  const vendorCache: any = {};

  // Fetch all existing vendors once for the whole CSV run (normalizer needs the full list)
  const allVendors = await prisma.vendor.findMany({
    where: { accountId },
    select: { id: true, name: true, aliases: true },
  });
  const vendorsForCheck = allVendors.map(v => ({
    ...v,
    aliases: Array.isArray(v.aliases) ? v.aliases : [],
  }));
  // Keep a live copy so newly created vendors are also checked within the same run
  const liveVendors = [...vendorsForCheck];

  async function resolveVendor(name) {
    if (!name?.trim()) return null;
    const rawName = name.trim();
    const cacheKey = rawName.toLowerCase();
    if (vendorCache[cacheKey]) return vendorCache[cacheKey];

    // Use normalizer for smarter dedup — catches abbreviations, aliases, near-matches
    const definitive = findDefinitiveMatch(rawName, liveVendors);
    if (definitive) {
      vendorCache[cacheKey] = definitive.vendor.id;
      return definitive.vendor.id;
    }

    // No match — resolve canonical name before creating
    const canonicalName = resolveViaAliasMap(rawName) || rawName;
    const created = await prisma.vendor.create({
      data: { accountId, name: canonicalName },
    });
    // Add to live list so subsequent rows in the same CSV can match against it
    liveVendors.push({ id: created.id, name: created.name, aliases: [] });
    vendorCache[cacheKey] = created.id;
    return created.id;
  }

  function parseDate(s) {
    if (!s?.trim()) return null;
    const d = new Date(s.trim());
    return isNaN(d.getTime()) ? null : d;
  }

  function parseBool(s) {
    if (!s?.trim()) return false;
    return ['true', 'yes', '1'].includes(s.trim().toLowerCase());
  }

  const VALID_STATUSES = ['active', 'under_review', 'renewed', 'cancelled', 'expired'];
  const VALID_DELIVERY = ['user', 'device', 'shared_pool'];

  let imported = 0;
  const failed = [];
  // Pre-2026-05-03 this loop did one prisma.contract.create() per row, so a
  // 5,000-row CSV took 5,000 round-trips. Refactored to validate + shape the
  // payload in the loop, accumulate into `dataToCreate`, then issue a single
  // chunked `createMany` at the end. Per-row validation errors still go to
  // `failed[]`; only DB-level failures (FK / unique violations) lose row-
  // granularity, which is the acceptable trade-off for admin-initiated bulk
  // import. (Opus N+1 audit follow-up.)
  const dataToCreate = [];

  for (const row of rows) {
    const line = row._line ?? '?';
    try {
      const vendorId = await resolveVendor(row.vendor_name);
      if (!vendorId) {
        failed.push({ line, error: 'vendor_name is required' });
        continue;
      }
      if (!row.product?.trim()) {
        failed.push({ line, error: 'product is required' });
        continue;
      }

      const startDate  = parseDate(row.start_date);
      const endDate    = parseDate(row.end_date);
      const quantity   = row.quantity   ? parseInt(row.quantity)          : null;
      const costPerLic = row.cost_per_license ? parseFloat(row.cost_per_license) : null;
      const autoRen    = parseBool(row.auto_renewal);
      const noticeDays = row.auto_renewal_notice_days ? parseInt(row.auto_renewal_notice_days) : null;
      const status     = VALID_STATUSES.includes(row.status) ? row.status : 'active';
      const delivery   = VALID_DELIVERY.includes(row.delivery_method) ? row.delivery_method : null;

      const evaluationStartByDate = calculateEvaluationStartByDate(endDate, costPerLic, quantity, _eltCfg);
      const cancelByDate = calculateCancelByDate(endDate, autoRen, noticeDays);

      dataToCreate.push({
        accountId,
        vendorId,
        product:               row.product.trim(),
        contractNumber:        row.contract_number?.trim()   || null,
        customerNumber:        row.customer_number?.trim()   || null,
        status,
        startDate,
        endDate,
        evaluationStartByDate,
        cancelByDate,
        quantity,
        costPerLicense:        costPerLic,
        // (A3 5/02) denormalized total value
        totalValue:            (quantity != null && costPerLic != null) ? costPerLic * quantity : null,
        autoRenewal:           autoRen,
        autoRenewalNoticeDays: noticeDays,
        poNumber:              row.po_number?.trim()         || null,
        invoiceNumber:         row.invoice_number?.trim()    || null,
        department:            row.department?.trim()        || null,
        team:                  row.team?.trim()              || null,
        costCenter:            row.cost_center?.trim()       || null,
        requestor:             row.requestor?.trim()         || null,
        deliveryMethod:        delivery,
        notes:                 row.notes?.trim()             || null,
        resellerName:          row.reseller_name?.trim()     || null,
        resellerAccountNumber: row.reseller_account_number?.trim() || null,
        resellerContactName:   row.reseller_contact_name?.trim()   || null,
        resellerContactEmail:  row.reseller_contact_email?.trim()  || null,
      });
    } catch (err) {
      console.error(`CSV import row ${line} error:`, err.message);
      failed.push({ line, error: err.message });
    }
  }

  // Bulk-insert in chunks of 500. Larger batches risk hitting Postgres'
  // bind-parameter limit (~32k); 500 rows × ~25 columns = 12,500 binds,
  // comfortable margin. createMany skipDuplicates handles the rare case
  // of two CSV rows producing the same unique-constrained key (none on
  // Contract today, but defensive).
  const BATCH_SIZE = 500;
  try {
    for (let i = 0; i < dataToCreate.length; i += BATCH_SIZE) {
      const chunk  = dataToCreate.slice(i, i + BATCH_SIZE);
      const result = await prisma.contract.createMany({ data: chunk, skipDuplicates: true });
      imported += result.count;
    }
  } catch (err) {
    console.error('CSV import bulk insert failed:', err.message);
    // Surface the batch failure on the response without losing the per-row
    // validation failures already in `failed[]`.
    return res.status(500).json({
      success: false,
      error:   `Bulk insert failed after ${imported} of ${dataToCreate.length} rows: ${err.message}`,
      data:    { imported, failed },
    });
  }

  return res.json({ success: true, data: { imported, failed } });
});

module.exports = router;

export {};
