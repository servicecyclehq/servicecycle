/**
 * Unit tests for lib/scim — replays the LIVE-captured Polis webhook deliveries
 * (server/__tests__/fixtures/polis/webhook_deliveries.json) to prove the
 * signature verification and event normalization against real bytes.
 * Pure (no DB/server); runs in the esbuild "unit" jest project.
 */
const fs = require('fs');
const path = require('path');
const {
  parseSignatureHeader, verifyScimSignature, isFreshTimestamp,
  computeEventKey, normalizeScimEvent, toEventList,
} = require('../lib/scim');

const FIXTURE_SECRET = 'fixture-webhook-secret'; // the secret used during capture
const deliveries = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../__tests__/fixtures/polis/webhook_deliveries.json'), 'utf8')
);

describe('verifyScimSignature against real captured deliveries', () => {
  test('fixtures are present', () => { expect(deliveries.length).toBeGreaterThanOrEqual(5); });

  test('every captured delivery verifies with the correct secret', () => {
    for (const d of deliveries) {
      const { valid } = verifyScimSignature(d.rawBody, d.signatureHeader, FIXTURE_SECRET);
      expect(valid).toBe(true);
    }
  });

  test('wrong secret fails closed', () => {
    const d = deliveries[0];
    expect(verifyScimSignature(d.rawBody, d.signatureHeader, 'wrong-secret').valid).toBe(false);
  });

  test('tampered body fails (signature over raw body)', () => {
    const d = deliveries[0];
    expect(verifyScimSignature(d.rawBody + ' ', d.signatureHeader, FIXTURE_SECRET).valid).toBe(false);
  });

  test('missing/garbage header fails closed', () => {
    expect(verifyScimSignature(deliveries[0].rawBody, '', FIXTURE_SECRET).valid).toBe(false);
    expect(verifyScimSignature(deliveries[0].rawBody, 'nonsense', FIXTURE_SECRET).valid).toBe(false);
    expect(verifyScimSignature(deliveries[0].rawBody, deliveries[0].signatureHeader, '').valid).toBe(false);
  });

  test('parseSignatureHeader extracts t and s', () => {
    const p = parseSignatureHeader(deliveries[0].signatureHeader);
    expect(p).not.toBeNull();
    expect(typeof p.t).toBe('number');
    expect(p.s).toMatch(/^[a-f0-9]+$/);
  });
});

describe('isFreshTimestamp', () => {
  test('disabled tolerance always fresh', () => { expect(isFreshTimestamp(1, 0)).toBe(true); });
  test('now is fresh within window', () => { expect(isFreshTimestamp(Date.now(), 60000)).toBe(true); });
  test('old timestamp rejected within window', () => { expect(isFreshTimestamp(Date.now() - 10 * 60000, 60000)).toBe(false); });
  test('null timestamp rejected when window enforced', () => { expect(isFreshTimestamp(null, 60000)).toBe(false); });
});

describe('normalizeScimEvent against real captured events', () => {
  const byType = {};
  for (const d of deliveries) {
    const ev = JSON.parse(d.rawBody);
    byType[ev.event] = byType[ev.event] || ev;
  }

  test('user.created -> active user, externalId from raw, stable scimUserId', () => {
    const n = normalizeScimEvent(byType['user.created']);
    expect(n.kind).toBe('user');
    expect(n.active).toBe(true);
    expect(n.email).toBe('jackson@example.com');
    expect(n.firstName).toBe('SAML');
    expect(n.scimUserId).toBeTruthy();
    expect(n.externalId).toBe('00u1abcdEXTERNALID'); // from data.raw.externalId
  });

  test('deactivation arrives as user.updated active:false (KEY finding)', () => {
    // find the user.updated with active false
    const deact = deliveries.map((d) => JSON.parse(d.rawBody))
      .find((e) => e.event === 'user.updated' && e.data.active === false);
    expect(deact).toBeTruthy();
    const n = normalizeScimEvent(deact);
    expect(n.kind).toBe('user');
    expect(n.active).toBe(false);
  });

  test('scimUserId is identical across create + updates (upsert key stability)', () => {
    const ids = deliveries.map((d) => JSON.parse(d.rawBody))
      .filter((e) => e.event.startsWith('user.') && e.data && e.data.id)
      .map((e) => normalizeScimEvent(e).scimUserId);
    expect(new Set(ids).size).toBe(1);
  });

  test('group.created normalizes to a group event', () => {
    const n = normalizeScimEvent(byType['group.created']);
    expect(n.kind).toBe('group');
    expect(n.groupName).toBe('Engineering');
    expect(n.groupId).toBeTruthy();
  });

  test('group.user_added carries user + nested group', () => {
    const n = normalizeScimEvent(byType['group.user_added']);
    expect(n.kind).toBe('user');
    expect(n.group).toBeTruthy();
    expect(n.group.name).toBe('Engineering');
  });

  test('unknown event type -> null', () => {
    expect(normalizeScimEvent({ event: 'something.else', data: {} })).toBeNull();
    expect(normalizeScimEvent(null)).toBeNull();
  });
});

describe('computeEventKey + toEventList', () => {
  test('eventKey is deterministic sha256 hex of raw body', () => {
    const k1 = computeEventKey(deliveries[0].rawBody);
    const k2 = computeEventKey(deliveries[0].rawBody);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[a-f0-9]{64}$/);
    expect(computeEventKey(deliveries[1].rawBody)).not.toBe(k1);
  });
  test('toEventList handles single object and array (batch)', () => {
    const one = JSON.parse(deliveries[0].rawBody);
    expect(toEventList(one).length).toBe(1);
    expect(toEventList([one, one]).length).toBe(2);
    expect(toEventList(null).length).toBe(0);
  });
});
