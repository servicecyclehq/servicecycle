/**
 * Confidence-gated ingest: the gate decision, the worker park-vs-commit split,
 * the review queue (list/approve/reject + role + tenancy), and the post-parse
 * acknowledgement aggregation. Builders are injected so no Python/PDF is needed.
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const { evaluateIngestGate } = require('../../lib/ingestConfidenceGate');

let app: any;
let prisma: any;
let worker: any;
let ack: any;
let emailMock: any;
let manager: TestUser;
let viewer: TestUser;
let other: TestUser;
let admin: TestUser;
let siteId: string;
let fileKey: string;

// A clean, high-confidence deterministic preview — should sail through green.
const greenPreview = () => ({
  meta: { model: 'Switchgear X', manufacturer: 'ABB', serialNumber: 'SN-100', testDate: '2026-01-01' },
  measurements: [{ measurementType: 'insulation_resistance', asFoundValue: 1200, asFoundUnit: 'MΩ', passFail: 'GREEN', confidence: 0.96 }],
  assetMatch: null, assetCandidates: [], assetSections: 1, source: 'pdfplumber', ocr: false,
});

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  worker = require('../../lib/ingestWorker');
  ack = require('../../lib/ingestAck');
  emailMock = require('../../lib/email');
  manager = await createTestUser('manager');
  viewer = await createTestUser('viewer');
  other = await createTestUser('manager');
  admin = await createTestUser('admin');
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: 'Gate Site' } });
  siteId = site.id;
  const { uploadFile } = require('../../lib/storage');
  const up = await uploadFile(manager.accountId, null, 'gate.pdf', Buffer.from('%PDF-1.4 hi'), 'application/pdf');
  fileKey = up.storageKey;
});

afterAll(async () => {
  for (const u of [manager, viewer, other, admin]) {
    const acc = u.accountId;
    try { await prisma.accountSetting.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.activityLog.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.testMeasurement.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.workOrder.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.ingestJob.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

const auth = (u: TestUser) => `Bearer ${u.token}`;

// Clear committed data in FK order (measurements/deficiencies/work orders
// reference assets) so a beforeEach reset doesn't trip the asset FK.
async function wipe() {
  await prisma.testMeasurement.deleteMany({ where: { accountId: manager.accountId } });
  await prisma.deficiency.deleteMany({ where: { accountId: manager.accountId } });
  await prisma.workOrder.deleteMany({ where: { accountId: manager.accountId } });
  await prisma.asset.deleteMany({ where: { accountId: manager.accountId } });
  await prisma.ingestJob.deleteMany({ where: { accountId: manager.accountId } });
}

// ── Gate (pure) ──────────────────────────────────────────────────────────────
describe('confidence gate', () => {
  test('clean deterministic report auto-commits (green)', () => {
    const g = evaluateIngestGate(greenPreview(), {});
    expect(g.autoCommit).toBe(true);
    expect(g.band).toBe('green');
  });

  test('a low-confidence reading parks for review (yellow)', () => {
    const p = greenPreview(); p.measurements[0].confidence = 0.4;
    const g = evaluateIngestGate(p, {});
    expect(g.autoCommit).toBe(false);
    expect(g.band).toBe('yellow');
  });

  test('OCR / photo source parks for review (red)', () => {
    const p: any = greenPreview(); p.ocr = true;
    const g = evaluateIngestGate(p, {});
    expect(g.autoCommit).toBe(false);
    expect(g.band).toBe('red');
  });

  test('a medium-confidence match to an existing asset parks for review', () => {
    const p: any = greenPreview();
    p.assetMatch = { id: 'some-id', label: 'Unit 1', confidence: 'medium' };
    const g = evaluateIngestGate(p, {});
    expect(g.autoCommit).toBe(false);
  });

  test('a possible duplicate (candidates present on a new asset) parks for review', () => {
    const p: any = greenPreview();
    p.assetCandidates = [{ id: 'x', label: 'Maybe Dup', confidence: 'medium' }];
    const g = evaluateIngestGate(p, {});
    expect(g.autoCommit).toBe(false);
  });

  test('loosening the threshold lets a borderline reading through', () => {
    const p = greenPreview(); p.measurements[0].confidence = 0.7;
    expect(evaluateIngestGate(p, { threshold: 0.85 }).autoCommit).toBe(false);
    expect(evaluateIngestGate(p, { threshold: 0.6 }).autoCommit).toBe(true);
  });
});

// ── Worker park-vs-commit ────────────────────────────────────────────────────
describe('worker gating', () => {
  beforeEach(wipe);

  const mkJob = (over: any = {}) => prisma.ingestJob.create({
    data: { accountId: manager.accountId, createdById: null, kind: 'backfill', status: 'queued', fileKey, fileName: 'gate.pdf', autoCommit: true, siteId, ...over },
  });

  test('green report auto-commits to asset cards', async () => {
    const job = await mkJob();
    await worker.processNextIngestJob(async () => greenPreview());
    const done = await prisma.ingestJob.findUnique({ where: { id: job.id } });
    expect(done.status).toBe('done');
    expect((done.result as any).autoCommitted.assetsCommitted).toBeGreaterThanOrEqual(1);
    const assets = await prisma.asset.count({ where: { accountId: manager.accountId } });
    expect(assets).toBeGreaterThanOrEqual(1);
  });

  test('low-confidence report parks as needs_review and writes NO assets', async () => {
    const job = await mkJob();
    const lowConf = () => { const p = greenPreview(); p.measurements[0].confidence = 0.3; return p; };
    await worker.processNextIngestJob(async () => lowConf());
    const parked = await prisma.ingestJob.findUnique({ where: { id: job.id } });
    expect(parked.status).toBe('needs_review');
    expect((parked.gate as any).band).toBe('yellow');
    const assets = await prisma.asset.count({ where: { accountId: manager.accountId } });
    expect(assets).toBe(0);
  });
});

// ── Review API ───────────────────────────────────────────────────────────────
describe('review queue', () => {
  const mkParked = (over: any = {}) => prisma.ingestJob.create({
    data: {
      accountId: manager.accountId, createdById: null, kind: 'email_in', status: 'needs_review',
      fileKey, fileName: 'parked.pdf', autoCommit: true, siteId,
      result: greenPreview(), gate: { band: 'yellow', autoCommit: false, reasons: ['needs a look'], units: [] },
      ...over,
    },
  });

  beforeEach(wipe);

  test('lists pending items for managers, scoped to the account', async () => {
    await mkParked();
    const mine = await request(app).get('/api/ingest/review').set('Authorization', auth(manager));
    expect(mine.status).toBe(200);
    expect(mine.body.data.count).toBe(1);
    const theirs = await request(app).get('/api/ingest/review').set('Authorization', auth(other));
    expect(theirs.body.data.count).toBe(0);
  });

  test('viewers cannot access the review queue', async () => {
    const res = await request(app).get('/api/ingest/review').set('Authorization', auth(viewer));
    expect(res.status).toBe(403);
  });

  test('approve commits the parked report and records who did it', async () => {
    const job = await mkParked();
    const res = await request(app).post(`/api/ingest/review/${job.id}/approve`).set('Authorization', auth(manager)).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.committed.assetsCommitted).toBeGreaterThanOrEqual(1);
    const after = await prisma.ingestJob.findUnique({ where: { id: job.id } });
    expect(after.status).toBe('done');
    expect(after.reviewedById).toBe(manager.id);
    const log = await prisma.activityLog.findFirst({ where: { accountId: manager.accountId, action: 'ingest_review_approved' } });
    expect(log).toBeTruthy();
    const assets = await prisma.asset.count({ where: { accountId: manager.accountId } });
    expect(assets).toBeGreaterThanOrEqual(1);
  });

  test('reject discards it with no assets written', async () => {
    const job = await mkParked();
    const res = await request(app).post(`/api/ingest/review/${job.id}/reject`).set('Authorization', auth(manager)).send({ note: 'junk' });
    expect(res.status).toBe(200);
    const after = await prisma.ingestJob.findUnique({ where: { id: job.id } });
    expect(after.status).toBe('rejected');
    expect(after.reviewedById).toBe(manager.id);
    const assets = await prisma.asset.count({ where: { accountId: manager.accountId } });
    expect(assets).toBe(0);
  });

  test('bulk-approve commits several and reports the total', async () => {
    await mkParked(); await mkParked();
    const ids = (await prisma.ingestJob.findMany({ where: { accountId: manager.accountId, status: 'needs_review' }, select: { id: true } })).map((j: any) => j.id);
    const res = await request(app).post('/api/ingest/review/bulk-approve').set('Authorization', auth(manager)).send({ jobIds: ids });
    expect(res.status).toBe(200);
    expect(res.body.data.approved).toBe(2);
    expect(res.body.data.assetsCommitted).toBeGreaterThanOrEqual(2);
  });
});

// ── Threshold knob + readout ─────────────────────────────────────────────────
describe('review settings', () => {
  test('manager can read the threshold + 30-day readout', async () => {
    const res = await request(app).get('/api/ingest/review/settings').set('Authorization', auth(manager));
    expect(res.status).toBe(200);
    expect(typeof res.body.data.threshold).toBe('number');
    expect(res.body.data.stats).toHaveProperty('autoAdded');
    expect(res.body.data.canEdit).toBe(false); // manager is not admin
  });

  test('admin can set the threshold and it round-trips', async () => {
    const put = await request(app).put('/api/ingest/review/settings').set('Authorization', auth(admin)).send({ threshold: 0.7 });
    expect(put.status).toBe(200);
    expect(put.body.data.threshold).toBeCloseTo(0.7, 5);
    const get = await request(app).get('/api/ingest/review/settings').set('Authorization', auth(admin));
    expect(get.body.data.threshold).toBeCloseTo(0.7, 5);
    expect(get.body.data.canEdit).toBe(true);
  });

  test('a non-admin cannot change the threshold', async () => {
    const res = await request(app).put('/api/ingest/review/settings').set('Authorization', auth(manager)).send({ threshold: 0.5 });
    expect(res.status).toBe(403);
  });
});

// ── Post-parse ack ───────────────────────────────────────────────────────────
describe('post-parse acknowledgement', () => {
  beforeEach(async () => {
    await prisma.ingestJob.deleteMany({ where: { accountId: manager.accountId } });
    emailMock.sendEmail.mockClear();
  });

  test('sends the "needs review" template once when something is parked', async () => {
    const batchId = 'batch-needs-review';
    await prisma.ingestJob.create({ data: { accountId: manager.accountId, kind: 'email_in', status: 'done', fileKey, fileName: 'a.pdf', autoCommit: true, siteId, notifyEmail: 'tech@acme.com', batchId, result: { autoCommitted: { assetsCommitted: 1 } } } });
    const parked = await prisma.ingestJob.create({ data: { accountId: manager.accountId, kind: 'email_in', status: 'needs_review', fileKey, fileName: 'b.pdf', autoCommit: true, siteId, notifyEmail: 'tech@acme.com', batchId } });
    await ack.maybeSendInboundAck(parked);
    expect(emailMock.sendEmail).toHaveBeenCalledTimes(1);
    expect(emailMock.sendEmail.mock.calls[0][0].to).toBe('tech@acme.com');
    expect(emailMock.reportNeedsReviewHtml).toHaveBeenCalled();
    // A second call (another tick) must NOT re-send.
    await ack.maybeSendInboundAck(parked);
    expect(emailMock.sendEmail).toHaveBeenCalledTimes(1);
  });

  test('waits while jobs in the batch are still in flight', async () => {
    const batchId = 'batch-inflight';
    const a = await prisma.ingestJob.create({ data: { accountId: manager.accountId, kind: 'email_in', status: 'done', fileKey, fileName: 'a.pdf', autoCommit: true, siteId, notifyEmail: 'x@y.com', batchId, result: { autoCommitted: { assetsCommitted: 1 } } } });
    await prisma.ingestJob.create({ data: { accountId: manager.accountId, kind: 'email_in', status: 'processing', fileKey, fileName: 'b.pdf', autoCommit: true, siteId, notifyEmail: 'x@y.com', batchId } });
    await ack.maybeSendInboundAck(a);
    expect(emailMock.sendEmail).not.toHaveBeenCalled();
  });

  test('no-reply batch (null notifyEmail) sends nothing', async () => {
    const batchId = 'batch-noreply';
    const a = await prisma.ingestJob.create({ data: { accountId: manager.accountId, kind: 'email_in', status: 'done', fileKey, fileName: 'a.pdf', autoCommit: true, siteId, notifyEmail: null, batchId, result: { autoCommitted: { assetsCommitted: 1 } } } });
    await ack.maybeSendInboundAck(a);
    expect(emailMock.sendEmail).not.toHaveBeenCalled();
  });
});

export {};
