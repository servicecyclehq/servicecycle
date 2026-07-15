import { pickReStudyAsset, createReStudyOpportunity, RESTUDY_DRIVER } from '../../lib/arcFlashOpportunity';

// Fully hermetic — no DB. The whole decision + routing flow is exercised with
// injected fakes (prisma, emitPartnerEvent, diffIngestRevisions, busForDrift).

describe('pickReStudyAsset', () => {
  it('prefers an asset behind a CHANGED bus over an added one', () => {
    const report = {
      hasPrior: true, reStudyRecommended: true,
      busChanges: [
        { busName: 'NEW-1', change: 'added' as const },
        { busName: 'MCC-7', change: 'changed' as const },
      ],
    };
    const map = new Map([['NEW-1', 'assetNew'], ['MCC-7', 'assetMcc7']]);
    expect(pickReStudyAsset(report, map)).toEqual({ assetId: 'assetMcc7', busName: 'MCC-7' });
  });

  it('falls back to the first confirmed asset when no changed bus maps (e.g. only removed buses)', () => {
    const report = {
      hasPrior: true, reStudyRecommended: true,
      busChanges: [{ busName: 'GONE-9', change: 'removed' as const }], // removed → not in current map
    };
    const map = new Map([['SWGR-1', 'assetSwgr1']]);
    expect(pickReStudyAsset(report, map)).toEqual({ assetId: 'assetSwgr1', busName: 'SWGR-1' });
  });

  it('returns null when there is no asset to attach to', () => {
    const report = { hasPrior: true, reStudyRecommended: true, busChanges: [] };
    expect(pickReStudyAsset(report, new Map())).toBeNull();
    expect(pickReStudyAsset(null, new Map([['a', 'b']]))).toBeNull();
  });
});

describe('createReStudyOpportunity', () => {
  const ingest = { id: 'ing-2', siteId: 'site-1' };
  const buses = [{ busName: 'MCC-7' }];
  const nameToAssetId = new Map([['MCC-7', 'asset-mcc7']]);

  function makeDeps(over: any = {}) {
    const emit = jest.fn().mockResolvedValue(undefined);
    // Use `in` so an explicit `prior: null` (baseline case) is honored rather
    // than nullish-coalesced back to the default.
    const priorVal = ('prior' in over) ? over.prior : { id: 'ing-1', confirmedAt: new Date(0) };
    const prisma = {
      arcFlashIngest: { findFirst: jest.fn().mockResolvedValue(priorVal) },
      arcFlashIngestBus: { findMany: jest.fn().mockResolvedValue([{ busName: 'MCC-7' }]) },
      quoteRequest: {
        findFirst: jest.fn().mockResolvedValue(over.existing ?? null),
        create: jest.fn().mockResolvedValue({ id: 'qr-99' }),
      },
    };
    const diffIngestRevisions = jest.fn().mockReturnValue(
      over.report ?? { hasPrior: true, reStudyRecommended: true, busChanges: [{ busName: 'MCC-7', change: 'changed' }], summary: '1 bus changed — re-study recommended.' }
    );
    const busForDrift = (b: any) => b;
    return { deps: { prisma, emitPartnerEvent: emit, diffIngestRevisions, busForDrift }, emit, prisma };
  }

  const ctx = { accountId: 'acct-1', ingest, buses, nameToAssetId, userId: 'user-1' };

  it('creates a routed ARC_FLASH_STUDY opportunity on a material change', async () => {
    const { deps, emit, prisma } = makeDeps();
    const res = await createReStudyOpportunity(deps, ctx);

    expect(res.created).toBe(true);
    expect(res.quoteRequestId).toBe('qr-99');

    // QuoteRequest carries the arc-flash trigger + the deliberate non-emergency driver.
    const created = prisma.quoteRequest.create.mock.calls[0][0].data;
    expect(created.triggerType).toBe('ARC_FLASH_STUDY');
    expect(created.driver).toBe(RESTUDY_DRIVER);
    expect(created.status).toBe('requested');
    expect(created.emergencyMode).toBe(false);
    expect(created.assetId).toBe('asset-mcc7');
    expect(created.requestedById).toBe('user-1');

    // Routed to the owning rep via the flywheel, scoped so it can't be deduped
    // away by a generic quote in the same window.
    expect(emit).toHaveBeenCalledTimes(1);
    const [acctId, eventType, payload, opts] = emit.mock.calls[0];
    expect(acctId).toBe('acct-1');
    expect(eventType).toBe('QUOTE_REQUEST_CREATED');
    expect(payload.triggerType).toBe('ARC_FLASH_STUDY');
    expect(payload.dedupeKey).toBe('ARC_FLASH_STUDY');
    expect(payload.quoteRequestId).toBe('qr-99');
    expect(opts).toEqual({ dedupeKey: 'ARC_FLASH_STUDY' });
  });

  it('does nothing on the baseline (no prior confirmed revision)', async () => {
    const { deps, emit, prisma } = makeDeps({ prior: null });
    const res = await createReStudyOpportunity(deps, ctx);
    expect(res).toEqual({ created: false, reason: 'baseline' });
    expect(prisma.quoteRequest.create).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('does nothing when there is no material change', async () => {
    const { deps, emit, prisma } = makeDeps({ report: { hasPrior: true, reStudyRecommended: false, busChanges: [] } });
    const res = await createReStudyOpportunity(deps, ctx);
    expect(res).toEqual({ created: false, reason: 'no_material_change' });
    expect(prisma.quoteRequest.create).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('is idempotent — skips when an open re-study quote already exists for the site', async () => {
    const { deps, emit, prisma } = makeDeps({ existing: { id: 'qr-old' } });
    const res = await createReStudyOpportunity(deps, ctx);
    expect(res).toEqual({ created: false, reason: 'already_open' });
    expect(prisma.quoteRequest.create).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
