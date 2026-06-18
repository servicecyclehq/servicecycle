/**
 * #34 bulk backfill. A zip of report files fans out into one auto-commit
 * IngestJob per report (reusing the #2 queue + worker), with a batch-status
 * aggregator. Worker mechanics are covered by ingestJobs.test.ts; here we cover
 * the zip fan-out, file filtering, role/tenancy, and the status rollup.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const JSZip = require('jszip');

let app: any;
let prisma: any;
let manager: TestUser;
let other: TestUser;
let viewer: TestUser;
let siteId: string;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  manager = await createTestUser('manager');
  other = await createTestUser('manager');
  viewer = await createTestUser('viewer');
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: 'Backfill Site' } });
  siteId = site.id;
});

afterAll(async () => {
  for (const u of [manager, other, viewer]) {
    const acc = u.accountId;
    try { await prisma.ingestJob.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

const auth = (u: TestUser) => `Bearer ${u.token}`;

async function makeZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('reportA.pdf', Buffer.from('%PDF-1.4 A'));
  zip.file('sub/reportB.pdf', Buffer.from('%PDF-1.4 B'));
  zip.file('notes.txt', Buffer.from('not a report'));
  zip.file('__MACOSX/._reportA.pdf', Buffer.from('junk'));
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('#34 backfill enqueue', () => {
  test('fans a zip into one backfill job per report, skips non-reports + junk', async () => {
    const buf = await makeZip();
    const res = await request(app)
      .post('/api/ingest/backfill')
      .set('Authorization', auth(manager))
      .field('siteId', siteId)
      .attach('file', buf, 'batch.zip');

    expect(res.status).toBe(202);
    expect(res.body.data.batchSize).toBe(2);
    expect(res.body.data.jobIds).toHaveLength(2);
    expect(res.body.data.skippedNonReport).toContain('notes.txt');

    const jobs = await prisma.ingestJob.findMany({ where: { id: { in: res.body.data.jobIds } } });
    expect(jobs).toHaveLength(2);
    for (const j of jobs) {
      expect(j.kind).toBe('backfill');
      expect(j.autoCommit).toBe(true);
      expect(j.siteId).toBe(siteId);
      expect(j.status).toBe('queued');
    }
  });

  test('rejects a non-zip upload', async () => {
    const res = await request(app)
      .post('/api/ingest/backfill')
      .set('Authorization', auth(manager))
      .attach('file', Buffer.from('%PDF-1.4 nope'), 'report.pdf');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('a bad siteId is rejected', async () => {
    const buf = await makeZip();
    const res = await request(app)
      .post('/api/ingest/backfill')
      .set('Authorization', auth(manager))
      .field('siteId', '00000000-0000-4000-8000-000000000000')
      .attach('file', buf, 'batch.zip');
    expect(res.status).toBe(400);
  });

  test('viewers cannot backfill (manager+ only)', async () => {
    const buf = await makeZip();
    const res = await request(app)
      .post('/api/ingest/backfill')
      .set('Authorization', auth(viewer))
      .attach('file', buf, 'batch.zip');
    expect(res.status).toBe(403);
  });
});

describe('#34 backfill status', () => {
  test('aggregates batch progress and is account-scoped', async () => {
    const buf = await makeZip();
    const enq = await request(app)
      .post('/api/ingest/backfill')
      .set('Authorization', auth(manager))
      .field('siteId', siteId)
      .attach('file', buf, 'batch.zip');
    const jobIds = enq.body.data.jobIds;

    const mine = await request(app)
      .post('/api/ingest/backfill/status')
      .set('Authorization', auth(manager))
      .send({ jobIds });
    expect(mine.status).toBe(200);
    expect(mine.body.data.total).toBe(jobIds.length);
    expect(mine.body.data.found).toBe(jobIds.length);
    expect(mine.body.data.counts.queued).toBe(jobIds.length);

    const theirs = await request(app)
      .post('/api/ingest/backfill/status')
      .set('Authorization', auth(other))
      .send({ jobIds });
    expect(theirs.status).toBe(200);
    expect(theirs.body.data.found).toBe(0);
  });
});

export {};