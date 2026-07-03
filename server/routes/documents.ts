'use strict';

/**
 * routes/documents.js
 * -------------------
 * Serves stored equipment documents back to authenticated users.
 *
 * GET /api/documents/file?key=<storageKey>
 *   — Streams a locally stored file. Auth enforced at mount level +
 *     account ownership verified here. Handles on-the-fly decryption
 *     for encrypted documents.
 *
 * GET /api/documents/:documentId/url
 *   — Returns a URL to access the document (local API path or S3
 *     pre-signed URL depending on STORAGE_DEST).
 */

const express            = require('express');
const multer             = require('multer');
import prisma from '../lib/prisma'; // (S7) default export — the existing { prisma } destructure was a no-op bug
const { downloadFile, uploadFile, getFileUrl } = require('../lib/storage');
const { decrypt, encrypt } = require('../lib/docCrypto');
const { writeLog: writeActivityLog } = require('../lib/activityLog');
const { requireManager } = require('../middleware/roles'); // RBAC: uploads are manager+ only (consultants are read-only)

const router = express.Router();

// ── Upload validation (S7) ───────────────────────────────────────────────────
// Server-side MIME and size enforcement. Anything outside the allowlist is
// rejected with HTTP 415 BEFORE the bytes are persisted to disk/S3.
//
// Allowlist: PDFs, Word (legacy + OOXML), and any image/* type.
// Size cap: 20 MB enforced at the multer `limits` level — multer aborts the
// stream as soon as the threshold is crossed, so a malicious 5 GB upload never
// hits storage.
//
// fileFilter cb pattern:
//   cb(err)        → multer surfaces err.message in the route's catch
//   cb(null, false)→ multer silently drops the file (we'd rather fail loudly)
// We pass an Error tagged with .status = 415 so the route handler can return
// a precise status code instead of multer's default 500.

const ALLOWED_DOC_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

// Image MIMEs to actively reject regardless of magic bytes (F011 / 2026-05-03 audit).
// SVG is XML and supports inline <script>; with Content-Disposition: inline (the
// default for documents we serve back) the file renders as live HTML in the
// authenticated origin. The CSP (script-src 'self' with no unsafe-inline)
// blocks inline script execution, but defense-in-depth dictates we never store
// SVG via this surface.
const DENIED_IMAGE_MIME = new Set([
  'image/svg+xml',
  'image/svg',
]);

// Provenance is human-authoritative + conservative: accept only known values,
// otherwise leave it unset so the column default ('unverified') applies.
function validProvenance(p) {
  return ['pe_sealed', 'engineered', 'as_built', 'vendor', 'unverified'].includes(p) ? p : undefined;
}

// docType must match the Prisma DocType enum (or be empty/null = unclassified).
// Validate before it reaches Prisma so a bad value returns a clean 400, not a 500.
const DOC_TYPES = ['oem_manual', 'wiring_diagram', 'loto_pdf', 'test_report', 'inspection_report', 'commissioning_report', 'warranty', 'other'];
function isValidDocType(t) { return t == null || t === '' || DOC_TYPES.includes(t); }

function isAllowedUploadMime(mimetype) {
  if (!mimetype) return false;
  if (DENIED_IMAGE_MIME.has(mimetype)) return false; // F011
  if (ALLOWED_DOC_MIME.has(mimetype)) return true;
  if (mimetype.startsWith('image/')) return true;
  return false;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 }, // (S7) 20 MB hard cap
  fileFilter: (req, file, cb) => {
    // SEC4: enforce the MIME allowlist (PDF, Word, images; SVG blocked via
    // DENIED_IMAGE_MIME + isAllowedUploadMime). Previously called cb(null,true)
    // unconditionally, allowing arbitrary MIME types through. Now any file
    // whose MIME fails the allowlist is rejected with HTTP 415 before storage.
    // The magic-byte gate below (magicBytesRejected) remains a second layer.
    if (!isAllowedUploadMime(file.mimetype)) {
      const err: any = new Error(
        `File type '${file.mimetype}' is not allowed. Accepted types: PDF, Word (.doc/.docx), and common image formats.`
      );
      err.status = 415;
      err.code   = 'UNSUPPORTED_MEDIA_TYPE';
      return cb(err);
    }
    return cb(null, true);
  },
});

