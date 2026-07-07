/**
 * serviceOpportunityTrigger.ts — daily 02:30 UTC cron (index.ts).
 *
 * Scans all accounts for:
 *   (a) IMMEDIATE deficiencies open 30+ days with no active QuoteRequest
 *   (b) Assets at C3 conditionOverride with no active QuoteRequest
 * Auto-creates a QuoteRequest for each qualifying asset. Deduplicates
 * by skipping assets that already have an open (non-declined) quote.
 *
 * Extracted 2026-07-07 from an inline cron.schedule() body in index.ts into
 * its own lib module — this was the only cron among the daily alert crons
 * whose logic lived inline rather than in an exported, independently
 * testable function (every sibling — qemwAlerts/deficiencyAlerts/
 * arcFlashIntegrity/standardRevisionCron — already followed this shape).
 * Behavior is unchanged; this is a pure extraction for testability (a real
 * Postgres integration test needs a function it can require() and call
 * directly, matching this session's fallback-masks-capture test pattern).
 */
import prisma from './prisma';

export interface ServiceOpportunityTriggerResult {
  created: number;
  skipped: number;
}

export async function runServiceOpportunityTrigger(): Promise<ServiceOpportunityTriggerResult> {
  const ago30 = new Date(Date.now() - 30 * 86_400_000);
  let created = 0, skipped = 0;

  try {
    // 1. IMMEDIATE deficiencies open 30+ days
    const escalatedDefs = await prisma.deficiency.findMany({
      where: {
        severity: 'IMMEDIATE',
        resolvedAt: null,
        createdAt: { lte: ago30 },
        asset: { archivedAt: null },
      },
      select: {
        id: true, accountId: true, assetId: true, description: true,
        asset: { select: { equipmentType: true, manufacturer: true, model: true } },
      },
      take: 500,
    });

    // 2. C3 condition assets (schedule conditionOverride = C3)
    const c3Schedules = await prisma.maintenanceSchedule.findMany({
      where: {
        conditionOverride: 'C3',
        isActive: true,
        asset: { archivedAt: null },
      },
      select: {
        accountId: true, assetId: true,
        asset: { select: { equipmentType: true, manufacturer: true, model: true } },
      },
      take: 500,
    });

    // Build dedup set: assetId of assets already with open quotes
    const allAssetIds = [
      ...new Set([
        ...escalatedDefs.map(d => d.assetId),
        ...c3Schedules.map(s => s.assetId),
      ]),
    ];

    const existingQuotes = await prisma.quoteRequest.findMany({
      where: {
        assetId: { in: allAssetIds },
        status: { in: ['requested', 'quoted'] },
      },
      select: { assetId: true, accountId: true },
    });
    const quotedSet = new Set(existingQuotes.map(q => `${q.accountId}:${q.assetId}`));

    // Build account -> first admin user map for requestedById
    const accountIds = [...new Set([
      ...escalatedDefs.map(d => d.accountId),
      ...c3Schedules.map(s => s.accountId),
    ])];
    const adminUsers = await prisma.user.findMany({
      where: {
        accountId: { in: accountIds },
        role: { in: ['admin', 'manager'] },
        isActive: true,
      },
      select: { id: true, accountId: true },
    });
    const adminMap = new Map<string, string>();
    for (const u of adminUsers) {
      if (!adminMap.has(u.accountId)) adminMap.set(u.accountId, u.id);
    }

    // Helper: create quote if not already quoted
    const maybeCreate = async (accountId: string, assetId: string, opts: {
      driver: string; notes: string;
    }) => {
      const key = `${accountId}:${assetId}`;
      if (quotedSet.has(key)) { skipped++; return; }
      const requestedById = adminMap.get(accountId);
      if (!requestedById) { skipped++; return; }
      quotedSet.add(key); // mark in-memory so dupes in same run don't double-create
      await prisma.quoteRequest.create({
        data: {
          accountId,
          assetId,
          requestedById,
          driver:   opts.driver as any,
          timeline: 'within_30_days',
          status:   'requested',
          notes:    opts.notes,
          emergencyMode: false,
        },
      });
      created++;
    };

    // Process escalated deficiencies
    for (const def of escalatedDefs) {
      try {
        await maybeCreate(def.accountId, def.assetId, {
          driver: 'suspected_failing',
          notes:  `Auto-triggered: IMMEDIATE deficiency open 30+ days — "${def.description?.slice(0, 120) ?? 'see asset'}". Asset: ${def.asset ? `${def.asset.manufacturer || ''} ${def.asset.model || def.asset.equipmentType || 'Unknown Equipment'}`.trim() : def.assetId}.`,
        });
      } catch (itemErr) {
        console.error('[serviceOpportunityTrigger] Failed to create quote request for asset', def.assetId, ':', (itemErr as Error).message);
      }
    }

    // Process C3 condition assets
    for (const sched of c3Schedules) {
      try {
        await maybeCreate(sched.accountId, sched.assetId, {
          driver: 'failed_inspection',
          notes:  `Auto-triggered: Asset "${sched.asset ? `${sched.asset.manufacturer || ''} ${sched.asset.model || sched.asset.equipmentType || 'Unknown Equipment'}`.trim() : sched.assetId}" in C3 (immediate service required) condition.`,
        });
      } catch (itemErr) {
        console.error('[serviceOpportunityTrigger] Failed to create quote request for asset', sched.assetId, ':', (itemErr as Error).message);
      }
    }

    console.log(`[Cron][serviceOpportunityTrigger] Done — created: ${created}, skipped: ${skipped}`);
  } catch (e) {
    console.error('[Cron][serviceOpportunityTrigger] Error:', (e as any).message);
  }

  return { created, skipped };
}

export {};
