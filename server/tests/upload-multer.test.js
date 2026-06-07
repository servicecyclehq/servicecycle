/**
 * tests/upload-multer.test.js
 * ---------------------------
 * Smoke test for the multer 2.x upgrade (audit finding F001 / 2026-05-03).
 *
 * The runtime API we depend on is narrow:
 *   - multer.memoryStorage()
 *   - upload.single(field) middleware
 *   - limits.fileSize triggers err.code === 'LIMIT_FILE_SIZE'
 *   - fileFilter cb(err) routes the error to the next() handler
 *
 * Multer 2.x changed internal stream handling to fix the 7 DoS CVEs
 * but kept this surface stable. This suite locks in that behavior so
 * a future bump that drifts the API will fail fast.
 */

const express = require('express');
const multer = require('multer');
const request = require('supertest');

function buildApp({ limit = 1024, allowMime = ['text/plain'] } = {}) {
  const app = express();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: limit },
    fileFilter: (req, file, cb) => {
      if (allowMime.includes(file.mimetype)) return cb(null, true);
      const err = new Error(`Unsupported MIME: ${file.mimetype}`);
      err.status = 415;
      err.code = 'UNSUPPORTED_MEDIA_TYPE';
      return cb(err);
    },
  });

  app.post('/upload', (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ ok: false, code: err.code });
        }
        if (err.code === 'UNSUPPORTED_MEDIA_TYPE' || err.status === 415) {
          return res.status(415).json({ ok: false, code: err.code });
        }
        return res.status(400).json({ ok: false, code: err.code || 'UNKNOWN', message: err.message });
      }
      if (!req.file) return res.status(400).json({ ok: false, code: 'NO_FILE' });
      return res.status(200).json({
        ok: true,
        bytes: req.file.size,
        mimetype: req.file.mimetype,
      });
    });
  });

  return app;
}

describe('multer 2.x upload surface', () => {
  test('accepts an in-allowlist text file under the size cap', async () => {
    const app = buildApp({ limit: 1024 });
    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.from('hello world'), {
        filename: 'hello.txt',
        contentType: 'text/plain',
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.bytes).toBe(11);
    expect(res.body.mimetype).toBe('text/plain');
  });

  test('rejects oversize payload with LIMIT_FILE_SIZE -> 413', async () => {
    const app = buildApp({ limit: 16 });
    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.alloc(64, 0x41), {
        filename: 'big.txt',
        contentType: 'text/plain',
      });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('LIMIT_FILE_SIZE');
  });

  test('rejects out-of-allowlist MIME with 415', async () => {
    const app = buildApp({ limit: 1024, allowMime: ['text/plain'] });
    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.from('not a pdf'), {
        filename: 'evil.exe',
        contentType: 'application/octet-stream',
      });
    expect(res.status).toBe(415);
  });

  test('multer 2.x exposes the version we asked for', () => {
    // Locks in the upgrade — if a future bump silently downgrades to a
    // 1.x line we still have CVEs against, this snapshot fails.
    const v = require('multer/package.json').version;
    const major = parseInt(v.split('.')[0], 10);
    expect(major).toBeGreaterThanOrEqual(2);
  });
});
