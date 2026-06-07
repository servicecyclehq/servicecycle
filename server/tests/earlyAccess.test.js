'use strict';

/**
 * L7: early-access route — pure unit tests for the validator + honeypot.
 *
 * Mounts the route on a throwaway express app, mocks lib/email so we don't
 * fire real Resend calls. Hits the live dev Postgres for the insert path
 * because the row landing in the table IS the contract — mocking Prisma
 * would defeat the test.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Mock email so the route doesn't try to talk to Brevo.
globalThis.__mockSendEmailCalls = [];
jest.mock('../lib/email', () => {
  const actual = jest.requireActual('../lib/email');
  return {
    ...actual,
    sendEmail: jest.fn(async (args) => {
      globalThis.__mockSendEmailCalls.push(args);
    }),
  };
});

// jest.config.js maps '../lib/prisma' to the no-op stub in
// tests/__mocks__/prisma.js, which would make the route's insert return null
// and hang the handler. This suite's contract is "the row lands in the real
// table", so override the mapped module with a real PrismaClient.
jest.mock('../lib/prisma', () => {
  const { PrismaClient } = require('@prisma/client');
  const client = new PrismaClient();
  // Cover both `require('../lib/prisma')` and esbuild's default-import interop.
  client.default = client;
  return client;
});

const express = require('express');
const request = require('supertest');
const prisma  = require('../lib/prisma');
const earlyAccessRouter = require('../routes/earlyAccess');

let app;
const trackedIds = new Set();

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/api/early-access', earlyAccessRouter);
});

beforeEach(() => {
  globalThis.__mockSendEmailCalls.length = 0;
});

afterAll(async () => {
  if (trackedIds.size) {
    await prisma.earlyAccessRequest.deleteMany({ where: { id: { in: [...trackedIds] } } });
  }
  await prisma.$disconnect();
});

describe('POST /api/early-access', () => {

  test('happy path: writes a row, fires the auto-reply email, returns 201', async () => {
    const res = await request(app)
      .post('/api/early-access')
      .send({ name: 'Sarah Chen', email: 'sarah@acme.test', company: 'Acme', timing: 'now', website: '' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBeTruthy();
    trackedIds.add(res.body.data.id);

    // Row in DB
    const row = await prisma.earlyAccessRequest.findUnique({ where: { id: res.body.data.id } });
    expect(row).not.toBeNull();
    expect(row.email).toBe('sarah@acme.test');
    expect(row.company).toBe('Acme');
    expect(row.timing).toBe('now');

    // Auto-reply queued (allow microtask flush)
    await new Promise(r => setImmediate(r));
    const replied = globalThis.__mockSendEmailCalls.find(c => c.to === 'sarah@acme.test');
    expect(replied).toBeDefined();
    expect(replied.subject).toMatch(/early-access/i);
  });

  test('honeypot tripped: returns 201 silently, drops the row, sends no email', async () => {
    const res = await request(app)
      .post('/api/early-access')
      .send({ name: 'Bot', email: 'bot@spam.test', website: 'https://spam.example' });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('honeypot');

    // No row inserted
    const found = await prisma.earlyAccessRequest.findFirst({ where: { email: 'bot@spam.test' } });
    expect(found).toBeNull();

    // No email queued
    await new Promise(r => setImmediate(r));
    expect(globalThis.__mockSendEmailCalls.length).toBe(0);
  });

  test('400 on missing name', async () => {
    const res = await request(app).post('/api/early-access').send({ email: 'x@y.test' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid/i);
  });

  test('400 on malformed email', async () => {
    const res = await request(app)
      .post('/api/early-access')
      .send({ name: 'Sarah', email: 'not-an-email', website: '' });
    expect(res.status).toBe(400);
  });

  test('400 on bogus timing enum value (defends the funnel labels)', async () => {
    const res = await request(app)
      .post('/api/early-access')
      .send({ name: 'Sarah', email: 's@a.test', timing: 'whenever', website: '' });
    expect(res.status).toBe(400);
  });

  test('email is lowercased + trimmed before insert', async () => {
    const res = await request(app)
      .post('/api/early-access')
      .send({ name: 'Bob', email: '   BOB@ACME.TEST   ', website: '' });
    expect(res.status).toBe(201);
    trackedIds.add(res.body.data.id);
    const row = await prisma.earlyAccessRequest.findUnique({ where: { id: res.body.data.id } });
    expect(row.email).toBe('bob@acme.test');
  });
});

describe('GET /api/early-access/list', () => {
  test('returns rows ordered by createdAt desc', async () => {
    // Seed two rows with controlled order
    const a = await prisma.earlyAccessRequest.create({
      data: { name: 'AAA', email: 'aaa@list.test', createdAt: new Date(Date.now() - 2000) },
      select: { id: true },
    });
    const b = await prisma.earlyAccessRequest.create({
      data: { name: 'BBB', email: 'bbb@list.test' },
      select: { id: true },
    });
    trackedIds.add(a.id); trackedIds.add(b.id);

    const res = await request(app).get('/api/early-access/list');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.rows)).toBe(true);

    // The first of "our" two rows should be BBB (newer)
    const ourRows = res.body.data.rows.filter(r => r.email === 'aaa@list.test' || r.email === 'bbb@list.test');
    expect(ourRows[0].email).toBe('bbb@list.test');
    expect(ourRows[1].email).toBe('aaa@list.test');
  });
});
