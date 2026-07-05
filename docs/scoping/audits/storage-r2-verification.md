# Storage layer verification — EDMS scope doc claim audit

**Date:** 2026-07-05
**Scope:** Verify the factual claim in `docs/scoping/EDMS_MODULE_SCOPE_2026-07-04.md` about `server/lib/storage.ts` (S3-compatible endpoint support + presigned URL TTL/clamp behavior).
**Method:** Direct read of the actual source file, not the scope doc's prose. No source files were modified.

---

## What was checked

- `C:\Users\ddeni\Desktop\ServiceCycle\server\lib\storage.ts` — read in full (281 lines). This is the **only** storage abstraction file in the repo.
  - Confirmed via `Glob` on `server/lib/storage*` and `**/lib/**` under `server/` that there is **no `server/lib/storage/` directory** and no other file storage.ts imports from. It is fully self-contained (uses only `path`, `fs/promises`, and lazily-required `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner`).
- `C:\Users\ddeni\Desktop\ServiceCycle\server\lib\awsSigV4.ts` — read in full (117 lines) as a sanity check. This is a **separate, generic AWS SigV4 request signer** (zero-dependency, uses only Node `crypto`) used for signing arbitrary AWS API calls (e.g. STS, Cost Explorer). It is **not imported by storage.ts** and is unrelated to file/object storage — noted only to rule it out as a second "storage" implementation.
- `C:\Users\ddeni\Desktop\ServiceCycle\docs\scoping\EDMS_MODULE_SCOPE_2026-07-04.md` — grepped for the specific claims (lines 43, 277-283, 424-444, 580-582, 677) to confirm exactly what was asserted about storage.ts before comparing against code.

## What was found

### 1. S3-compatible endpoint / STORAGE_DEST switch — CONFIRMED

Header comment, `storage.ts` lines 11-33:
```
 * Destination controlled by STORAGE_DEST (default: 'local'):
 *
 *   local  — writes files to STORAGE_LOCAL_PATH on the host filesystem.
 *   s3     — uploads to an S3-compatible bucket. Works with AWS S3,
 *             Backblaze B2, Wasabi, Cloudflare R2, or a self-hosted MinIO
 *             instance on the same network.
 *
 * Env vars:
 *   STORAGE_DEST            'local' (default) | 's3'
 *   STORAGE_LOCAL_PATH      path on host (default: ./uploads)
 *   STORAGE_S3_BUCKET       bucket name (S3 only)
 *   STORAGE_S3_REGION       e.g. us-east-1 (S3 only)
 *   STORAGE_S3_KEY_ID       access key ID (S3 only)
 *   STORAGE_S3_SECRET       secret access key (S3 only)
 *   STORAGE_S3_ENDPOINT     optional; set for non-AWS providers
```

Implementation, lines 41 and 118-135:
```js
function getDest()      { return (process.env.STORAGE_DEST || 'local').toLowerCase(); }
...
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
```

This is a real, working configurable-endpoint pattern: setting `STORAGE_S3_ENDPOINT` overrides the AWS SDK's default endpoint resolution and forces path-style addressing (`forcePathStyle: true`), which is exactly what R2/B2/Wasabi/MinIO require since they don't support virtual-hosted–style bucket URLs the way AWS does by default. `STORAGE_DEST=s3` is a literal, functioning switch (`getDest()` gates every operation — upload, download, delete, getFileUrl — via `dest === 's3'` branches vs. the local-disk `else` branch).

**Env vars controlling each dimension** (all confirmed in code, not just the comment):
| Purpose | Env var | Used at |
|---|---|---|
| Mode switch | `STORAGE_DEST` | line 41, gates every function |
| Local path | `STORAGE_LOCAL_PATH` | line 42 |
| Endpoint URL | `STORAGE_S3_ENDPOINT` | lines 101, 129-132 |
| Region | `STORAGE_S3_REGION` | line 123 (defaults `us-east-1` if unset) |
| Bucket | `STORAGE_S3_BUCKET` | lines 81, 100, 157, 187, 212, 254 |
| Access key | `STORAGE_S3_KEY_ID` | lines 82, 125 |
| Secret key | `STORAGE_S3_SECRET` | lines 83, 126 |
| Presign TTL override | `STORAGE_S3_URL_TTL_SECONDS` | line 57 |

`s3Configured()` (lines 79-85) requires bucket + key ID + secret to be present; `isConfigured()` (lines 87-92) returns true for `local` unconditionally, or defers to `s3Configured()` for `s3`. `uploadFile()` throws explicitly (line 154) if `STORAGE_DEST=s3` but credentials aren't set — no silent fallback to local.

### 2. Presigned URL TTL default + clamp bounds — CONFIRMED, exact values match

Lines 44-61:
```js
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
```