// Magic-byte sniffer. The multer fileFilter trusts the Content-Type header
// the client sets, which is fully attacker-controlled. This second-line
// check reads the actual file signature and rejects mismatches. Defense
// in depth — even if a forged Content-Type slips past the fileFilter, a
// non-PDF / non-Word / non-image payload won't match here.
function looksLikeDeclaredType(buf, mime) {
  if (!buf || buf.length < 4) return false;

  // PDF: "%PDF"
  if (mime === 'application/pdf') {
    return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
  }

  // DOCX (and the rest of OOXML) is a ZIP container — "PK\x03\x04"
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
  }

  // Legacy .doc / OLE2 compound: D0 CF 11 E0 A1 B1 1A E1
  if (mime === 'application/msword') {
    if (buf.length < 8) return false;
    return buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0
        && buf[4] === 0xA1 && buf[5] === 0xB1 && buf[6] === 0x1A && buf[7] === 0xE1;
  }

  if (mime.startsWith('image/')) {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (mime === 'image/png') {
      return buf.length >= 8
          && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
          && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A;
    }
    // JPEG: FF D8 FF
    if (mime === 'image/jpeg' || mime === 'image/jpg') {
      return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    }
    // GIF: "GIF8"
    if (mime === 'image/gif') {
      return buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38;
    }
    // WebP: "RIFF" .. "WEBP" at offset 8
    if (mime === 'image/webp') {
      return buf.length >= 12
          && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
          && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
    }
    // BMP: "BM"
    if (mime === 'image/bmp') {
      return buf[0] === 0x42 && buf[1] === 0x4D;
    }
    // TIFF: "II*\0" little-endian or "MM\0*" big-endian
    if (mime === 'image/tiff') {
      return (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00)
          || (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A);
    }
    // Unknown image subtype — REJECT (F011 / 2026-05-03 audit). The earlier
    // accept-by-default tolerated image/svg+xml + arbitrary bytes. SVG is
    // now blocked at the MIME allowlist (DENIED_IMAGE_MIME) and any other
    // image subtype that doesn't carry a recognised magic-byte prefix is
    // also rejected here so the magic-byte sniffer can't be the weak link
    // in defense-in-depth. A genuine HEIC / AVIF can be added to the
    // allowlist when first requested by an operator.
    return false;
  }

  return false;
}

// L3 (2026-06-09 audit): defense-in-depth magic-byte enforcement, now
// actually wired into the upload handler. The fileFilter still accepts any
// declared MIME (every stored file is served forced-download + nosniff, so
// nothing renders inline in our origin regardless). This second gate runs
// ONLY for MIME types we can fingerprint — PDF / Word / images — and rejects
// a payload whose bytes contradict its declared Content-Type (the classic
// "upload a script tagged Content-Type: application/pdf" trick). Types we
// have no signature for (text/plain, text/csv, application/zip, …) are not
// blocked here; the forced-download serving is their protection.
const MAGIC_VERIFIED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
function magicBytesRejected(buf, mime) {
  if (!mime) return false;
  const m = String(mime).toLowerCase();
  const known = MAGIC_VERIFIED_MIME.has(m) || m.startsWith('image/');
  if (!known) return false;             // no signature to verify against → allow
  return !looksLikeDeclaredType(buf, m); // known type but bytes mismatch → reject
}

// Wrap multer's middleware to translate fileFilter / limit errors into
// well-typed JSON responses. Without this, multer surfaces them as 500s.
function uploadSingle(field) {
  const handler = upload.single(field);
  return (req, res, next) => {
    handler(req, res, (err) => {
      if (!err) return next();
      // multer signals size-limit breach via (err as any).code === 'LIMIT_FILE_SIZE'
      if ((err as any).code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, error: 'File exceeds 20 MB limit.' });
      }
      if (err.status === 415 || (err as any).code === 'UNSUPPORTED_MEDIA_TYPE') {
        return res.status(415).json({ success: false, error: err.message });
      }
      return res.status(400).json({ success: false, error: err.message || 'Upload failed.' });
    });
  };
}

// ── GET /api/documents/file?key=<storageKey> ──────────────────────────────────
// Streams the raw file bytes to the client. The key must belong to the
// requesting user's account — cross-account access returns 404.

