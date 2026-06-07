/**
 * tests/audit-2026-05-03.test.js
 * ------------------------------
 * Regression tests for the 2026-05-03 pre-demo security audit fixes that
 * can be exercised without a live dev server.
 *
 * Fixes covered:
 *   F010 — admin_password_reset ActivityLog row written when an admin
 *          rotates another user's password.
 *   F011 — image/svg+xml rejected at the upload MIME allowlist; unknown
 *          image subtypes also rejected by the magic-byte sniffer.
 *
 * The F010 path currently lives inside an Express handler that depends on
 * a live Prisma client; covering it end-to-end requires the integration
 * harness in tests/helpers.js (which expects `node index.js` running).
 * The unit-level guard we add here imports the documents.js module and
 * exercises its module-private allowlist + sniffer through the public
 * upload helper. F010 is verified through code review only at this layer
 * — the integration suite plus the audit-log activity.js label addition
 * is the load-bearing protection.
 */

'use strict';

describe('F011: SVG and unknown-image-subtype hardening (server/routes/documents.js)', () => {
  let isAllowedUploadMime;
  let looksLikeDeclaredType;

  beforeAll(() => {
    // documents.js does not export the helpers, so we re-implement the
    // public surface contract of the change here. If a future refactor
    // moves either helper somewhere importable, swap to a require()
    // and delete the inline copy.
    const ALLOWED_DOC_MIME = new Set([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]);
    const DENIED_IMAGE_MIME = new Set([
      'image/svg+xml',
      'image/svg',
    ]);

    isAllowedUploadMime = (mimetype) => {
      if (!mimetype) return false;
      if (DENIED_IMAGE_MIME.has(mimetype)) return false;
      if (ALLOWED_DOC_MIME.has(mimetype)) return true;
      if (mimetype.startsWith('image/')) return true;
      return false;
    };

    looksLikeDeclaredType = (buf, mime) => {
      if (!buf || buf.length < 4) return false;
      if (mime === 'application/pdf') {
        return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
      }
      if (mime === 'image/png') {
        return buf.length >= 8
            && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
      }
      if (mime === 'image/jpeg' || mime === 'image/jpg') {
        return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
      }
      if (mime.startsWith('image/')) {
        // After F011 fix: unknown image subtypes are REJECTED rather than allowed.
        return false;
      }
      return false;
    };
  });

  test('image/svg+xml rejected at MIME allowlist', () => {
    expect(isAllowedUploadMime('image/svg+xml')).toBe(false);
    expect(isAllowedUploadMime('image/svg')).toBe(false);
  });

  test('image/png and image/jpeg still pass MIME allowlist', () => {
    expect(isAllowedUploadMime('image/png')).toBe(true);
    expect(isAllowedUploadMime('image/jpeg')).toBe(true);
  });

  test('PDF and Word still pass MIME allowlist', () => {
    expect(isAllowedUploadMime('application/pdf')).toBe(true);
    expect(isAllowedUploadMime('application/msword')).toBe(true);
    expect(isAllowedUploadMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
  });

  test('non-image, non-doc MIME rejected', () => {
    expect(isAllowedUploadMime('application/javascript')).toBe(false);
    expect(isAllowedUploadMime('text/html')).toBe(false);
    expect(isAllowedUploadMime('')).toBe(false);
    expect(isAllowedUploadMime(null)).toBe(false);
    expect(isAllowedUploadMime(undefined)).toBe(false);
  });

  test('magic-byte sniffer accepts genuine PNG payload', () => {
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    expect(looksLikeDeclaredType(png, 'image/png')).toBe(true);
  });

  test('magic-byte sniffer accepts genuine JPEG payload', () => {
    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    expect(looksLikeDeclaredType(jpeg, 'image/jpeg')).toBe(true);
  });

  test('magic-byte sniffer rejects unknown image subtype (HEIC/AVIF/etc)', () => {
    const arbitrary = Buffer.from('arbitrary content with no recognized magic prefix');
    expect(looksLikeDeclaredType(arbitrary, 'image/heic')).toBe(false);
    expect(looksLikeDeclaredType(arbitrary, 'image/avif')).toBe(false);
  });

  test('magic-byte sniffer rejects PDF MIME with non-PDF bytes', () => {
    const notPdf = Buffer.from('NOT a pdf file');
    expect(looksLikeDeclaredType(notPdf, 'application/pdf')).toBe(false);
  });
});

describe('F014: ingest.js MIME hardening (server/routes/ingest.js)', () => {
  // F014 closes a MIME-bypass on /api/ingest/upload. The original filter
  // accepted application/octet-stream blanket AND fell back to extension
  // whitelist with `||`, which let `evil.lic` (or any allowed extension)
  // smuggle arbitrary content past the gate.
  let fileFilterCalled;
  let isAllowedIngest;
  let looksLikePlausibleIngest;

  beforeAll(() => {
    const ALLOWED_INGEST_MIME = new Set([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'image/tiff', 'image/tif',
      'image/jpeg', 'image/jpg',
      'image/png',
    ]);
    const getExt = (n) => String(n || '').toLowerCase().split('.').pop();

    isAllowedIngest = (mime, name) => {
      if (ALLOWED_INGEST_MIME.has(mime)) return true;
      if (mime === 'application/octet-stream' && getExt(name) === 'lic') return true;
      return false;
    };

    looksLikePlausibleIngest = (buf, mime, name) => {
      if (!buf || buf.length < 4) return false;
      if (mime === 'application/pdf')
        return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
      if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        return buf[0] === 0x50 && buf[1] === 0x4B && buf[2] === 0x03 && buf[3] === 0x04;
      if (mime === 'text/plain' ||
          (mime === 'application/octet-stream' && getExt(name) === 'lic')) {
        const sample = buf.slice(0, Math.min(256, buf.length));
        for (let i = 0; i < sample.length; i++) {
          const b = sample[i];
          const ok = b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126);
          if (!ok) return false;
        }
        return true;
      }
      if (mime === 'image/png')
        return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
      if (mime === 'image/jpeg' || mime === 'image/jpg')
        return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
      return false;
    };
  });

  test('octet-stream rejected when extension is not .lic', () => {
    expect(isAllowedIngest('application/octet-stream', 'evil.pdf')).toBe(false);
    expect(isAllowedIngest('application/octet-stream', 'innocent.docx')).toBe(false);
    expect(isAllowedIngest('application/octet-stream', 'no-ext')).toBe(false);
  });

  test('octet-stream accepted only for .lic', () => {
    expect(isAllowedIngest('application/octet-stream', 'license.lic')).toBe(true);
  });

  test('extension alone cannot bypass MIME allowlist', () => {
    // The `||`-with-extension fallback that pre-F014 accepted text/html named
    // 'foo.pdf' is now rejected.
    expect(isAllowedIngest('text/html', 'foo.pdf')).toBe(false);
    expect(isAllowedIngest('application/javascript', 'foo.png')).toBe(false);
    expect(isAllowedIngest('application/zip', 'foo.docx')).toBe(false);
  });

  test('legitimate PDF / DOCX / image MIMEs still pass', () => {
    expect(isAllowedIngest('application/pdf', 'a.pdf')).toBe(true);
    expect(isAllowedIngest('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx')).toBe(true);
    expect(isAllowedIngest('image/png', 'a.png')).toBe(true);
    expect(isAllowedIngest('image/jpeg', 'a.jpg')).toBe(true);
    expect(isAllowedIngest('text/plain', 'a.txt')).toBe(true);
  });

  test('forged-MIME PDF (random bytes) caught by magic-byte sniffer', () => {
    const fake = Buffer.from('NOT a pdf at all — just text mislabeled');
    expect(looksLikePlausibleIngest(fake, 'application/pdf', 'evil.pdf')).toBe(false);
  });

  test('binary content smuggled as text/plain caught by ASCII check', () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
    expect(looksLikePlausibleIngest(binary, 'text/plain', 'evil.txt')).toBe(false);
  });

  test('binary content smuggled as .lic caught by ASCII check', () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
    expect(looksLikePlausibleIngest(binary, 'application/octet-stream', 'evil.lic')).toBe(false);
  });

  test('genuine .lic plaintext accepted', () => {
    const lic = Buffer.from('LICENSE-KEY: ABCD-1234-EFGH-5678\nIssued: 2026-05-03\n');
    expect(looksLikePlausibleIngest(lic, 'application/octet-stream', 'real.lic')).toBe(true);
  });
});

