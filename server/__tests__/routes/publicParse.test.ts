/**
 * #17 Parser-as-funnel. Covers the pure teaser builder and the public endpoint
 * validation + lead capture (no auth). The deterministic parser itself is
 * exercised elsewhere; here we assert the funnel wiring and gating.
 */
import request from 'supertest';
import '../helpers/setup';

const { buildTeaser } = require('../../routes/publicParse');

let app: any;
let prisma: any;

beforeAll(() => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
});

afterAll(async () => {
  try { await prisma.publicParseLead.deleteMany({ where: { email: { contains: '@funnel.test' } } }); } catch {}
  await prisma.$disconnect();
});

describe('#17 buildTeaser', () => {
  test('counts findings + criticals, returns label-only top findings', () => {
    const measurements = [
      { measurementType: 'insulation_resistance', label: 'IR A', phase: 'A', passFail: 'GREEN' },
      { measurementType: 'contact_resistance', label: 'Contact', passFail: 'RED', critical: true },
      { measurementType: 'ttr', label: 'TTR', passFail: 'YELLOW' },
    ];
    const t = buildTeaser(measurements);
    expect(t.measurementCount).toBe(3);
    expect(t.findingsCount).toBeGreaterThanOrEqual(1);
    expect(t.criticalCount).toBeGreaterThanOrEqual(1);
    expect(t.topFindings[0]).not.toHaveProperty('asFoundValue'); // label only, no values
  });

  test('empty measurements -> all zero', () => {
    const t = buildTeaser([]);
    expect(t).toMatchObject({ measurementCount: 0, findingsCount: 0, criticalCount: 0 });
  });
});

describe('#17 public endpoint gating', () => {
  test('rejects an invalid email', async () => {
    const res = await request(app)
      .post('/api/public/parse-report')
      .field('email', 'not-an-email')
      .attach('file', Buffer.from('%PDF-1.4 test'), 'report.pdf');
    expect(res.status).toBe(400);
  });

  test('rejects a missing file', async () => {
    const res = await request(app)
      .post('/api/public/parse-report')
      .field('email', 'lead@funnel.test');
    expect(res.status).toBe(400);
  });

  test('valid email + pdf returns a teaser and captures the lead (fail-open parse)', async () => {
    const res = await request(app)
      .post('/api/public/parse-report')
      .field('email', 'prospect@funnel.test')
      .attach('file', Buffer.from('%PDF-1.4\n% minimal pdf for funnel test\n'), 'report.pdf');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('measurementCount');
    expect(res.body.data).toHaveProperty('findingsCount');
    // lead capture is fire-and-forget; give it a tick then assert it landed.
    await new Promise((r) => setTimeout(r, 150));
    const lead = await prisma.publicParseLead.findFirst({ where: { email: 'prospect@funnel.test' } });
    expect(lead).toBeTruthy();
    expect(lead.ipHash === null || typeof lead.ipHash === 'string').toBe(true);
  });
});

export {};
