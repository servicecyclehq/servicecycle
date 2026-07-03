'use strict';

/**
 * Tenant-isolation regression (2026-07-03): recordCommit takes a
 * client-supplied extractionId, so the commit-time stamp must be scoped to the
 * committing account. Previously it ran extractionEvent.update({ where: { id }})
 * with no accountId - a valid id belonging to ANOTHER tenant succeeded
 * (cross-tenant write). Now it runs updateMany({ where: { id, accountId } });
 * a foreign id matches zero rows and silently no-ops, and telemetry stays
 * fail-soft (never throws into the commit request).
 *
 * Mocks '../lib/prisma.ts' WITH the explicit .ts extension - see
 * activityLogIp.test.js for why this dodges the unit project's
 * moduleNameMapper while matching extractionTelemetry.ts's './prisma' import.
 */

const updateManyCalls = [];
const mockState = { result: { count: 1 }, error: null };
jest.mock('../lib/prisma.ts', () => {
  const client = {
    extractionEvent: {
      updateMany: async (args) => {
        updateManyCalls.push(args);
        if (mockState.error) throw mockState.error;
        return mockState.result;
      },
    },
  };
  return { __esModule: true, default: client, ...client };
});

const { recordCommit } = require('../lib/extractionTelemetry.ts');

beforeEach(() => {
  updateManyCalls.length = 0;
  mockState.result = { count: 1 };
  mockState.error = null;
});

describe('recordCommit - accountId-scoped, fail-soft', () => {
  test('where clause carries BOTH id and accountId', async () => {
    await recordCommit({ accountId: 'acct-a', extractionId: 'ex-1', fieldsCommitted: 5 });
    expect(updateManyCalls).toHaveLength(1);
    expect(updateManyCalls[0].where).toEqual({ id: 'ex-1', accountId: 'acct-a' });
  });

  test('stamps commit fields + correction signal in data', async () => {
    const corrections = [{ field: 'irPhaseA', before: 1, after: 2, formFamily: 'neta-mts' }];
    await recordCommit({ accountId: 'acct-a', extractionId: 'ex-1', fieldsCommitted: 7, corrections, reviewMs: 1200 });
    const { data } = updateManyCalls[0];
    expect(data.committedAt).toBeInstanceOf(Date);
    expect(data.fieldsCommitted).toBe(7);
    expect(data.fieldsCorrected).toBe(1);
    expect(data.corrections).toEqual(corrections);
    expect(data.reviewMs).toBe(1200);
  });

  test('foreign/unknown id (count 0) resolves silently - no throw', async () => {
    mockState.result = { count: 0 };
    await expect(
      recordCommit({ accountId: 'acct-a', extractionId: 'someone-elses-id', fieldsCommitted: 3 })
    ).resolves.toBeUndefined();
    expect(updateManyCalls).toHaveLength(1);
  });

  test('missing extractionId -> no-op (no DB call)', async () => {
    await recordCommit({ accountId: 'acct-a', fieldsCommitted: 3 });
    expect(updateManyCalls).toHaveLength(0);
  });

  test('missing accountId -> no-op (no unscoped write path exists)', async () => {
    await recordCommit({ extractionId: 'ex-1', fieldsCommitted: 3 });
    expect(updateManyCalls).toHaveLength(0);
  });

  test('prisma error is swallowed (telemetry never breaks the commit)', async () => {
    mockState.error = new Error('db down');
    await expect(
      recordCommit({ accountId: 'acct-a', extractionId: 'ex-1', fieldsCommitted: 3 })
    ).resolves.toBeUndefined();
  });
});
