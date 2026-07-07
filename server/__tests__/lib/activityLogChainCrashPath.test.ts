/**
 * Regression test — 2026-07-06/07 overnight cron bug hunt (continuation of
 * [[servicecycle-bughunt-restore-branch-2026-07-06]] / [[servicecycle-batchf-sso-webhook-2026-07-06]]).
 *
 * Both `activityLogChainSettle` (every 30s) and `activityLogChainVerify`
 * (daily 03:45 UTC) in index.ts wrap lib/activityLogChain.ts's
 * settleAllPending()/verifyAllChains() in a bare `try { ... } catch (e) {
 * console.error(...) }` — the exact "fallback-masks-capture" shape that hid
 * the qemwAlerts/deficiencyAlerts/arcFlashIntegrity/standardRevisionCron
 * crashes and the restoreTest gunzip/model-name bugs earlier this session.
 * The only pre-existing coverage of these two functions
 * (scripts/activity-log-chain.test.js) runs entirely against an in-memory
 * MOCKED Prisma object, never a real Postgres database — so, like those
 * other crons, the cron's OWN query shape against a real schema had never
 * actually been exercised.
 *
 * This test creates real ActivityLog rows (both a normal per-account chain
 * AND the nullable-accountId "global" chain used for e.g. login_failed
 * events on an unknown email) and calls settleAllPending()/verifyAllChains()
 * exactly as the two crons do, against the real local test Postgres.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let prisma: any;
let admin: TestUser;
let rowIds: string[] = [];

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
});

afterAll(async () => {
  await prisma.activityLog.deleteMany({ where: { id: { in: rowIds } } });
  // Sweep any audit_chain_break rows the verifier may have written for this account.
  await prisma.activityLog.deleteMany({ where: { accountId: admin.accountId, action: 'audit_chain_break' } });
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: admin.accountId } }); } catch {}
  await prisma.$disconnect();
});

test('settleAllPending() + verifyAllChains(): completes end-to-end on a real per-account chain with unsettled rows, matching the cron wrapper contract', async () => {
  const { settleAllPending, verifyAllChains } = require('../../lib/activityLogChain');

  // Real unsettled rows (rowHash defaults to NULL) — the exact condition
  // settleAllPending()'s `where: { rowHash: null }` query targets.
  const rows = await Promise.all([
    prisma.activityLog.create({ data: { accountId: admin.accountId, action: 'asset_created', details: { note: 'row1' } } }),
    prisma.activityLog.create({ data: { accountId: admin.accountId, action: 'condition_changed', details: { note: 'row2' } } }),
    prisma.activityLog.create({ data: { accountId: admin.accountId, action: 'work_order_completed', details: { note: 'row3' } } }),
  ]);
  rowIds.push(...rows.map(r => r.id));

  // Mirror the activityLogChainSettle cron wrapper exactly:
  //   const results = await settleAllPending(prisma);
  //   const total = results.reduce((s, r) => s + (r.settled || 0), 0);
  const results = await settleAllPending(prisma);
  const total = results.reduce((s: number, r: any) => s + (r.settled || 0), 0);
  expect(total).toBeGreaterThanOrEqual(3);

  const settledRows = await prisma.activityLog.findMany({ where: { id: { in: rows.map(r => r.id) } } });
  expect(settledRows.every((r: any) => r.rowHash)).toBe(true);

  // Mirror the activityLogChainVerify cron wrapper exactly:
  //   const { summary } = await verifyAllChains(prisma);
  //   console.log(`... ${summary.accountsChecked} accounts, ${summary.totalRowsChecked} rows, ${summary.totalBreaks} break(s) ...`)
  const { summary } = await verifyAllChains(prisma);
  expect(summary.accountsChecked).toBeGreaterThanOrEqual(1);
  expect(summary.totalRowsChecked).toBeGreaterThanOrEqual(3);
  expect(summary.totalBreaks).toBe(0);
  expect(summary.accountsBroken).toBe(0);
  expect(summary.verifiedAt).toBeTruthy();
});

test('settleAllPending() + verifyAllChains(): the nullable-accountId global chain (e.g. login_failed on an unknown email) does not crash either cron', async () => {
  const { settleAllPending, verifyAllChains } = require('../../lib/activityLogChain');

  const globalRow = await prisma.activityLog.create({
    data: { accountId: null, action: 'login_failed', details: { email: 'unknown@test.invalid' } },
  });
  rowIds.push(globalRow.id);

  const results = await settleAllPending(prisma);
  expect(Array.isArray(results)).toBe(true);
  const total = results.reduce((s: number, r: any) => s + (r.settled || 0), 0);
  expect(total).toBeGreaterThanOrEqual(1);

  const settled = await prisma.activityLog.findUnique({ where: { id: globalRow.id } });
  expect(settled.rowHash).toBeTruthy();

  const { summary } = await verifyAllChains(prisma);
  expect(summary.totalBreaks).toBe(0);
});

export {};
