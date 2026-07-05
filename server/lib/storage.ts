'use strict';

/**
 * lib/storage.js
 * --------------
 * Storage abstraction for asset documents (test reports, nameplate photos,
 * PDFs, Word files, images).
 * Replaces the previous Supabase-only implementation with a local-first,
 * self-hosted design.
 *
 * Destination controlled by STORAGE_DEST (default: 'local'):
 *
 *   local  — writes files to STORAGE_LOCAL_PATH on the host filesystem.
 *             Works out of the box with zero config. In Docker, mount the
 *             path as a host volume so files survive container restarts:
 *               ./uploads:/app/uploads   (in docker-compose.yml)
 *
 *   s3     — uploads to an S3-compatible bucket. Works with AWS S3,
 *             Backblaze B2, Wasabi, Cloudflare R2, or a self-hosted MinIO
 *             instance on the same network.
 *
 * When document encryption is enabled (opt-in via Settings), buffers are
 * encrypted with AES-256-GCM before being written. The storage layer is
 * encryption-agnostic — it stores whatever bytes it is given.
 *
 * Env vars:
 *   STORAGE_DEST            'local' (default) | 's3'
 *   STORAGE_LOCAL_PATH      path on host (default: ./uploads)
 *   STORAGE_S3_BUCKET       bucket name (S3 only)
 *   STORAGE_S3_REGION       e.g. us-east-1 (S3 only)
 *   STORAGE_S3_KEY_ID       access key ID (S3 only)
 *   STORAGE_S3_SECRET       secret access key (S3 only)
 *   STORAGE_S3_ENDPOINT     optional; set for non-AWS providers
 */

const path = require('path');
const fsp  = require('fs/promises');

// ── Config ────────────────────────────────────────────────────────────────────

function getDest()      { return (process.env.STORAGE_DEST || 'local').toLowerCase(); }
function getLocalPath() { return path.resolve(process.env.STORAGE_LOCAL_PATH || path.join(__dirname, '..', 'uploads')); }

// INFOSEC-8-15: default S3 pre-signed URL lifetime. A signed URL is a bearer
// capability — anyone who obtains it can fetch the object until it expires, and
// it bypasses our /file auth route entirely. The previous fixed 1-hour window
// was longer than a document view needs. Default to 15 minutes (enough for a
// click-through download) and let operators tune via STORAGE_S3_URL_TTL_SECONDS.
// Callers can also pass a shorter ttl per request (e.g. inline preview). Clamped
// to [60s, 3600s] so a typo can't mint a multi-day capability.
const PRESIGN_TTL_MIN = 60;
const PRESIGN_TTL_MAX = 3600;
const PRESIGN_TTL_DEFAULT = 900; // 15 min
function getPresignTtl(override) {
  const raw = override != null
    ? override
    : parseInt(process.env.STORAGE_S3_URL_TTL_SECONDS || String(PRESIGN_TTL_DEFAULT), 10);
  const n = Number(raw);
  if (!Number.isFinite(n)) return PRESIGN_TTL_DEFAULT;
  return Math.min(PRESIGN_TTL_MAX, Math.max(PRESIGN_TTL_MIN, Math.floor(n)));
}

// L4 (2026-06-09 audit): belt-and-suspenders path-traversal guard. The
// documents file-serving route already gates `key` via a DB lookup scoped
// to accountId before reaching here, and buildStorageKey() sanitizes the
// filename segment at write time — but resolving + asserting containment
// means no future caller can reach the filesystem with a `../`-laden key
// even if it bypasses the route-level DB gate. Throws on any key that
// escapes the storage root.
function resolveLocalPath(storageKey) {
  const root = getLocalPath();
  const abs  = path.resolve(root, storageKey);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('storage key resolves outside the storage root — refusing path traversal');
  }
  return abs;
}

function s3Configured() {
  return !!(
    process.env.STORAGE_S3_BUCKET &&
    process.env.STORAGE_S3_KEY_ID &&
    process.env.STORAGE_S3_SECRET
  );
}