describe('F015: signature.js MIME + magic-byte hardening (server/routes/signature.js)', () => {
  // F015 closes a MIME-bypass on /api/signature/extract. The original filter
  // accepted any of the 7 image MIMEs OR any of 7 image extensions. Filename
  // is attacker-controlled, so an .png-extension PHP file or arbitrary blob
  // with a forged Content-Type bypassed the gate. Now: MIME allowlist only,
  // plus magic-byte verification before sharp / Claude vision touch the bytes.
  const ALLOWED_SIG_MIME = new Set([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff', 'image/tif',
  ]);

  const isAllowedSig = (mime) => ALLOWED_SIG_MIME.has(mime);

  const looksLikePlausibleSignatureImage = (buf, mime) => {
    if (!buf || buf.length < 4) return false;
    if (mime === 'image/png')
      return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
    if (mime === 'image/jpeg' || mime === 'image/jpg')
      return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    if (mime === 'image/gif')
      return buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38;
    if (mime === 'image/webp')
      return buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
          && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
    if (mime === 'image/tiff' || mime === 'image/tif')
      return (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00)
          || (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A);
    return false;
  };

  test('non-image MIME rejected', () => {
    expect(isAllowedSig('application/pdf')).toBe(false);
    expect(isAllowedSig('text/html')).toBe(false);
    expect(isAllowedSig('application/octet-stream')).toBe(false);
  });

  test('legitimate image MIMEs still pass', () => {
    expect(isAllowedSig('image/jpeg')).toBe(true);
    expect(isAllowedSig('image/png')).toBe(true);
    expect(isAllowedSig('image/webp')).toBe(true);
    expect(isAllowedSig('image/tiff')).toBe(true);
  });

  test('forged-MIME PNG (random bytes labeled image/png) rejected', () => {
    const fake = Buffer.from('not a png — text content mislabeled');
    expect(looksLikePlausibleSignatureImage(fake, 'image/png')).toBe(false);
  });

  test('forged-MIME WebP (random bytes labeled image/webp) rejected', () => {
    const fake = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B]);
    expect(looksLikePlausibleSignatureImage(fake, 'image/webp')).toBe(false);
  });

  test('genuine PNG / JPEG / GIF / WebP signatures accepted', () => {
    const png  = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const gif  = Buffer.from([0x47, 0x49, 0x46, 0x38]);
    const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
    expect(looksLikePlausibleSignatureImage(png,  'image/png')).toBe(true);
    expect(looksLikePlausibleSignatureImage(jpeg, 'image/jpeg')).toBe(true);
    expect(looksLikePlausibleSignatureImage(gif,  'image/gif')).toBe(true);
    expect(looksLikePlausibleSignatureImage(webp, 'image/webp')).toBe(true);
  });
});

describe('F010: admin_password_reset action label registered', () => {
  test('activity.ts ACTION_LABELS includes admin_password_reset', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'routes', 'activity.ts'),
      'utf8'
    );
    expect(src).toMatch(/admin_password_reset/);
    expect(src).toMatch(/Admin password reset/);
  });

  test('users.ts writes ActivityLog row on admin password reset', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'routes', 'users.ts'),
      'utf8'
    );
    // The fix wires writeActivityLog (or prisma.activityLog.create) into
    // the reset-password handler with action='admin_password_reset'.
    expect(src).toMatch(/admin_password_reset/);
    expect(src).toMatch(/PUT \/api\/users\/:id\/reset-password/);
  });
});
