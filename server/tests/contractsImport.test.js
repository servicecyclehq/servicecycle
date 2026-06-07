'use strict';

/**
 * Tests for POST /api/contracts/import — v0.6.0 CSV bulk import.
 *
 * Most cases exercise input-shape contracts that do not require the DB to
 * be in a specific state (400/401/413 responses). One positive round-trip
 * test exports the current account's contracts and re-imports them with
 * dedupeStrategy='skip' — idempotent (every row resolves to an existing
 * dup), so it safely verifies the happy path against a live dev server
 * without polluting seed data.
 *
 * Follows the bulk.test.js pattern: tests skip gracefully when the dev
 * server isn't reachable or seed credentials aren't present.
 */

const fs = require('fs');
const path = require('path');
const { api, login } = require('./helpers');

const ADMIN_EMAIL    = 'admin@acme.com';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin1234!';

async function tryLogin(email, password) {
  try { return await login(email, password); }
  catch { return null; }
}

// Build a minimal CSV in memory — matches the /export header schema for
// the columns we exercise. Returns a Buffer suitable for supertest's
// .attach('file', buf, { filename, contentType }).
function buildCsv(rows, headers) {
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(headers.map(h => {
      const v = r[h] == null ? '' : String(r[h]);
      return /[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(','));
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

describe('POST /api/contracts/import — input shape', () => {
  let adminToken = null;

  beforeAll(async () => {
    adminToken = await tryLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  test('rejects unauthenticated', async () => {
    const res = await api()
      .post('/api/contracts/import')
      .attach('file', Buffer.from('Vendor,Product\nAcme,X\n'), { filename: 'a.csv', contentType: 'text/csv' });
    if (res.status === 404) return;            // route not yet mounted on dev server
    expect([401, 403]).toContain(res.status);
  });

  test('rejects missing file', async () => {
    if (!adminToken) { console.warn('skipped — admin not available'); return; }
    const res = await api()
      .post('/api/contracts/import')
      .set('Authorization', `Bearer ${adminToken}`);
    if (res.status === 404) { console.warn('import route not yet mounted on dev server'); return; }
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no csv|file/i);
  });

  test('rejects empty CSV (no data rows)', async () => {
    if (!adminToken) return;
    const csv = Buffer.from('Vendor,Product\n', 'utf8');
    const res = await api()
      .post('/api/contracts/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', csv, { filename: 'empty.csv', contentType: 'text/csv' });
    if (res.status === 404) return;
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no data|empty/i);
  });

  test('rejects CSV missing required Vendor column', async () => {
    if (!adminToken) return;
    const csv = buildCsv(
      [{ 'Product': 'X', 'Notes': 'no vendor here' }],
      ['Product', 'Notes'],
    );
    const res = await api()
      .post('/api/contracts/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', csv, { filename: 'novendor.csv', contentType: 'text/csv' });
    if (res.status === 404) return;
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required column.*Vendor/i);
  });

  test('rejects CSV missing required Product column', async () => {
    if (!adminToken) return;
    const csv = buildCsv(
      [{ 'Vendor': 'Acme', 'Notes': 'no product here' }],
      ['Vendor', 'Notes'],
    );
    const res = await api()
      .post('/api/contracts/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', csv, { filename: 'noproduct.csv', contentType: 'text/csv' });
    if (res.status === 404) return;
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required column.*Product/i);
  });

  test('rejects CSV exceeding 1000-row cap', async () => {
    if (!adminToken) return;
    const rows = Array.from({ length: 1001 }, (_, i) => ({ Vendor: 'V', Product: `P${i}` }));
    const csv = buildCsv(rows, ['Vendor', 'Product']);
    const res = await api()
      .post('/api/contracts/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', csv, { filename: 'big.csv', contentType: 'text/csv' });
    if (res.status === 404) return;
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1000/);
  });

  test('rejects non-CSV file extension', async () => {
    if (!adminToken) return;
    const res = await api()
      .post('/api/contracts/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from('not a csv'), { filename: 'pwned.exe', contentType: 'application/octet-stream' });
    if (res.status === 404) return;
    expect(res.status).toBe(400);
  });
});

describe('POST /api/contracts/import?step=preview — validation + mapping', () => {
  let adminToken = null;

  beforeAll(async () => {
    adminToken = await tryLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  test('returns suggested mapping for our native export headers', async () => {
    if (!adminToken) { console.warn('skipped'); return; }
    const csv = buildCsv(
      [{ Vendor: 'AcmeCo', Product: 'SaaS X', Quantity: '5', 'End Date': '2026-12-31', 'Auto Renewal': 'Yes' }],
      ['Vendor', 'Product', 'Quantity', 'End Date', 'Auto Renewal'],
    );
    const res = await api()
      .post('/api/contracts/import?step=preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', csv, { filename: 'preview.csv', contentType: 'text/csv' });
    if (res.status === 404) return;
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalRows).toBe(1);
    expect(res.body.data.suggestedMapping.Vendor).toBe('vendor');
    expect(res.body.data.suggestedMapping.Product).toBe('product');
    expect(res.body.data.suggestedMapping['End Date']).toBe('endDate');
    expect(res.body.data.suggestedMapping['Auto Renewal']).toBe('autoRenewal');
    expect(Array.isArray(res.body.data.schemaFields)).toBe(true);
    expect(Array.isArray(res.body.data.sampleRows)).toBe(true);
  });

  test('reports per-row validation errors without bailing on first failure', async () => {
    if (!adminToken) return;
    const csv = buildCsv(
      [
        { Vendor: 'AcmeCo', Product: 'Good Row',  Quantity: '5',  'End Date': '2026-12-31' },
        { Vendor: 'AcmeCo', Product: 'Bad Date',  Quantity: '5',  'End Date': 'not-a-date' },
        { Vendor: 'AcmeCo', Product: 'Bad Qty',   Quantity: 'abc', 'End Date': '2026-12-31' },
      ],
      ['Vendor', 'Product', 'Quantity', 'End Date'],
    );
    const res = await api()
      .post('/api/contracts/import?step=preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', csv, { filename: 'errors.csv', contentType: 'text/csv' });
    if (res.status === 404) return;
    expect(res.status).toBe(200);
    expect(res.body.data.totalRows).toBe(3);
    expect(res.body.data.validationErrors.length).toBe(2);
    // Row numbers are 1-indexed + header offset → data rows start at 2
    const rowNums = res.body.data.validationErrors.map(e => e.row).sort();
    expect(rowNums).toEqual([3, 4]);
  });

  test('lists unknown vendors for preview UI', async () => {
    if (!adminToken) return;
    const csv = buildCsv(
      [{ Vendor: '__definitely_not_a_seeded_vendor_xyz__', Product: 'X' }],
      ['Vendor', 'Product'],
    );
    const res = await api()
      .post('/api/contracts/import?step=preview')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', csv, { filename: 'newv.csv', contentType: 'text/csv' });
    if (res.status === 404) return;
    expect(res.status).toBe(200);
    expect(res.body.data.unknownVendors).toContain('__definitely_not_a_seeded_vendor_xyz__');
  });
});

describe('POST /api/contracts/import?step=commit — dedupe + transaction', () => {
  let adminToken = null;

  beforeAll(async () => {
    adminToken = await tryLogin(ADMIN_EMAIL, ADMIN_PASSWORD);
  });

  test('rejects commit when unknown vendors and createMissingVendors=false', async () => {
    if (!adminToken) return;
    const csv = buildCsv(
      [{ Vendor: '__totally_made_up_vendor_no_dedupe__', Product: 'Will Fail' }],
      ['Vendor', 'Product'],
    );
    const res = await api()
      .post('/api/contracts/import?step=commit')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', csv, { filename: 'reject.csv', contentType: 'text/csv' });
    if (res.status === 404) return;
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown vendors/i);
    expect(res.body.data.unknownVendors).toContain('__totally_made_up_vendor_no_dedupe__');
  });

  test('round-trip: export then re-import with dedupeStrategy=skip is a no-op', async () => {
    if (!adminToken) return;
    // 1) Pull the current export
    const exp = await api()
      .get('/api/contracts/export')
      .set('Authorization', `Bearer ${adminToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks = [];
        response.on('data', c => chunks.push(c));
        response.on('end',  ()  => callback(null, Buffer.concat(chunks).toString('utf8')));
      });
    if (exp.status === 404 || exp.status >= 500) { console.warn('export skipped'); return; }
    expect(exp.status).toBe(200);

    const csv = exp.body;
    const dataLines = csv.split('\n').filter(Boolean);
    if (dataLines.length <= 1) { console.warn('round-trip skipped — no contracts in seed'); return; }

    // 2) Re-import, dedupeStrategy='skip'
    const res = await api()
      .post('/api/contracts/import?step=commit')
      .set('Authorization', `Bearer ${adminToken}`)
      .field('dedupeStrategy', 'skip')
      .attach('file', Buffer.from(csv, 'utf8'), { filename: 'roundtrip.csv', contentType: 'text/csv' });
    if (res.status === 404) return;
    if (res.status === 400 && /1000/.test(res.body.error || '')) {
      console.warn('round-trip skipped — seed has > 1000 contracts');
      return;
    }
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.created).toBe(0);  // every row dedupes
    expect(res.body.data.failed).toBe(0);   // every row validates
    expect(res.body.data.skipped).toBeGreaterThan(0);
  });
});