function isConfigured() {
  const dest = getDest();
  if (dest === 'local') return true;
  if (dest === 's3')    return s3Configured();
  return false;
}

function getConfig() {
  const dest = getDest();
  return {
    dest,
    localPath:    dest === 'local' ? getLocalPath() : null,
    s3Configured: s3Configured(),
    s3Bucket:     process.env.STORAGE_S3_BUCKET || null,
    s3Endpoint:   process.env.STORAGE_S3_ENDPOINT || null,
  };
}

// ── Storage key ───────────────────────────────────────────────────────────────
// Format: '{accountId}/{assetId|misc}/{timestamp}_{sanitizedFilename}'
// This is the canonical identifier stored in Document.filePath.

function buildStorageKey(accountId, filename, assetId = null) {
  const ts     = Date.now();
  const safe   = filename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const folder = assetId ? `${accountId}/${assetId}` : `${accountId}/misc`;
  return `${folder}/${ts}_${safe}`;
}

// ── S3 client (lazy singleton) ────────────────────────────────────────────────

let _s3 = null;
function getS3Client() {
  if (_s3) return _s3;
  const { S3Client } = require('@aws-sdk/client-s3');
  const cfg: any = {
    region:      process.env.STORAGE_S3_REGION || 'us-east-1',
    credentials: {
      accessKeyId:     process.env.STORAGE_S3_KEY_ID,
      secretAccessKey: process.env.STORAGE_S3_SECRET,
    },
  };
  if (process.env.STORAGE_S3_ENDPOINT) {
    cfg.endpoint       = process.env.STORAGE_S3_ENDPOINT;
    cfg.forcePathStyle = true;  // required for MinIO, Backblaze, etc.
  }
  _s3 = new S3Client(cfg);
  return _s3;
}

// ── Upload ────────────────────────────────────────────────────────────────────

/**
 * Upload a file buffer to the configured storage destination.
 *
 * @param {string}  accountId   — account that owns the file
 * @param {string|null} assetId — optional; used to scope storage path
 * @param {string}  filename    — original filename (used in storage key)
 * @param {Buffer}  buffer      — file bytes (already encrypted if opt-in enabled)
 * @param {string}  mimeType    — MIME type
 * @returns {{ storageKey: string, sizeBytes: number }}
 */
async function uploadFile(accountId, assetId, filename, buffer, mimeType) {
  const key  = buildStorageKey(accountId, filename, assetId);
  const dest = getDest();

  if (dest === 's3') {
    if (!s3Configured()) throw new Error('STORAGE_DEST is set to "s3" but S3 credentials are not configured.');
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await getS3Client().send(new PutObjectCommand({
      Bucket:      process.env.STORAGE_S3_BUCKET,
      Key:         key,
      Body:        buffer,
      ContentType: mimeType === 'text/plain' ? 'application/octet-stream' : (mimeType || 'application/octet-stream'),
    }));
  } else {
    // local filesystem
    const filePath = resolveLocalPath(key);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, buffer);
  }

  return { storageKey: key, sizeBytes: buffer.length };
}

/**
 * Upload a file buffer to an EXPLICIT storage key, instead of one generated
 * by `buildStorageKey()`. Added 2026-07-05 for the EDMS backfill script
 * (server/scripts/backfillDrawingRevisions.ts), which needs the documented
 * `{accountId}/drawings/{documentId}/rev-{N}.pdf` keying scheme rather than
 * the generic `{accountId}/{assetId|misc}/{timestamp}_{filename}` shape
 * `uploadFile()` always produces. Same s3/local branches as `uploadFile()`,
 * just parameterized on the key. `resolveLocalPath()` still guards against
 * path traversal on the local branch regardless of what key is passed in.
 *
 * @param {string} key      — full storage key, e.g. "acct1/drawings/doc1/rev-1.pdf"
 * @param {Buffer} buffer   — file bytes
 * @param {string} mimeType — MIME type
 * @returns {{ storageKey: string, sizeBytes: number }}
 */
