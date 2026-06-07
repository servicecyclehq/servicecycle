'use strict';

/**
 * Tests for the registration terms-acceptance gate.
 *
 * Hits a real express app + the live dev Postgres so the round-trip from
 * route handler to User row is exercised. Mocks lib/email and the seed-demo
 * import (the L3 seedAccountForUser call shouldn't run in a sterile test).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Mock email so register doesn't try to send anything.
jest.mock('../lib/email', () => {
  const actual = jest.requireActual('../lib/email');
  return { ...actual, sendEmail: jest.fn(async () => {}) };
});

// Stub the seed-demo import — DEMO_MODE is off in this test but be safe.
jest.mock('../scripts/seed-demo', () => ({
  seedAccountForUser: jest.fn(async () => ({ vendors: 0, contracts: 0 })),
  resetAndSeedDemo:   jest.fn(async () => ({})),
  DEMO_ACCOUNT_ID:    '11111111-1111-4111-8111-111111111111',
}));

const express = require('express');
const request = require('supertest');
const prisma  = require('../lib/prisma');

let app;
const trackedAccountIds = new Set();
const trackedUserEmails = new Set();

const ORIG_REGOPEN = process.env.REGISTRATION_OPEN;
const ORIG_DEMO    = process.env.DEMO_MODE;

beforeAll(() => {
  // Force registration open for the test, demo off so the seed-for-user
  // hook doesn't fire on every test row.
  process.env.REGISTRATION_OPEN = 'true';
  process.env.DEMO_MODE         = 'false';

  // Build a tiny app with just the auth router so we don't have to boot
  // the whole server.
  const authRoutes = require('../routes/auth');
  app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
});

afterAll(async () => {
  process.env.REGISTRATION_OPEN = ORIG_REGOPEN;
  process.env.DEMO_MODE         = ORIG_DEMO;
  // Cleanup
  for (const email of trackedUserEmails) {
    try {
      const u = await prisma.user.findUnique({ where: { email }, select: { id: true, accountId: true } });
      if (u) {
        await prisma.refreshToken.deleteMany({ where: { userId: u.id } }).catch(() => {});
        await prisma.user.delete({ where: { id: u.id } }).catch(() => {});
        trackedAccountIds.add(u.accountId);
      }
    } catch (_e) { /* ignore */ }
  }
  for (const id of trackedAccountIds) {
    await prisma.account.delete({ where: { id } }).catch(() => {});
  }
  await prisma.$disconnect();
});

const baseBody = {
  companyName: 'Acceptance Test Co',
  name:        'Test User',
  password:    'verysecret-1234567890',
};

describe('POST /api/auth/register — terms acceptance gate', () => {

  test('rejects when acceptedTerms is missing', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...baseBody, email: 'gate-1@test.invalid' });
    expect(res.status).toBe(400);
  });

  test('rejects when acceptedTerms is false', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...baseBody, email: 'gate-2@test.invalid', acceptedTerms: false });
    expect(res.status).toBe(400);
  });

  test('accepts when acceptedTerms=true and stamps acceptedTermsAt + version', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        ...baseBody, email: 'gate-3@test.invalid',
        acceptedTerms: true,
        acceptedTermsVersion: 'tos-2026-05-04, privacy-2026-05-04',
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeTruthy();
    trackedUserEmails.add('gate-3@test.invalid');

    const u = await prisma.user.findUnique({
      where:  { email: 'gate-3@test.invalid' },
      select: { acceptedTermsAt: true, acceptedTermsVersion: true },
    });
    expect(u.acceptedTermsAt).toBeInstanceOf(Date);
    expect(u.acceptedTermsVersion).toMatch(/tos-2026-05-04/);
  });

  test('defaults the version string when client omits it', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...baseBody, email: 'gate-4@test.invalid', acceptedTerms: true });
    expect(res.status).toBe(201);
    trackedUserEmails.add('gate-4@test.invalid');

    const u = await prisma.user.findUnique({
      where:  { email: 'gate-4@test.invalid' },
      select: { acceptedTermsVersion: true },
    });
    expect(u.acceptedTermsVersion).toBeTruthy();
    expect(u.acceptedTermsVersion).toMatch(/tos|privacy/);
  });
});