- Default: **900 seconds = 15 minutes** — exact match to the scope doc's claim.
- Min clamp: **60 seconds** — exact match.
- Max clamp: **3600 seconds (1 hour)** — exact match.
- Clamp is enforced unconditionally via `Math.min(MAX, Math.max(MIN, ...))` regardless of whether the value came from `STORAGE_S3_URL_TTL_SECONDS` or a per-call override — a misconfigured env var cannot escape the bounds.
- Non-finite/garbage input (`NaN`, non-numeric string) falls back to the 900s default rather than erroring, per line 59.

Actual presign call site, lines 240-261 (`getFileUrl`):
```js
async function getFileUrl(storageKey, filename = null, ttlSeconds = null) {
  const dest = getDest();

  if (dest === 's3') {
    const { GetObjectCommand }  = require('@aws-sdk/client-s3');
    const { getSignedUrl }      = require('@aws-sdk/s3-request-presigner');
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
```

Uses the standard `@aws-sdk/s3-request-presigner` `getSignedUrl()` — this is the AWS SDK v3 idiom, and it works against any S3-compatible endpoint including a custom one set via `cfg.endpoint`, since `getS3Client()` is the same client instance used for all operations.

### 3. Cross-check against the scope doc's own citations

The EDMS scope doc (`docs/scoping/EDMS_MODULE_SCOPE_2026-07-04.md`) states, consistent with the above:
- Line 277: *"Provider: Cloudflare R2 via existing `lib/storage.ts` with `STORAGE_DEST=s3` + R2 endpoint URL."*
- Line 280: *"Signed URLs: existing 15-min default, per-fetch DB-mediated + audit-logged."*
- Line 444: *"Signed URLs are per-fetch, TTL-bounded (15 min default), never exposed as a list operation."*

Both citations match the code exactly — no discrepancy between what the scope doc asserts and what storage.ts actually does.

### 4. Other storage-adapter details relevant to an EDMS build (large CAD/drawing files)

- **No multipart upload support.** `uploadFile()` (lines 149-170) does a single `PutObjectCommand` with the entire buffer in memory (`Body: buffer`). There is no `@aws-sdk/lib-storage` `Upload` helper, no `CreateMultipartUploadCommand`/`UploadPartCommand` usage, and no streaming upload path. Every file — including large CAD/DWG drawings — is loaded fully into a Node `Buffer` before being handed to the S3 client. **This is a real gap for an EDMS module** that will handle multi-hundred-MB drawing files: (a) memory pressure on the droplet under concurrent large uploads, (b) no resumability if a large upload fails partway, (c) R2/S3 single-PUT has a hard 5GB object limit (unlikely to bite for drawings, but multipart is still the standard pattern above ~100MB for reliability, not just size).
- **No checksum/hash computation inside storage.ts.** The module does not compute SHA-256 or any other digest — `uploadFile()` just measures `buffer.length` for `sizeBytes`. The EDMS scope doc's own migration plan (lines 464-467) accounts for this correctly: it plans to compute SHA-256 **at the call site** ("Read the current bytes... Compute SHA-256... Copy to R2... VERIFY SHA-256 matches after upload") rather than assuming storage.ts does it. That is accurate — storage.ts provides no built-in integrity verification, so the EDMS layer must own checksums itself (as the doc already plans).
- **Content-type handling is minimal and slightly quirky.** Line 160: `ContentType: mimeType === 'text/plain' ? 'application/octet-stream' : (mimeType || 'application/octet-stream')` — deliberately downgrades `text/plain` to `application/octet-stream` (likely to prevent inline text rendering / XSS-adjacent behavior in browsers) and defaults missing MIME types to `application/octet-stream`. For CAD formats (DWG/DXF have no universally-registered MIME type), callers will need to pass an explicit `mimeType` or accept the `application/octet-stream` default — fine for downloads, but something the EDMS module's converter/upload path should set deliberately rather than relying on browser-sniffed MIME.
- **Presigned URLs are download-only (GetObjectCommand), not upload.** `getFileUrl()` only wraps `GetObjectCommand`. There is no presigned-PUT / presigned-POST path for direct-to-R2 browser uploads — all uploads currently proxy through the Node server (`uploadFile()`), which reinforces the multipart/memory-buffering concern above for large drawing files. An EDMS module wanting direct-to-R2 browser uploads (to avoid routing multi-hundred-MB files through the app server) would need to add this; it does not exist today.
- **Path-traversal guard is local-disk only.** `resolveLocalPath()` (lines 70-77) defends against `../`-laden keys for the local filesystem backend. The S3 backend has no equivalent key-sanitization check in storage.ts itself — it relies on `buildStorageKey()` (lines 109-114) producing safe keys at write time and on upstream route-level DB scoping. Not a bug, but worth noting since the EDMS doc introduces a new keying scheme (`{accountId}/drawings/{documentId}/rev-{N}.pdf`) that bypasses `buildStorageKey()` entirely (per doc line 279) — any new key-construction code path for EDMS must independently avoid path-unsafe characters if it's ever used against the local backend.
- **No retry/backoff logic.** Upload/download/delete calls the AWS SDK client directly with no wrapping retry policy beyond whatever the SDK's own default retry behavior provides. Large-file transient failures (common with big CAD uploads over flaky connections) will surface as raw exceptions to the caller.
- **`forcePathStyle: true` is unconditional whenever `STORAGE_S3_ENDPOINT` is set** (line 131) — correct for R2/MinIO/B2, but means this code path has never been exercised against a custom-endpoint AWS S3 setup (e.g. an AWS PrivateLink VPC endpoint) where path-style might not be desired. Not a defect for the R2 use case the EDMS doc actually wants, just a note that "S3-compatible" here specifically means "third-party/self-hosted," not "any AWS endpoint variant."