async function putAtKey(key, buffer, mimeType) {
  if (!key || typeof key !== 'string') throw new Error('putAtKey: key is required');
  const dest = getDest();

  if (dest === 's3') {
    if (!s3Configured()) throw new Error('STORAGE_DEST is set to "s3" but S3 credentials are not configured.');
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await getS3Client().send(new PutObjectCommand({
      Bucket:      process.env.STORAGE_S3_BUCKET,
      Key:         key,
      Body:        buffer,
      ContentType: mimeType === 'text/plain' ? 'application/octet-stream' : (mimeType || 'application/octet-stream'),
    }));
  } else {
    // local filesystem — resolveLocalPath() throws on path-traversal attempts
    const filePath = resolveLocalPath(key);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, buffer);
  }

  return { storageKey: key, sizeBytes: buffer.length };
}

// ── Download ──────────────────────────────────────────────────────────────────

/**
 * Download a file as a Buffer.
 * The caller is responsible for decrypting if the document is encrypted.
 *
 * @param {string} storageKey
 * @returns {Buffer}
 */
async function downloadFile(storageKey) {
  const dest = getDest();

  if (dest === 's3') {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const res = await getS3Client().send(new GetObjectCommand({
      Bucket: process.env.STORAGE_S3_BUCKET,
      Key:    storageKey,
    }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  } else {
    return fsp.readFile(resolveLocalPath(storageKey));
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

/**
 * Delete a stored file. Fails silently if the file no longer exists.
 *
 * @param {string} storageKey
 */
async function deleteFile(storageKey) {
  const dest = getDest();

  if (dest === 's3') {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    try {
      await getS3Client().send(new DeleteObjectCommand({
        Bucket: process.env.STORAGE_S3_BUCKET,
        Key:    storageKey,
      }));
    } catch { /* ignore */ }
  } else {
    try {
      await fsp.unlink(resolveLocalPath(storageKey));
    } catch { /* already gone */ }
  }
}

// ── URL / access ──────────────────────────────────────────────────────────────

/**
 * Get a URL to access the stored file.
 *
 * Local: returns an authenticated API path (/api/documents/file?key=...).
 *        The documents route handles auth and streaming.
 *
 * S3:    returns a short-lived pre-signed URL. INFOSEC-8-15: default 15 min
 *        (was a fixed 1 hour), tunable via STORAGE_S3_URL_TTL_SECONDS or a
 *        per-call `ttlSeconds` override, clamped to [60s, 3600s].
 *
 * @param {string} storageKey
 * @param {string|null} filename
 * @param {number|null} [ttlSeconds]  optional per-call expiry override (seconds)
 * @returns {{ url: string, type: 'local'|'presigned', expiresIn?: number }}
 */
async function getFileUrl(storageKey, filename = null, ttlSeconds = null) {
  const dest = getDest();

  if (dest === 's3') {
    const { GetObjectCommand }  = require('@aws-sdk/client-s3');
    const { getSignedUrl }      = require('@aws-sdk/s3-request-presigner');
    // #11: force download on the presigned URL too. The bytes flow direct from
    // the bucket (this URL bypasses our /file route), so the attachment
    // disposition + octet-stream type must be signed into the request itself.
    const safeName = (filename || 'download').replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    const expiresIn = getPresignTtl(ttlSeconds);
    const url = await getSignedUrl(
      getS3Client(),
      new GetObjectCommand({
        Bucket: process.env.STORAGE_S3_BUCKET,
        Key: storageKey,
        ResponseContentDisposition: `attachment; filename="${safeName}"`,
        ResponseContentType: 'application/octet-stream',
      }),
      { expiresIn }
    );
    return { url, type: 'presigned', expiresIn };
  } else {
    return {
      url:  `/api/documents/file?key=${encodeURIComponent(storageKey)}`,
      type: 'local',
    };
  }
}

module.exports = {
  uploadFile,
  putAtKey,
  downloadFile,
  deleteFile,
  getFileUrl,
  isConfigured,
  getConfig,
  buildStorageKey,
};

export {};
