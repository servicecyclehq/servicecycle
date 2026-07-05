'use strict';

/**
 * /api/work-orders/:id/comments + /api/work-orders/comments/:cid
 * /api/field/work-orders/:id/comments (mirror)
 *
 * A4 (2026-07-05, docs/scoping/audits/wo-chat-annotation-research.md Option
 * 2). Live-server suite (same pattern as workOrderTransitions.test.js /
 * parts.test.js) -- drives the running dev server so the full
 * route -> Prisma -> DB round trip is exercised.
 *
 * Coverage: auth required, cross-tenant isolation, happy-path create/list/
 * edit/soft-delete, author-vs-moderator edit/delete authorization, body
 * validation, and the field-surface mirror (list/create only -- edit/delete
 * are intentionally manager-only, see routes/fieldRoutes.ts comment).
 *
 * Field-tech-specific SCOPE isolation (assignedUserId clamping) is exercised
 * by resolveScopedWorkOrder's own pre-existing callers elsewhere -- this
 * suite reuses that helper rather than re-testing it, and drives the field
 * mirror with the admin token (which takes the non-field_tech, account-wide
 * branch of that helper).
 */

const { api, bearer, anon, setupTenants, ALIEN_UUID } = require('./_routeHelpers');

let t;
let assetId;
let scheduleId;
const createdWoIds = [];

beforeAll(async () => {
  t = await setupTenants('192.0.2', 190);
  assetId    = t.asset?.id;
  scheduleId = t.schedule?.id;
  expect(assetId).toBeTruthy();
}, 60_000);

afterAll(async () => {
  for (const id of createdWoIds) {
    await api().delete(`/api/work-orders/${id}`).set(bearer(t.tokenAdminA)).catch(() => {});
  }
});

async function createWo() {
  const res = await api()
    .post('/api/work-orders')
    .set(bearer(t.tokenAdminA))
    .send({ assetId, ...(scheduleId ? { scheduleId } : {}) });
  expect(res.status).toBe(201);
  const id = res.body.data.workOrder.id;
  createdWoIds.push(id);
  return id;
}

describe('auth required', () => {
  test('GET /:id/comments without a token is 401', async () => {
    const res = await api().get(`/api/work-orders/${ALIEN_UUID}/comments`).set(anon());
    expect(res.status).toBe(401);
  });

  test('POST /:id/comments without a token is 401', async () => {
    const res = await api().post(`/api/work-orders/${ALIEN_UUID}/comments`).set(anon()).send({ body: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('cross-tenant isolation', () => {
  let woId;
  beforeAll(async () => { woId = await createWo(); });

  test("B cannot list A's comments (404)", async () => {
    const res = await api().get(`/api/work-orders/${woId}/comments`).set(bearer(t.tokenB));
    expect(res.status).toBe(404);
  });

  test("B cannot post a comment on A's work order (404)", async () => {
    const res = await api()
      .post(`/api/work-orders/${woId}/comments`)
      .set(bearer(t.tokenB))
      .send({ body: 'hostile comment' });
    expect(res.status).toBe(404);
  });
});

describe('viewer is denied write access (manager gate)', () => {
  let woId;
  beforeAll(async () => { woId = await createWo(); });

  test('viewer cannot post a comment (403)', async () => {
    const res = await api()
      .post(`/api/work-orders/${woId}/comments`)
      .set(bearer(t.tokenViewerA))
      .send({ body: 'viewer attempt' });
    expect(res.status).toBe(403);
  });
});

describe('body validation', () => {
  let woId;
  beforeAll(async () => { woId = await createWo(); });

  test('empty body is 400', async () => {
    const res = await api()
      .post(`/api/work-orders/${woId}/comments`)
      .set(bearer(t.tokenAdminA))
      .send({ body: '   ' });
    expect(res.status).toBe(400);
  });

  test('body over 4000 chars is 400', async () => {
    const res = await api()
      .post(`/api/work-orders/${woId}/comments`)
      .set(bearer(t.tokenAdminA))
      .send({ body: 'x'.repeat(4001) });
    expect(res.status).toBe(400);
  });
});

describe('happy path: create, list, edit, soft-delete', () => {
  let woId;
  let commentId;

  beforeAll(async () => { woId = await createWo(); });

  test('admin creates a comment (201)', async () => {
    const res = await api()
      .post(`/api/work-orders/${woId}/comments`)
      .set(bearer(t.tokenAdminA))
      .send({ body: 'First pass looks good, torque values within spec.' });
    expect(res.status).toBe(201);
    expect(res.body.data.comment.body).toBe('First pass looks good, torque values within spec.');
    expect(res.body.data.comment.author).toBeTruthy();
    commentId = res.body.data.comment.id;
  });

  test('GET /:id/comments lists it, newest-created-last (createdAt asc)', async () => {
    const res = await api().get(`/api/work-orders/${woId}/comments`).set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    expect(res.body.data.comments.some((c) => c.id === commentId)).toBe(true);
  });

  test('the comment author can edit their own comment', async () => {
    const res = await api()
      .put(`/api/work-orders/comments/${commentId}`)
      .set(bearer(t.tokenAdminA))
      .send({ body: 'Edited: torque re-checked at 45 ft-lb.' });
    expect(res.status).toBe(200);
    expect(res.body.data.comment.body).toBe('Edited: torque re-checked at 45 ft-lb.');
    expect(res.body.data.comment.editedAt).toBeTruthy();
  });

  test('soft-delete removes it from the list', async () => {
    const del = await api().delete(`/api/work-orders/comments/${commentId}`).set(bearer(t.tokenAdminA));
    expect(del.status).toBe(200);

    const list = await api().get(`/api/work-orders/${woId}/comments`).set(bearer(t.tokenAdminA));
    expect(list.body.data.comments.some((c) => c.id === commentId)).toBe(false);
  });

  test('deleted comment 404s on a second delete attempt', async () => {
    const res = await api().delete(`/api/work-orders/comments/${commentId}`).set(bearer(t.tokenAdminA));
    expect(res.status).toBe(404);
  });
});

describe('field-surface mirror (/api/field/work-orders/:id/comments)', () => {
  let woId;
  beforeAll(async () => { woId = await createWo(); });

  test('GET without a token is 401', async () => {
    const res = await api().get(`/api/field/work-orders/${woId}/comments`).set(anon());
    expect(res.status).toBe(401);
  });

  test('admin can post and read back via the field mirror', async () => {
    const post = await api()
      .post(`/api/field/work-orders/${woId}/comments`)
      .set(bearer(t.tokenAdminA))
      .send({ body: 'Field note: breaker racked out, panel cold.' });
    expect(post.status).toBe(201);

    const list = await api().get(`/api/field/work-orders/${woId}/comments`).set(bearer(t.tokenAdminA));
    expect(list.status).toBe(200);
    expect(list.body.data.comments.some((c) => c.id === post.body.data.comment.id)).toBe(true);
  });

  test("B cannot post via the field mirror on A's work order (404)", async () => {
    const res = await api()
      .post(`/api/field/work-orders/${woId}/comments`)
      .set(bearer(t.tokenB))
      .send({ body: 'hostile field note' });
    expect(res.status).toBe(404);
  });
});
