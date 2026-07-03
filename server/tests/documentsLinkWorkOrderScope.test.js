'use strict';

/**
 * Ownership regression (2026-07-03 acquisition scan, Scan 3):
 * POST /api/documents/link used to write a client-supplied workOrderId with
 * NO ownership check (the sibling POST /upload verifies it) -- a cross-tenant
 * FK write that pins an attacker-chosen link onto another tenant's work
 * order. /link must now 404 on a foreign/unknown work order, exactly like
 * /upload.
 *
 * In-memory express + fake prisma (same pattern as
 * arcFlashIngestAuthScope.test.js). REAL middleware/roles.
 */

jest.mock('../lib/prisma', () => {
  const rows = {
    asset: [{ id: 'asset-a', accountId: 'acct-a' }],
    workOrder: [
      { id: 'wo-own', accountId: 'acct-a' },
      { id: 'wo-foreign', accountId: 'acct-b' },
    ],
  };
  const findFirst = (table) => async ({ where }) =>
    rows[table].find(
      (r) => r.id === where.id && (where.accountId === undefined || r.accountId === where.accountId)
    ) || null;

  globalThis.__docCreates = [];
  const client = {
    asset: { findFirst: findFirst('asset') },
    workOrder: { findFirst: findFirst('workOrder') },
    document: {
      create: async ({ data }) => {
        globalThis.__docCreates.push(data);
        return { id: 'doc-new', ...data };
      },
    },
  };
  client.default = client;
  return client;
});

// Storage/crypto are irrelevant to /link (no bytes) but the module requires
// them at load; activity logging is fire-and-forget noise here.
jest.mock('../lib/storage', () => ({ downloadFile: jest.fn(), uploadFile: jest.fn(), getFileUrl: jest.fn() }));
jest.mock('../lib/docCrypto', () => ({ decrypt: jest.fn(), encrypt: jest.fn() }));
jest.mock('../lib/activityLog', () => ({ writeLog: jest.fn() }));

const express = require('express');
const request = require('supertest');

let currentUser;
let app;
beforeAll(() => {
  const router = require('../routes/documents');
  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/documents', router);
});

beforeEach(() => {
  currentUser = { id: 'user-a', accountId: 'acct-a', role: 'manager' };
  globalThis.__docCreates.length = 0;
});

const BASE = { url: 'https://vendor.example/manual.pdf', filename: 'manual.pdf' };

describe('POST /api/documents/link - workOrderId tenancy', () => {
  test('foreign workOrderId -> 404, nothing written', async () => {
    const res = await request(app).post('/api/documents/link')
      .send({ ...BASE, workOrderId: 'wo-foreign' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Work order not found.' });
    expect(globalThis.__docCreates).toHaveLength(0);
  });

  test('unknown workOrderId -> 404, nothing written', async () => {
    const res = await request(app).post('/api/documents/link')
      .send({ ...BASE, workOrderId: 'no-such-wo' });
    expect(res.status).toBe(404);
    expect(globalThis.__docCreates).toHaveLength(0);
  });

  test('own workOrderId -> 201 and the FK is persisted', async () => {
    const res = await request(app).post('/api/documents/link')
      .send({ ...BASE, workOrderId: 'wo-own' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(globalThis.__docCreates).toHaveLength(1);
    expect(globalThis.__docCreates[0].workOrderId).toBe('wo-own');
    expect(globalThis.__docCreates[0].accountId).toBe('acct-a');
  });

  test('no workOrderId -> 201 (behavior unchanged)', async () => {
    const res = await request(app).post('/api/documents/link').send(BASE);
    expect(res.status).toBe(201);
    expect(globalThis.__docCreates).toHaveLength(1);
    expect(globalThis.__docCreates[0].workOrderId).toBeNull();
  });

  test('/link stays manager-gated (viewer -> 403)', async () => {
    currentUser = { id: 'user-v', accountId: 'acct-a', role: 'viewer' };
    const res = await request(app).post('/api/documents/link')
      .send({ ...BASE, workOrderId: 'wo-own' });
    expect(res.status).toBe(403);
    expect(globalThis.__docCreates).toHaveLength(0);
  });
});
