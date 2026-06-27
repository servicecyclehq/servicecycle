'use strict';

/**
 * INFOSEC-8-4 — the shared activity-log writer must persist the source IP.
 *
 * ActivityLog has no dedicated ipAddress column (Json `details` only), so the
 * writer folds an optional `ipAddress` param into details.ip. This test mocks
 * the prisma client so we can capture the exact `data` handed to
 * activityLog.create and assert:
 *   - ipAddress is written to details.ip (and is backward compatible: omitting
 *     it writes exactly as before),
 *   - an existing details.ip is never clobbered,
 *   - the signature change is additive (existing callers unaffected).
 */

// Capture create() payloads. We mock '../lib/prisma.ts' WITH the explicit .ts
// extension on purpose: the unit project's moduleNameMapper
// ('^(\.{1,2}/.*)/prisma$' -> global no-op stub) matches the extensionless
// '../lib/prisma' and would redirect our factory to the stub, while
// activityLog.ts's own "./prisma" import (which the regex does NOT match) loads
// the real client. Mocking the explicit '.ts' path dodges the mapper and
// registers against the exact module activityLog.ts resolves to.
const created = [];
jest.mock('../lib/prisma.ts', () => {
  const client = {
    activityLog: {
      create: async ({ data }) => { created.push(data); return data; },
    },
  };
  return { __esModule: true, default: client, ...client };
});

const { writeLog } = require('../lib/activityLog.ts');

beforeEach(() => { created.length = 0; });

// writeLog is fire-and-forget (awaitable). Await so the create resolves.
describe('activityLog writeLog ipAddress (INFOSEC-8-4)', () => {
  test('folds ipAddress into details.ip', async () => {
    await writeLog({ userId: 'u1', accountId: 'a1', action: 'user_reactivated', ipAddress: '203.0.113.7' });
    expect(created).toHaveLength(1);
    expect(created[0].details).toEqual({ ip: '203.0.113.7' });
    expect(created[0].action).toBe('user_reactivated');
  });

  test('merges ipAddress alongside existing details', async () => {
    await writeLog({ userId: 'u1', action: 'sessions_revoked', details: { targetUserId: 'u2' }, ipAddress: '198.51.100.4' });
    expect(created[0].details).toEqual({ targetUserId: 'u2', ip: '198.51.100.4' });
  });

  test('does not clobber an ip already present in details', async () => {
    await writeLog({ userId: 'u1', action: 'login_failed', details: { ip: 'already-set' }, ipAddress: '10.0.0.1' });
    expect(created[0].details.ip).toBe('already-set');
  });

  test('backward compatible: no ipAddress writes details unchanged', async () => {
    await writeLog({ userId: 'u1', action: 'user_role_changed', details: { oldRole: 'viewer' } });
    expect(created[0].details).toEqual({ oldRole: 'viewer' });
  });

  test('no details and no ipAddress writes undefined details (unchanged behaviour)', async () => {
    await writeLog({ userId: 'u1', action: 'login_success' });
    expect(created[0].details).toBeUndefined();
  });
});
