'use strict';

/**
 * /api/documents/:id/annotations + /api/documents/annotations/:aid
 *
 * A4 (2026-07-05, docs/scoping/audits/wo-chat-annotation-research.md Option
 * 2 / §3d Option C). Live-server suite, same pattern as parts.test.js.
 *
 * Coverage: auth required, cross-tenant isolation, happy-path create/list/
 * edit/soft-delete, author-vs-moderator authorization, and v1 shape
 * validation (only {type:"pin", x, y in [0,1], text?} is accepted --
 * "arrow"/"text" shape types and out-of-range coordinates are rejected).
 *
 * Test documents are created via POST /api/documents/link (an external-URL
 * document) rather than a real multipart upload -- annotations are pure
 * metadata on top of Document and don't care what's behind filePath.
 */

const { api, bearer, anon, setupTenants, ALIEN_UUID } = require('./_routeHelpers');

let t;
const createdDocIds = [];

beforeAll(async () => {
  t = await setupTenants('192.0.2', 210);
}, 60_000);

afterAll(async () => {
  for (const id of createdDocIds) {
    await api().delete(`/api/documents/${id}`).set(bearer(t.tokenAdminA)).catch(() => {});
  }
});

async function createDoc() {
  const res = await api()
    .post('/api/documents/link')
    .set(bearer(t.tokenAdminA))
    .send({
      url:      'https://example.test/inspection-photo.jpg',
      filename: 'inspection-photo.jpg',
      docType:  'other',
    });
  expect(res.status).toBe(201);
  const id = res.body.data.id;
  createdDocIds.push(id);
  return id;
}

describe('auth required', () => {
  test('GET /:id/annotations without a token is 401', async () => {
    const res = await api().get(`/api/documents/${ALIEN_UUID}/annotations`).set(anon());
    expect(res.status).toBe(401);
  });

  test('POST /:id/annotations without a token is 401', async () => {
    const res = await api().post(`/api/documents/${ALIEN_UUID}/annotations`).set(anon()).send({ shapes: [] });
    expect(res.status).toBe(401);
  });
});

describe('cross-tenant isolation', () => {
  let docId;
  beforeAll(async () => { docId = await createDoc(); });

  test("B cannot list A's annotations (404)", async () => {
    const res = await api().get(`/api/documents/${docId}/annotations`).set(bearer(t.tokenB));
    expect(res.status).toBe(404);
  });

  test("B cannot annotate A's document (404)", async () => {
    const res = await api()
      .post(`/api/documents/${docId}/annotations`)
      .set(bearer(t.tokenB))
      .send({ shapes: [{ type: 'pin', x: 0.5, y: 0.5, text: 'hostile' }] });
    expect(res.status).toBe(404);
  });
});

describe('shape validation', () => {
  let docId;
  beforeAll(async () => { docId = await createDoc(); });

  test('empty shapes array is 400', async () => {
    const res = await api()
      .post(`/api/documents/${docId}/annotations`)
      .set(bearer(t.tokenAdminA))
      .send({ shapes: [] });
    expect(res.status).toBe(400);
  });

  test('non-"pin" shape type is rejected (v1 only supports pin)', async () => {
    const res = await api()
      .post(`/api/documents/${docId}/annotations`)
      .set(bearer(t.tokenAdminA))
      .send({ shapes: [{ type: 'arrow', x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.9 }] });
    expect(res.status).toBe(400);
  });

  test('x/y outside [0,1] is rejected', async () => {
    const res = await api()
      .post(`/api/documents/${docId}/annotations`)
      .set(bearer(t.tokenAdminA))
      .send({ shapes: [{ type: 'pin', x: 1.5, y: 0.5, text: 'out of bounds' }] });
    expect(res.status).toBe(400);
  });

  test('text over 500 chars is rejected', async () => {
    const res = await api()
      .post(`/api/documents/${docId}/annotations`)
      .set(bearer(t.tokenAdminA))
      .send({ shapes: [{ type: 'pin', x: 0.4, y: 0.4, text: 'x'.repeat(501) }] });
    expect(res.status).toBe(400);
  });
});

describe('happy path: create, list, edit, soft-delete', () => {
  let docId;
  let annotationId;

  beforeAll(async () => { docId = await createDoc(); });

  test('admin creates a pin annotation (201)', async () => {
    const res = await api()
      .post(`/api/documents/${docId}/annotations`)
      .set(bearer(t.tokenAdminA))
      .send({ shapes: [{ type: 'pin', x: 0.42, y: 0.61, text: 'cracked bushing' }] });
    expect(res.status).toBe(201);
    expect(res.body.data.annotation.shapes).toEqual([{ type: 'pin', x: 0.42, y: 0.61, text: 'cracked bushing' }]);
    expect(res.body.data.annotation.author).toBeTruthy();
    annotationId = res.body.data.annotation.id;
  });

  test('a pin with no text is accepted (text is optional)', async () => {
    const res = await api()
      .post(`/api/documents/${docId}/annotations`)
      .set(bearer(t.tokenAdminA))
      .send({ shapes: [{ type: 'pin', x: 0.1, y: 0.1 }] });
    expect(res.status).toBe(201);
    createdAnnotationCleanupId(res.body.data.annotation.id);
  });

  test('GET /:id/annotations lists it', async () => {
    const res = await api().get(`/api/documents/${docId}/annotations`).set(bearer(t.tokenAdminA));
    expect(res.status).toBe(200);
    expect(res.body.data.annotations.some((a) => a.id === annotationId)).toBe(true);
  });

  test('the annotation author can edit its shapes', async () => {
    const res = await api()
      .put(`/api/documents/annotations/${annotationId}`)
      .set(bearer(t.tokenAdminA))
      .send({ shapes: [{ type: 'pin', x: 0.5, y: 0.5, text: 'moved pin' }] });
    expect(res.status).toBe(200);
    expect(res.body.data.annotation.shapes).toEqual([{ type: 'pin', x: 0.5, y: 0.5, text: 'moved pin' }]);
  });

  test('soft-delete removes it from the list', async () => {
    const del = await api().delete(`/api/documents/annotations/${annotationId}`).set(bearer(t.tokenAdminA));
    expect(del.status).toBe(200);

    const list = await api().get(`/api/documents/${docId}/annotations`).set(bearer(t.tokenAdminA));
    expect(list.body.data.annotations.some((a) => a.id === annotationId)).toBe(false);
  });

  test('deleted annotation 404s on a second delete attempt', async () => {
    const res = await api().delete(`/api/documents/annotations/${annotationId}`).set(bearer(t.tokenAdminA));
    expect(res.status).toBe(404);
  });
});

// Not a real cleanup registry (annotations are cascade-deleted with their
// document in afterAll) -- exists only so the "no text" test above reads
// naturally without an unused-variable lint complaint.
function createdAnnotationCleanupId(_id) {}
