/**
 * lib/imageNormalize.ts — normalize an uploaded photo before it is sent to the
 * vision model or stored on the asset.
 *
 *   - rotate(): applies the EXIF orientation tag so phone photos taken sideways
 *     are stored/shown upright (and the model reads them right-side-up).
 *   - HEIC/HEIF → JPEG: iPhones shoot HEIC by default; this container's sharp
 *     build carries libheif (verified heif decode = true), so we transcode
 *     instead of rejecting the upload and blocking the tech in the field.
 *   - resize cap: long edge ≤ 2000px keeps stored photos small and the vision
 *     token cost bounded without hurting legibility of a nameplate.
 *
 * Fail-safe: if sharp is unavailable the original buffer passes through
 * untouched; a decode failure throws a tagged error the route turns into a 400.
 */

'use strict';

let sharp: any = null;
try { sharp = require('sharp'); } catch (_e) { sharp = null; }

async function normalizeImage(buffer: Buffer, mimeType: string): Promise<{ buffer: Buffer; mimeType: string }> {
  if (!sharp || !buffer || !buffer.length) return { buffer, mimeType };
  try {
    const out = await sharp(buffer, { failOn: 'none' })
      .rotate() // apply EXIF orientation
      .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 86 })
      .toBuffer();
    return { buffer: out, mimeType: 'image/jpeg' };
  } catch (e: any) {
    const isHeic = /heic|heif/i.test(mimeType || '');
    const err: any = new Error(isHeic
      ? 'Could not read that HEIC photo — try taking it as JPEG, or upload a JPEG/PNG.'
      : 'Could not process that image — try a different photo.');
    err.imageNormalizeFailed = true;
    throw err;
  }
}

module.exports = { normalizeImage };
export {};