## Verdict

**The EDMS scope doc's claim about `server/lib/storage.ts` HOLDS — fully verified, no discrepancy found.**

Specifically:
1. ✅ **S3-compatible endpoint support beyond AWS is real and functioning.** `STORAGE_S3_ENDPOINT` + `forcePathStyle: true` is a correct, working pattern for Cloudflare R2, Backblaze B2, Wasabi, and self-hosted MinIO — not just aspirational comments. The doc-comment at the top of the file explicitly names all four providers, and the code backs it up.
2. ✅ **`STORAGE_DEST=s3` is a literal, functioning env-var switch** between local-disk and S3-compatible modes, gating all four operations (upload/download/delete/getFileUrl).
3. ✅ **Presigned URL default TTL is exactly 900 seconds (15 minutes)**, exactly as claimed.
4. ✅ **Clamp bounds are exactly [60, 3600] seconds**, exactly as claimed, enforced via `Math.min(MAX, Math.max(MIN, n))` on both the env-var path and any per-call override.

No part of the EDMS scope doc's factual claim about this file is exaggerated or inaccurate. The doc's own downstream citations (lines 277, 280, 444) are consistent with the code.

The **only caveat** is scope, not accuracy: the claim as posed only concerns endpoint-configurability and presign TTL, both of which check out. It does not claim multipart upload, checksum computation, or presigned-upload support — and indeed storage.ts has none of those (see Risk callouts below). The scope doc appears aware of this: its own migration plan computes SHA-256 at the call site rather than assuming storage.ts provides it, which is the correct design given what's actually in the file.

## Risk callouts

For an EDMS module handling large CAD/drawing files, the following gaps in the current storage.ts should be addressed or explicitly designed around before Phase 1 lands:

1. **No multipart upload / streaming.** Every upload buffers the entire file in Node memory before a single `PutObjectCommand`. Large drawing files (DWG originals, high-res scanned PDFs) will add memory pressure on the droplet and have no partial-failure resumability. Recommend adding `@aws-sdk/lib-storage`'s `Upload` helper (handles multipart automatically) for any file above a size threshold, rather than assuming the existing `uploadFile()` scales as-is.
2. **No presigned-PUT/POST for direct browser-to-R2 uploads.** All uploads proxy through the app server today. If the EDMS module wants to avoid routing multi-hundred-MB CAD files through the Node process, a presigned-upload path needs to be added — it does not exist.
3. **No built-in checksum/integrity verification.** Confirmed the scope doc already plans to compute and verify SHA-256 at the call site (backfill job, lines 464-467) — this is the right call since storage.ts provides none. Make sure any *new* upload path introduced for EDMS (not just the backfill) also computes/verifies checksums at the call site, since it won't get this for free from storage.ts.
4. **Content-type defaults to `application/octet-stream`** for anything not explicitly typed, and unconditionally downgrades `text/plain`. CAD formats (DWG/DXF) have no strong native MIME type, so this is fine, but callers must pass `mimeType` deliberately — don't rely on multer/browser sniffing alone.
5. **New EDMS keying scheme bypasses `buildStorageKey()`.** The scope doc's proposed key format (`{accountId}/drawings/{documentId}/rev-{N}.pdf`) is hand-rolled rather than using the existing `buildStorageKey()` helper (which sanitizes filenames and enforces the `{accountId}/{assetId|misc}/...` shape). If any EDMS code path ever writes to the *local* backend (e.g. dev/test environments without R2 configured), make sure the new keying scheme still can't produce a path-traversal-unsafe key, since `resolveLocalPath()`'s containment check will catch it at read/delete time but better to not rely solely on that as the first line of defense.
6. **No retry/backoff wrapper.** Large-file transient network failures will bubble up as raw SDK exceptions. Worth adding basic retry-with-backoff around multipart parts if/when that's introduced, especially given the droplet's likely modest uplink bandwidth for multi-GB backfill runs.
