/**
 * #2 Async ingest jobs. Covers the enqueue/status endpoints + tenancy, and the
 * worker queue mechanics (claim with SKIP LOCKED, done path, retry-then-fail,
 * stale recovery) with an injected builder so no Python/PDF is required.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let worker: any;
let manager: TestUser;
let other: TestUser;
let fileKey: string;

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  worker = require('../../lib/ingestWorker');
  manager = await createTestUser('manager');
  other = await createTestUser('manager');
  // A real stored file the worker can download (the fake builder ignores bytes).
  const { uploadFile } = require('../../lib/storage');
  const up = await uploadFile(manager.accountId, null, 'worker.pdf', Buffer.from('%PDF-1.4 hi'), 'application/pdf');
  fileKey = up.storageKey;
});

afterAll(async () => {
  for (const u of [manager, other]) {
    const acc = u.accountId;
    try { await prisma.activityLog.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.ingestJob.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

const auth = (u: TestUser) => `Bearer ${u.token}`;
const makeJob = (over: any = {}) => prisma.ingestJob.create({
  data: { accountId: manager.accountId, createdById: manager.id, kind: 'test_report', status: 'queued', fileKey, fileName: 'worker.pdf', ...over },
});

describe('#2 enqueue + status endpoints', () => {
  test('enqueues a job and returns 202 with a jobId', async () => {
    const res = await request(app)
      .post('/api/ingest/jobs')
      .set('Authorization', auth(manager))
      .attach('file', Buffer.from('%PDF-1.4 enqueue'), 'report.pdf');
    expect(res.status).toBe(202);
    expect(res.body.data.jobId).toBeTruthy();
    expect(res.body.data.status).toBe('queued');

    const row = await prisma.ingestJob.findUnique({ where: { id: res.body.data.jobId } });
    expect(row.accountId).toBe(manager.accountId);
    expect(row.fileKey).toBeTruthy();
  });

  test('rejects a non-document upload', async () => {
    const res = await request(app)
      .post('/api/ingest/jobs')
      .set('Authorization', auth(manager))
      .attach('file', Buffer.from('nope'), 'malware.exe');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test('status is account-scoped (other tenant 404s)', async () => {
    const job = await makeJob();
    const mine = await request(app).get(`/api/ingest/jobs/${job.id}`).set('Authorization', auth(manager));
    expect(mine.status).toBe(200);
    const theirs = await request(app).get(`/api/ingest/jobs/${job.id}`).set('Authorization', auth(other));
    expect(theirs.status).toBe(404);
  });
});

describe('#2 worker queue mechanics', () => {
  const fakeBuilder = async () => ({ measurements: [{ measurementType: 'ir', asFoundValue: 1 }], assetSections: 1, source: 'fake' });
  const throwingBuilder = async () => { throw new Error('boom'); };

  beforeEach(async () => {
    await prisma.ingestJob.deleteMany({ where: { accountId: manager.accountId } });
  });

  test('processes a queued job to done with the builder result stored', async () => {
    const job = await makeJob();
    const id = await worker.processNextIngestJob(fakeBuilder);
    expect(id).toBe(job.id);
    const done = await prisma.ingestJob.findUnique({ where: { id: job.id } });
    expect(done.status).toBe('done');
    expect(done.progress).toBe(100);
    expect((done.result as any).source).toBe('fake');
  });

  // 2026-07-07 (overnight capture-gap fix): the builder's rawText should land
  // on the dedicated IngestJob.rawText column, NOT stay duplicated inside
  // `result` (the polling payload) -- verifies both the write and the pop.
  test('persists builder rawText onto IngestJob.rawText, stripped out of result', async () => {
    const job = await makeJob();
    const rawTextBuilder = async () => ({
      measurements: [{ measurementType: 'ir', asFoundValue: 1 }],
      assetSections: 1, source: 'fake', rawText: 'FULL REPORT TEXT — page 1 of 1',
    });
    await worker.processNextIngestJob(rawTextBuilder);
    const done = await prisma.ingestJob.findUnique({ where: { id: job.id } });
    expect(done.rawText).toBe('FULL REPORT TEXT — page 1 of 1');
    expect((done.result as any).rawText).toBeUndefined();
  });

  test('rawText stays null when the builder does not provide one (pdfjs fallback path)', async () => {
    const job = await makeJob();
    await worker.processNextIngestJob(fakeBuilder); // no rawText key at all
    const done = await prisma.ingestJob.findUnique({ where: { id: job.id } });
    expect(done.rawText).toBeNull();
  });

  test('claim is atomic: two claims return distinct jobs, third is null', async () => {
    await makeJob();
    await makeJob();
    const a = await worker.claimNextJobId();
    const b = await worker.claimNextJobId();
    const c = await worker.claimNextJobId();
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
    expect(c).toBeNull();
  });

  test('a failing build retries, then fails terminally after MAX_ATTEMPTS', async () => {
    await makeJob();
    // First attempt -> requeued (status back to queued)
    await worker.processNextIngestJob(throwingBuilder);
    let j = await prisma.ingestJob.findFirst({ where: { accountId: manager.accountId } });
    expect(j.status).toBe('queued');
    expect(j.attempts).toBe(1);
    // Drive attempts up to MAX_ATTEMPTS -> terminal failure
    for (let i = 0; i < worker.MAX_ATTEMPTS; i++) {
      await worker.processNextIngestJob(throwingBuilder);
    }
    j = await prisma.ingestJob.findFirst({ where: { accountId: manager.accountId } });
    expect(j.status).toBe('failed');
    expect(j.error).toContain('boom');
  });

  test('recoverStaleJobs requeues a job stuck in processing', async () => {
    const stale = await makeJob({ status: 'processing', startedAt: new Date(Date.now() - 10 * 60 * 1000), attempts: 1 });
    const n = await worker.recoverStaleJobs();
    expect(n).toBeGreaterThanOrEqual(1);
    const j = await prisma.ingestJob.findUnique({ where: { id: stale.id } });
    expect(j.status).toBe('queued');
  });
});

export {};