router.get('/file', async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) return res.status(400).json({ success: false, error: 'Missing key parameter.' });

    // H5 (audit High, 2026-05-22): verify the document belongs to this
    // account AND, for asset-pinned documents, the asset isn't archived.
    // Without this, archived assets' documents kept leaking through to
    // viewers. NOTE: assetScopeRestricted site-scoping (User column) is
    // not yet enforceable here — the user↔site assignment rewire lands
    // with the routes adaptation; accountId scoping remains the hard
    // tenant boundary either way.
    const doc = await prisma.document.findFirst({
      where: {
        filePath: key,
        accountId: req.user.accountId,
        OR: [
          { assetId: null },  // non-asset documents (work-order reports, etc.)
          { asset: { archivedAt: null } },
        ],
      },
    });
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found.' });

    let buf = await downloadFile(key);

    // Decrypt if the document was stored encrypted
    if (doc.encrypted) {
      buf = decrypt(buf, doc.id);
    }

    // Audit Cluster A P2: RFC 6266 filename encoding. The previous
    // `filename="${encodeURIComponent(...)}"` form is not spec-compliant
    // — Safari sometimes corrupts non-ASCII names. The dual form below
    // gives a sanitized ASCII fallback for legacy clients and the
    // RFC 5987 percent-encoded `filename*` for modern browsers.
    const _safeAscii  = (doc.filename || 'document').replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    const _rfc5987    = encodeURIComponent(doc.filename || 'document');
    res.set('Content-Type',        doc.fileType || 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${_safeAscii}"; filename*=UTF-8''${_rfc5987}`);
    res.set('X-Content-Type-Options', 'nosniff'); // #11: never sniff; force download
    res.set('Content-Length',      buf.length);
    res.set('Cache-Control',       'private, no-store');

    // C1: audit document access — fire-and-forget, never blocks the response.
    // assetId may be null for non-asset uploads.
    writeActivityLog({
      assetId:  doc.assetId || null,
      userId:   req.user.id,
      action:   'document_accessed',
      details:  {
        documentId: doc.id,
        filename:   doc.filename,
        method:     'stream',
        encrypted:  doc.encrypted,
      },
    });

    // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- safe: explicit Content-Type from doc.fileType, MIME allowlist (PDF/Office/image; no HTML) enforced at upload, magic-byte verification prevents type smuggling. buf is a decrypted file buffer, not user-supplied HTML.
    return res.send(buf);

  } catch (err) {
    console.error('[documents/file]', err.message);
    if (err.message.includes('decryption failed') || err.message.includes('MASTER_KEY')) {
      return res.status(500).json({
        success: false,
        error:   'Document decryption failed. The server MASTER_KEY may have changed since this document was uploaded.',
      });
    }
    return res.status(500).json({ success: false, error: 'Failed to retrieve document.' });
  }
});

// ── GET /api/documents/:documentId/url ───────────────────────────────────────
// Returns the appropriate access URL for a document.
// For local storage: returns an API path the client can call.
// For S3 storage: returns a pre-signed URL (1 hour).

router.get('/:documentId/url', async (req, res) => {
  try {
    // H5 (audit High, 2026-05-22): same archived-asset filter as /file
    // above. The /url path returns either an API path (local storage) or
    // a presigned S3 URL -- either way, leaking access to archived assets'
    // documents is the same bug as /file.
    const doc = await prisma.document.findFirst({
      where: {
        id: req.params.documentId,
        accountId: req.user.accountId,
        OR: [
          { assetId: null },
          { asset: { archivedAt: null } },
        ],
      },
    });
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found.' });

    const result = await getFileUrl(doc.filePath, doc.filename);

    // C1: audit document URL fetch (S3 pre-signed URL or local API path).
    // For S3 deployments this is the actionable signal — the bytes flow direct
    // from S3 so the /file route never sees them.
    writeActivityLog({
      assetId:  doc.assetId || null,
      userId:   req.user.id,
      action:   'document_accessed',
      details:  {
        documentId: doc.id,
        filename:   doc.filename,
        method:     'url',
        encrypted:  doc.encrypted,
      },
    });

    return res.json({
      success: true,
      data: {
        ...result,
        filename:  doc.filename,
        fileType:  doc.fileType,
        encrypted: doc.encrypted,
      },
    });
  } catch (err) {
    console.error('[documents/url]', err.message);
    return res.status(500).json({ success: false, error: 'Failed to get document URL.' });
  }
});

