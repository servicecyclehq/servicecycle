/**
 * #6 email-in webhook (routes/inboundEmail.ts).
 *
 * Covers the parts this session shipped without coverage: shared-secret auth
 * (accept + reject), to-address -> account routing, attachment -> auto-commit
 * IngestJob fan-out, and the auto-acknowledgement to the sender (including the
 * no-reply / mail-loop suppression). Resend/Svix signature path is exercised
 * indirectly (we use the shared-secret path, which is the simulation path the
 * route documents).
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let emailMock: any;
let manager: TestUser;
let siteId: string;

const SECRET = 'test-inbound-secret-value';
const SLUG = 'acmeco';

const pdfAttachment = (filename = 'report.pdf') => ({
  filename,
  content_type: 'application/pdf',
  content: Buffer.from('%PDF-1.4 test report').toString('base64'),
});

beforeAll(async () => {
  process.env.INBOUND_WEBHOOK_SECRET = SECRET;
  // Force the shared-secret path (no Svix signature on our test requests).
  delete process.env.RESEND_WEBHOOK_SECRET;
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  emailMock = require('../../lib/email');
  manager = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: 'Inbound Site' } });
  siteId = site.id;
  await prisma.accountSetting.create({ data: { accountId: manager.accountId, key: 'inbound_slug', value: SLUG } });
  await prisma.accountSetting.create({ data: { accountId: manager.accountId, key: 'inbound_site_id', value: siteId } });
});

afterAll(async () => {
  const acc = manager.accountId;
  try { await prisma.ingestJob.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.accountSetting.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.user.delete({ where: { id: manager.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  delete process.env.INBOUND_WEBHOOK_SECRET;
  await prisma.$disconnect();
});

beforeEach(() => { emailMock.sendEmail.mockClear(); });

const post = () => request(app).post('/api/inbound/email');

describe('#6 email-in auth', () => {
  test('rejects a request with no/invalid shared secret (401)', async () => {
    const res = await post().send({
      type: 'email.received',
      data: { to: [`reports-${SLUG}@servicecycle.app`], from: 'tech@acme.com', attachments: [pdfAttachment()] },
    });
    expect(res.status).toBe(401);
  });

  test('accepts a valid shared secret and queues an auto-commit job', async () => {
    const res = await post()
      .set('x-inbound-secret', SECRET)
      .send({
        type: 'email.received',
        data: { to: [`reports-${SLUG}@servicecycle.app`], from: 'Jane Tech <jane@acme.com>', attachments: [pdfAttachment()] },
      });
    expect(res.status).toBe(202);
    expect(res.body.jobs).toHaveLength(1);

    const job = await prisma.ingestJob.findUnique({ where: { id: res.body.jobs[0] } });
    expect(job.kind).toBe('email_in');
    expect(job.autoCommit).toBe(true);
    expect(job.siteId).toBe(siteId);
    expect(job.accountId).toBe(manager.accountId);
    expect(job.createdById).toBeNull();
  });
});

describe('#6 email-in routing + ack', () => {
  test('tags the job with the sender for a post-parse ack (no synchronous send)', async () => {
    const res = await post()
      .set('x-inbound-secret', SECRET)
      .send({
        type: 'email.received',
        data: { to: [`reports-${SLUG}@servicecycle.app`], from: 'Jane Tech <jane@acme.com>', attachments: [pdfAttachment()] },
      });
    expect(res.status).toBe(202);
    expect(res.body.willAck).toBe(true);
    // The ack now fires from the worker after parsing+gating, never at receipt.
    expect(emailMock.sendEmail).not.toHaveBeenCalled();
    const job = await prisma.ingestJob.findUnique({ where: { id: res.body.jobs[0] } });
    expect(job.notifyEmail).toBe('jane@acme.com');
    expect(job.batchId).toBeTruthy();
  });

  test('no-reply / loop-prone sender is not tagged for ack, but still ingests', async () => {
    const res = await post()
      .set('x-inbound-secret', SECRET)
      .send({
        type: 'email.received',
        data: { to: [`reports-${SLUG}@servicecycle.app`], from: 'no-reply@vendor.com', attachments: [pdfAttachment()] },
      });
    expect(res.status).toBe(202);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.willAck).toBe(false);
    expect(emailMock.sendEmail).not.toHaveBeenCalled();
    const job = await prisma.ingestJob.findUnique({ where: { id: res.body.jobs[0] } });
    expect(job.notifyEmail).toBeNull();
  });

  test('un-routable to-address is accepted-and-dropped (202, no job)', async () => {
    const res = await post()
      .set('x-inbound-secret', SECRET)
      .send({
        type: 'email.received',
        data: { to: ['reports-nobody@servicecycle.app'], from: 'jane@acme.com', attachments: [pdfAttachment()] },
      });
    expect(res.status).toBe(202);
    expect(res.body.note).toMatch(/no matching inbound account/i);
  });

  test('a message with no usable attachments queues nothing', async () => {
    const res = await post()
      .set('x-inbound-secret', SECRET)
      .send({
        type: 'email.received',
        data: { to: [`reports-${SLUG}@servicecycle.app`], from: 'jane@acme.com', attachments: [{ filename: 'note.txt', content_type: 'text/plain', content: Buffer.from('hi').toString('base64') }] },
      });
    expect(res.status).toBe(202);
    expect(res.body.note).toMatch(/no usable attachments/i);
  });

  test('ignores non-email.received event types', async () => {
    const res = await post()
      .set('x-inbound-secret', SECRET)
      .send({ type: 'email.delivered', data: {} });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe('email.delivered');
  });
});

export {};
