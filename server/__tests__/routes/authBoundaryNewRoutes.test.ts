/**
 * Auth-boundary guard: every endpoint added in the 2026-06-19/20 feature work
 * must reject an unauthenticated request (no Authorization header) with 401.
 * Cheap regression guard against a future route being mounted outside
 * authenticateToken.
 */
import request from 'supertest';
import '../helpers/setup';

let app: any;
beforeAll(() => { app = require('../../index').default ?? require('../../index'); });
afterAll(async () => { try { await require('../../lib/prisma').default.$disconnect(); } catch {} });

const GETS = [
  '/api/compliance/maturity',
  '/api/compliance/maintenance-debt',
  '/api/compliance/maintenance-debt.csv',
  '/api/compliance/change-brief',
  '/api/compliance/evidence-gaps',
  '/api/compliance/asset-evidence/00000000-0000-4000-8000-000000000000',
  '/api/compliance/drift',
  '/api/access-blockers',
  '/api/proposals',
  '/api/proposals/proposal.pdf',
  '/api/fleet/portfolio-rank',
];

const POSTS = ['/api/access-blockers', '/api/proposals/request-contact'];

describe('new routes require authentication', () => {
  test.each(GETS)('GET %s -> 401 without a token', async (url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(401);
  });
  test.each(POSTS)('POST %s -> 401 without a token', async (url) => {
    const res = await request(app).post(url).send({});
    expect(res.status).toBe(401);
  });
});

export {};