// ── GET /api/documents/asset/:assetId ───────────────────────────────────────
// Returns all documents attached to a given asset, grouped by docType.
// Includes external-URL-only docs (filePath = '__external__').
router.get('/asset/:assetId', async (req, res) => {
  try {
    const { assetId } = req.params;
    const accountId   = req.user.accountId;

    // Verify asset ownership
    const asset = await prisma.asset.findFirst({
      where:  { id: assetId, accountId, archivedAt: null },
      select: { id: true, siteId: true },
    });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    const docs = await prisma.document.findMany({
      where:   { accountId, OR: [{ assetId }, ...(asset.siteId ? [{ siteId: asset.siteId }] : [])] },
      include: { uploader: { select: { id: true, name: true } } },
      orderBy: [{ docType: 'asc' }, { uploadedAt: 'desc' }],
    });

    return res.json({ success: true, data: docs });
  } catch (err) {
    console.error('[documents GET /asset/:assetId]', err);
    return res.status(500).json({ success: false, error: 'Failed to list documents' });
  }
});

// ── GET /api/documents ───────────────────────────────────────────────────────
// Account-wide document library: searchable / filterable list across all assets.
// Filters: ?q= (filename, case-insensitive contains), ?docType=, ?siteId=,
// ?assetId=. Joins asset -> site so the library can show and filter by site.
// Account-scoped; archived assets' docs excluded (same H5 rule as the serve
// routes). Capped at 300 rows (newest first); pagination is the documented next
// step if a tenant's library grows past that.
router.get('/', async (req, res) => {
  try {
    const accountId = req.user.accountId;
    const { q, docType, siteId, assetId } = req.query;

    if (docType && !isValidDocType(docType)) {
      return res.status(400).json({ success: false, error: 'Invalid docType filter' });
    }

    const where: any = { accountId };
    // assetId takes precedence over siteId so passing both isn't an ambiguous OR.
    if (assetId) {
      where.assetId = assetId;
    } else if (siteId) {
      where.OR = [{ asset: { siteId, archivedAt: null } }, { siteId }];
    } else {
      where.OR = [{ assetId: null }, { asset: { archivedAt: null } }];
    }
    if (docType) where.docType = docType;
    if (q && String(q).trim()) where.filename = { contains: String(q).trim(), mode: 'insensitive' };

    const docs = await prisma.document.findMany({
      where,
      select: {
        id: true, filename: true, docType: true, provenance: true, fileType: true, filePath: true,
        externalUrl: true, uploadedAt: true, siteId: true,
        site: { select: { id: true, name: true } },
        uploader: { select: { name: true } },
        asset: {
          select: {
            id: true, equipmentType: true, manufacturer: true, model: true, serialNumber: true,
            site: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: [{ uploadedAt: 'desc' }],
      take: 300,
    });

    const data = docs.map((d) => ({
      id: d.id,
      filename: d.filename,
      docType: d.docType,
      fileType: d.fileType,
      uploadedAt: d.uploadedAt,
      uploaderName: d.uploader?.name || null,
      provenance: d.provenance,
      external: d.filePath === '__external__',
      externalUrl: d.filePath === '__external__' ? d.externalUrl : null,
      site: d.asset?.site || d.site || null,
      asset: d.asset
        ? {
            id: d.asset.id,
            name: [d.asset.manufacturer, d.asset.model].filter(Boolean).join(' ') || d.asset.serialNumber || d.asset.equipmentType,
            equipmentType: d.asset.equipmentType,
            site: d.asset.site || null,
          }
        : null,
    }));
    return res.json({ success: true, data });
  } catch (err) {
    console.error('[documents GET /]', err);
    return res.status(500).json({ success: false, error: 'Failed to list documents' });
  }
});

// ── POST /api/documents/link ──────────────────────────────────────────────────
// Create a document record that is a URL link only (no upload).
// Body: { assetId?, workOrderId?, url, filename, docType? }
router.post('/link', requireManager, async (req, res) => {
  try {
    const { accountId, id: userId } = req.user;
    const { url, filename, docType, assetId, workOrderId, notes } = req.body;

    if (!isValidDocType(docType)) return res.status(400).json({ success: false, error: 'Invalid docType' });
    if (!url?.trim())      return res.status(400).json({ success: false, error: 'url required' });
    if (!filename?.trim()) return res.status(400).json({ success: false, error: 'filename required' });

    // Basic URL sanity check — must be http(s)
    try { const u = new URL(url); if (!['http:', 'https:'].includes(u.protocol)) throw new Error(); }
    catch { return res.status(400).json({ success: false, error: 'url must be a valid http(s) URL' }); }

    if (assetId) {
      const owns = await prisma.asset.findFirst({ where: { id: assetId, accountId }, select: { id: true } });
      if (!owns) return res.status(404).json({ success: false, error: 'Asset not found' });
    }

    // #10 parity (2026-07-03 acquisition scan, Scan 3): verify a supplied
    // workOrderId belongs to this account before pinning the link to it --
    // same check as POST /upload below. Previously the client-supplied id was
    // written unverified (cross-tenant FK write).
    if (workOrderId) {
      const wo = await prisma.workOrder.findFirst({
        where:  { id: workOrderId, accountId },
        select: { id: true },
      });
      if (!wo) return res.status(404).json({ success: false, error: 'Work order not found.' });
    }

    const doc = await prisma.document.create({
      data: {
        accountId,
        assetId:     assetId     || null,
        workOrderId: workOrderId || null,
        uploadedBy:  userId,
        filename:    filename.trim(),
        fileType:    'text/uri-list',
        filePath:    '__external__',
        encrypted:   false,
        externalUrl: url.trim(),
        docType:     docType || null,
        provenance:  validProvenance(req.body.provenance),
      },
    });

    return res.status(201).json({ success: true, data: { id: doc.id, filename: doc.filename } });
  } catch (err) {
    console.error('[documents POST /link]', err);
    return res.status(500).json({ success: false, error: 'Failed to save link' });
  }
});

// ── PATCH /api/documents/:documentId ─────────────────────────────────────────
// Update docType or filename (renaming) of an existing document.
router.patch('/:documentId', requireManager, async (req, res) => {
  try {
    const { docType, filename } = req.body;
    const provenance = validProvenance(req.body.provenance);
    if (docType !== undefined && !isValidDocType(docType)) {
      return res.status(400).json({ success: false, error: 'Invalid docType' });
    }
    const doc = await prisma.document.findFirst({
      where:  { id: req.params.documentId, accountId: req.user.accountId },
      select: { id: true, provenance: true },
    });
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });

    const updated = await prisma.document.update({
      where: { id: req.params.documentId },
      data:  {
        ...(docType    !== undefined && { docType  }),
        ...(filename   !== undefined && { filename }),
        ...(provenance !== undefined && { provenance }),
      },
    });

    // Log EVERY provenance transition (not just the upgrade to sealed) so each
    // trust-status change is attributable in the tamper-evident audit chain. The
    // dedicated 'document_provenance_attested' action is kept for pe_sealed (the
    // high-liability claim) so existing queries/tests for it still match.
    if (provenance !== undefined && provenance !== doc.provenance) {
      writeActivityLog({
        userId: req.user.id, accountId: req.user.accountId, assetId: updated.assetId || null,
        action: provenance === 'pe_sealed' ? 'document_provenance_attested' : 'document_provenance_changed',
        details: { documentId: updated.id, filename: updated.filename, from: doc.provenance, to: provenance },
      });
    }
    return res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[documents PATCH /:id]', err);
    return res.status(500).json({ success: false, error: 'Failed to update document' });
  }
});

// ── DELETE /api/documents/:documentId ────────────────────────────────────────
router.delete('/:documentId', requireManager, async (req, res) => {
  try {
    const doc = await prisma.document.findFirst({
      where:  { id: req.params.documentId, accountId: req.user.accountId },
      select: { id: true, filePath: true, filename: true, docType: true, assetId: true, workOrderId: true },
    });
    if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });

    await prisma.document.delete({ where: { id: req.params.documentId } });

    // Forensics: a document can be compliance evidence (test-report scan, EMP,
    // snapshot PDF). Deleting one must leave a trail in the tamper-evident audit
    // chain so evidence can't vanish without a record. Fire-and-forget.
    writeActivityLog({
      userId: req.user.id, accountId: req.user.accountId, assetId: doc.assetId || null,
      action: 'document_deleted',
      details: { documentId: doc.id, filename: doc.filename || null, docType: doc.docType || null, workOrderId: doc.workOrderId || null },
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[documents DELETE /:id]', err);
    return res.status(500).json({ success: false, error: 'Failed to delete document' });
  }
});

// ── POST /api/documents/upload (S7) ──────────────────────────────────────────
// Generic document upload endpoint. Validation:
//   - allowed types: PDF, Word (.doc/.docx), any image/* (enforced in
//     fileFilter; rejected with 415 before storage)
//   - 20 MB cap (multer limits; rejected with 413)
//
// Body (multipart/form-data):
//   file:         the binary upload (required)
//   assetId:      optional UUID — if present, file is scoped to that asset
//   workOrderId:  optional UUID — if present, file is pinned to that work order
//
// On success creates a Document row and returns its id + storage key. The
// caller is responsible for any post-processing (e.g. text extraction).

router.post('/upload', requireManager, uploadSingle('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file provided.' });
    }
    // BRT-EDGE-001 (Round-5): reject 0-byte uploads.
    if (req.file.size === 0) {
      return res.status(400).json({ success: false, error: 'File is empty.' });
    }

    // #11 + L3: storage uploads accept any declared type (the forced-download
    // serving — attachment + nosniff in GET /file and the presigned URL — is
    // what keeps an arbitrary upload from ever executing/rendering in our
    // origin). As defense-in-depth we additionally reject a payload whose
    // bytes contradict its declared Content-Type for the types we can
    // fingerprint (PDF / Word / images); signature-less types pass through.
    if (magicBytesRejected(req.file.buffer, req.file.mimetype)) {
      return res.status(415).json({
        success: false,
        error: 'File contents do not match the declared file type.',
      });
    }

    const { accountId, id: userId } = req.user;
    let { assetId } = req.body || {};
    const { workOrderId, docType } = req.body || {};
    if (!isValidDocType(docType)) return res.status(400).json({ success: false, error: 'Invalid docType' });

    // If an assetId was given, verify it belongs to this account before
    // letting the upload pin to it (defence-in-depth — Document.accountId is
    // the source of truth, but a stale assetId pollutes navigation).
    if (assetId) {
      const owns = await prisma.asset.findFirst({
        where:  { id: assetId, accountId },
        select: { id: true },
      });
      if (!owns) {
        return res.status(404).json({ success: false, error: 'Asset not found.' });
      }
    }

    // #10: if a workOrderId is supplied, verify the work order belongs to
    // this account, then pin the document to it (and to its parent asset so
    // it still surfaces in the asset Documents panel tagged by work order).
    if (workOrderId) {
      const wo = await prisma.workOrder.findFirst({
        where:  { id: workOrderId, accountId },
        select: { id: true, assetId: true },
      });
      if (!wo) {
        return res.status(404).json({ success: false, error: 'Work order not found.' });
      }
      if (!assetId) assetId = wo.assetId;
    }

    // Optional at-rest encryption gate (mirrors ingest.js behaviour)
    const encryptDocs = process.env.ENCRYPT_DOCS === 'true';
    let bytes = req.file.buffer;
    let encrypted = false;
    let docId = null;

    // Pre-allocate the Document row so encrypt() can use its id as the HKDF
    // salt (per lib/docCrypto.js — key is derived from MASTER_KEY + docId).
    // filePath is filled in after the storage write succeeds; if storage fails
    // we leave a zero-byte placeholder row that the cleanup cron prunes.
    const docRow = await prisma.document.create({
      data: {
        accountId,
        assetId:     assetId || null,
        workOrderId: workOrderId || null,
        uploadedBy:  userId,                      // schema field is `uploadedBy`, not `uploadedById`
        filename:    req.file.originalname,
        fileType:    req.file.mimetype,
        filePath:    '__pending__',               // non-empty placeholder; updated after storage write
        encrypted:   false,
        docType:     docType || null,
        provenance:  validProvenance(req.body.provenance),
      },
      select: { id: true },
    });
    docId = docRow.id;

    if (encryptDocs) {
      bytes = encrypt(bytes, docId);
      encrypted = true;
    }

    const { storageKey } = await uploadFile(
      accountId, assetId || null, req.file.originalname, bytes, req.file.mimetype
    );

    await prisma.document.update({
      where: { id: docId },
      data:  { filePath: storageKey, encrypted },
    });

    return res.status(201).json({
      success: true,
      data: { id: docId, filename: req.file.originalname, sizeBytes: req.file.size, encrypted },
    });
  } catch (err) {
    console.error('[documents/upload]', err);
    return res.status(500).json({ success: false, error: 'Upload failed.' });
  }
});

module.exports = router;

export {};
