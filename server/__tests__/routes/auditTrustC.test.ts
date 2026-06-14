/**
 * Cluster C audit-chain trust:
 *  - standalone verifier accepts an intact chain and rejects a tampered one
 *  - the standalone canonical()/computeRowHash() stay identical to the server's
 *    lib/activityLogChain (drift guard)
 *  - a public share-link view writes a share_link_viewed audit event
 */
import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

const verifier = require('../../scripts/verify-audit-chain');
const chain = require('../../lib/activityLogChain');

let app: any;
let prisma: any;
let mgr: TestUser;
let token: string;

function buildChain(rows: any[]): string[] {
  // produce export-shaped NDJSON lines with a correct rowHash chain
  let prev: string | null = null;
  const lines: string[] = [];
  for (const r of rows) {
    const canonRow = { id: r.id, accountId: r.accountId ?? null, assetId: r.assetId ?? null, action: r.action, details: r.details ?? null, createdAt: r.ts };
    const rowHash = verifier.computeRowHash(prev, verifier.canonical(canonRow));
    lines.push(JSON.stringify({ id: r.id, ts: r.ts, action: r.action, accountId: r.accountId ?? null, assetId: r.assetId ?? null, details: r.details ?? null, prevHash: prev, rowHash }));
    prev = rowHash;
  }
  return lines;
}

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  mgr = await createTestUser('manager');
  const t = `tok_${Date.now()}_abcdef1234567890`;
  token = t;
  await prisma.shareLink.create({
    data: { accountId: mgr.accountId, token: t, kind: 'compliance', label: 'Underwriter Test',
            expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) },
  });
});

afterAll(async () => {
  const acc = mgr.accountId;
  try { await prisma.activityLog.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.shareLink.deleteMany({ where: { accountId: acc } }); } catch {}
  try { await prisma.user.delete({ where: { id: mgr.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  await prisma.$disconnect();
});

describe('C1 standalone verifier', () => {
  const rows = [
    { id: 'a', accountId: 'acc1', action: 'login', ts: '2026-06-14T00:00:00.000Z' },
    { id: 'b', accountId: 'acc1', action: 'asset_created', ts: '2026-06-14T00:01:00.000Z', details: { x: 1 } },
    { id: 'c', accountId: 'acc1', action: 'share_link_viewed', ts: '2026-06-14T00:02:00.000Z' },
  ];
  test('accepts an intact chain', () => {
    const r = verifier.verifyLines(buildChain(rows));
    expect(r.ok).toBe(true);
    expect(r.total).toBe(3);
  });
  test('rejects a row whose content was altered', () => {
    const lines = buildChain(rows);
    const o = JSON.parse(lines[1]); o.action = 'TAMPERED'; lines[1] = JSON.stringify(o);
    const r = verifier.verifyLines(lines);
    expect(r.ok).toBe(false);
    expect(r.breaks.length).toBeGreaterThan(0);
  });
});

describe('C / verifier matches server chain algorithm (drift guard)', () => {
  test('canonical + computeRowHash are identical', () => {
    const row = { id: 'x', accountId: 'acc', assetId: null, action: 'login', details: { a: 1 }, createdAt: '2026-06-14T00:00:00.000Z' };
    expect(verifier.canonical(row)).toBe(chain.canonical(row));
    expect(verifier.computeRowHash('prev', verifier.canonical(row)))
      .toBe(chain.computeRowHash('prev', chain.canonical(row)));
  });
});

describe('C2 share-link view is audit-logged', () => {
  test('GET /api/public/share/:token records a share_link_viewed event', async () => {
    const res = await request(app).get(`/api/public/share/${token}`);
    expect(res.status).toBe(200);
    // logging is fire-and-forget; poll briefly
    let found = false;
    for (let i = 0; i < 20 && !found; i++) {
      const n = await prisma.activityLog.count({ where: { accountId: mgr.accountId, action: 'share_link_viewed' } });
      found = n > 0;
      if (!found) await new Promise((r) => setTimeout(r, 50));
    }
    expect(found).toBe(true);
  });
});

describe('C1 verifier — multi-account chains + pending rows', () => {
  // build one account's chain (independent prev) as export lines
  function chainFor(accountId: string, items: any[]): string[] {
    let prev: string | null = null;
    return items.map((r) => {
      const canonRow = { id: r.id, accountId, assetId: null, action: r.action, details: r.details ?? null, createdAt: r.ts };
      const rowHash = verifier.computeRowHash(prev, verifier.canonical(canonRow));
      const line = JSON.stringify({ id: r.id, ts: r.ts, action: r.action, accountId, assetId: null, details: r.details ?? null, prevHash: prev, rowHash });
      prev = rowHash;
      return line;
    });
  }

  test('two interleaved account chains both verify', () => {
    const a = chainFor('accA', [
      { id: 'a1', action: 'login', ts: '2026-06-14T00:00:00.000Z' },
      { id: 'a2', action: 'asset_created', ts: '2026-06-14T00:02:00.000Z' },
    ]);
    const b = chainFor('accB', [
      { id: 'b1', action: 'login', ts: '2026-06-14T00:01:00.000Z' },
      { id: 'b2', action: 'asset_created', ts: '2026-06-14T00:03:00.000Z' },
    ]);
    // interleave in global createdAt order, as a real export would
    const interleaved = [a[0], b[0], a[1], b[1]];
    const r = verifier.verifyLines(interleaved);
    expect(r.ok).toBe(true);
    expect(r.chains).toBe(2);
  });

  test('pending (unsettled, rowHash=null) rows are not breaks', () => {
    const a = chainFor('accA', [{ id: 'a1', action: 'login', ts: '2026-06-14T00:00:00.000Z' }]);
    const pendingLine = JSON.stringify({ id: 'p1', ts: '2026-06-14T00:05:00.000Z', action: 'login', accountId: 'accA', assetId: null, details: null, prevHash: null, rowHash: null });
    const r = verifier.verifyLines([...a, pendingLine]);
    expect(r.ok).toBe(true);
    expect(r.pending).toBe(1);
    expect(r.total).toBe(1);
  });
});

describe('C1 verifier — global (accountId=null) chain slice', () => {
  function globalLine(id: string, ts: string, prev: string | null, action = 'login') {
    const canonRow = { id, accountId: null, assetId: null, action, details: null, createdAt: ts };
    const rowHash = verifier.computeRowHash(prev, verifier.canonical(canonRow));
    return JSON.stringify({ id, ts, action, accountId: null, assetId: null, details: null, prevHash: prev, rowHash });
  }
  test('a gap in the global chain is NOT a break (continuity skipped for the slice)', () => {
    const a = globalLine('g1', '2026-06-14T00:00:00.000Z', null);
    const b = globalLine('g2', '2026-06-14T00:05:00.000Z', 'deadbeefnotlinked'); // prev points at a filtered-out row
    const r = verifier.verifyLines([a, b]);
    expect(r.ok).toBe(true);
  });
  test('a tampered global row IS a break (integrity is still checked)', () => {
    const a = globalLine('g1', '2026-06-14T00:00:00.000Z', null);
    const o = JSON.parse(a); o.action = 'TAMPERED';
    const r = verifier.verifyLines([JSON.stringify(o)]);
    expect(r.ok).toBe(false);
  });
});

export {};