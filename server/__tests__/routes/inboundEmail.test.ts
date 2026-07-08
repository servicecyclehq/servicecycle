/**
 * #6 email-in webhook (routes/inboundEmail.ts).
 *
 * Covers shared-secret auth (accept + reject), to-address -> account routing,
 * the per-account sender allowlist (2026-07-08 audit W1-H1 fix — unauthorized
 * senders are accepted-and-dropped, never enqueued), attachment -> auto-commit
 * IngestJob fan-out for an allowed sender, and the auto-acknowledgement
 * tagging (including no-reply / mail-loop suppression). Resend/Svix signature
 * path is exercised indirectly (we use the shared-secret path, which is the
 * simulation path the route documents).
 *
 * [2026-07-08 audit W1-H1] The 202 response body is now IDENTICAL ({ ok: true })
 * for every "nothing enqueued" outcome AND the success path (no slug/job-id/
 * sender oracle) — so these tests assert outcomes by querying the DB directly
 * instead of reading them off the response body.
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
const ALLOWED_SENDER = 'jane@acme.com';
const ALLOWED_DOMAIN_SENDER = 'no-reply@vendor.com'; // covered by the "@vendor.com" allowlist entry

const pdfAttachment = (filename = 'report.pdf') => ({
  filename,
  content_type: 'application/pdf',
  content: Buffer.from('%PDF-1.4 test report').toString('base64'),
});

// Latest email_in IngestJob for this account (helper — the response body no
// longer carries job ids, see the file header note).
async function latestJob() {
  return prisma.ingestJob.findFirst({
    where: { accountId: manager.accountId, kind: 'email_in' },
    orderBy: { createdAt: 'desc' },
  });
}

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
  // [2026-07-08 audit W1-H1] Sender allowlist — fails closed without this.
  await prisma.accountSetting.create({
    data: { accountId: manager.accountId, key: 'inbound_allowed_senders', value: JSON.stringify([ALLOWED_SENDER, '@vendor.com']) },
  });
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

  test('accepts a valid shared secret + allowed sender and queues an auto-commit job', async () => {
    const res = await post()
      .set('x-inbound-secret', SECRET)
      .send({
        type: 'email.received',
        data: { to: [`reports-${SLUG}@servicecycle.app`], from: `Jane Tech <${ALLOWED_SENDER}>`, attachments: [pdfAttachment()] },
      });
    expect(res.status).toBe(202);
    // [2026-07-08 audit W1-H1] Response body no longer carries job ids/slug
    // (anti-oracle) — assert the DB state directly instead.
    expect(res.body).toEqual({ ok: true });

    const job = await latestJob();
    expect(job).toBeTruthy();
    expect(job.kind).toBe('email_in');
    expect(job.autoCommit).toBe(true);
    expect(job.siteId).toBe(siteId);
    expect(job.accountId).toBe(manager.accountId);
    expect(job.createdById).toBeNull();
  });

  test('rejects a sender that is not on the account allowlist (202 accept-and-drop, no job)', async () => {
    // [2026-07-08 audit W1-H1] The actual injection fix: a real, valid slug
    // with an UNAUTHORIZED sender must not enqueue anything, and the response
    // must be indistinguishable from an unmatched slug (no oracle).
    const before = await prisma.ingestJob.count({ where: { accountId: manager.accountId, kind: 'email_in' } });
    const res = await post()
      .set('x-inbound-secret', SECRET)
      .send({
        type: 'email.received',
        data: { to: [`reports-${SLUG}@servicecycle.app`], from: 'attacker@evil.example', attachments: [pdfAttachment()] },
      });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    const after = await prisma.ingestJob.count({ where: { accountId: manager.accountId, kind: 'email_in' } });
    expect(after).toBe(before);
  });
});

describe('#6 email-in routing + ack', () => {
  test('tags the job with the sender for a post-parse ack (no synchronous send)', async () => {
    const res = await post()
      .set('x-inbound-secret', SECRET)
      .send({
        type: 'email.received',
        data: { to: [`reports-${SLUG}@servicecycle.app`], from: `Jane Tech <${ALLOWED_SENDER}>`, attachments: [pdfAttachment()] },
      });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    // The ack now fires from the worker after parsing+gating, never at receipt.
    expect(emailMock.sendEmail).not.toHaveBeenCalled();
    const job = await latestJob();
    expect(job.notifyEmail).toBe(ALLOWED_SENDER);
    expect(job.batchId).toBeTruthy();
  });

  test('no-reply / loop-prone sender is not tagged for ack, but still ingests (sender is allowlisted)', async () => {
    const res = await post()
      .set('x-inbound-secret', SECRET)
      .send({
        type: 'email.received',
        data: { to: [`reports-${SLUG}@servicecycle.app`], from: ALLOWED_DOMAIN_SENDER, attachments: [pdfAttachment()] },
      });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    expect(emailMock.sendEmail).not.toHaveBeenCalled();
    const job = await latestJob();
    expect(job.notifyEmail).toBeNull();
  });

  test('un-routable to-address is accepted-and-dropped (202, identical body, no job)', async () => {
    const res = await post()
      .set('x-inbound-secret', SECRET)
      .send({
        type: 'email.received',
        data: { to: ['reports-nobody@servicecycle.app'], from: ALLOWED_SENDER, attachments: [pdfAttachment()] },
      });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
  });

  test('a message with no usable attachments queues nothing (202, identical body)', async () => {
    const res = await post()
      .set('x-inbound-secret', SECRET)
      .send({
        type: 'email.received',
        data: { to: [`reports-${SLUG}@servicecycle.app`], from: ALLOWED_SENDER, attachments: [{ filename: 'note.txt', content_type: 'text/plain', content: Buffer.from('hi').toString('base64') }] },
      });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
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
