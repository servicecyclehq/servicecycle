'use strict';

/**
 * lib/storage.putAtKey — 2026-07-05, added to unblock the EDMS backfill
 * script's documented `{accountId}/drawings/{documentId}/rev-{N}.pdf` keying
 * scheme (see server/scripts/backfillDrawingRevisions.ts header comment).
 * Local-filesystem branch only (no S3 credentials in this test env);
 * mirrors the coverage uploadFile() would get if it had a test file.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

describe('storage.putAtKey (local filesystem branch)', () => {
  let tmpRoot;
  let storage;
  const ORIGINAL_DEST = process.env.STORAGE_DEST;
  const ORIGINAL_LOCAL_PATH = process.env.STORAGE_LOCAL_PATH;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-storage-test-'));
    process.env.STORAGE_DEST = 'local';
    process.env.STORAGE_LOCAL_PATH = tmpRoot;
    jest.resetModules();
    storage = require('../lib/storage');
  });

  afterEach(async () => {
    process.env.STORAGE_DEST = ORIGINAL_DEST;
    process.env.STORAGE_LOCAL_PATH = ORIGINAL_LOCAL_PATH;
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  test('writes the buffer at the exact given key, creating intermediate directories', async () => {
    const key = 'acct1/drawings/doc1/rev-1.pdf';
    const buf = Buffer.from('%PDF-fake-bytes');
    const out = await storage.putAtKey(key, buf, 'application/pdf');
    expect(out).toEqual({ storageKey: key, sizeBytes: buf.length });
    const written = await fsp.readFile(path.join(tmpRoot, key));
    expect(written.equals(buf)).toBe(true);
  });

  test('a second call to the same key overwrites (matches uploadFile-style semantics for this primitive)', async () => {
    const key = 'acct1/drawings/doc1/rev-1.pdf';
    await storage.putAtKey(key, Buffer.from('v1'), 'application/pdf');
    await storage.putAtKey(key, Buffer.from('v2-longer'), 'application/pdf');
    const written = await fsp.readFile(path.join(tmpRoot, key), 'utf8');
    expect(written).toBe('v2-longer');
  });

  test('rejects a key that resolves outside the storage root (path traversal)', async () => {
    await expect(storage.putAtKey('../../etc/passwd', Buffer.from('x'), 'text/plain'))
      .rejects.toThrow(/outside the storage root/);
  });

  test('rejects a missing/empty key', async () => {
    await expect(storage.putAtKey('', Buffer.from('x'), 'text/plain')).rejects.toThrow(/key is required/);
    await expect(storage.putAtKey(null, Buffer.from('x'), 'text/plain')).rejects.toThrow(/key is required/);
  });
});
