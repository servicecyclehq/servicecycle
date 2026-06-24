/**
 * lib/telemetryMonitoring.ts -- Phase 4 #8 condition-monitoring loop.
 *
 * Ties a graded telemetry reading into the NFPA 70B:2023 condition-based model:
 *
 *   - escalation transition (OK->WARN, OK->CRIT, WARN->CRIT) opens a
 *     TelemetryNotification at the new level;
 *   - a return toward OK auto-resolves the open notifications no longer met;
 *   - an OPEN CRIT notification holds the asset's autoConditionMonitoring flag
 *     true, which feeds worst-of governingCondition as a Condition-2 driver
 *     (separate from the human physical/criticality/environment axes and from
 *     the autoConditionC3 missed-cycle flag), and cascades non-overridden
 *     schedule due dates to the tightened interval.
 *
 * The flag clears automatically once no open CRIT remains (value recovered or a
 * reviewer acknowledged), restoring the human governing condition. Mirrors the
 * design of lib/missedCyclePolicy.ts.
 *
 * Auto-quote: when autoConditionMonitoring transitions false->true (first CRIT
 * alert fires), a QuoteRequest is auto-created (triggerType=TELEMETRY_CRIT) so
 * the rep sees an action item. Idempotent — skipped if an open TELEMETRY_CRIT
 * request already exists for the asset. Non-fatal — failure logs but does not
 * block the condition state update.
 */

'use strict';

const { gradeReading } = require('./telemetryEvaluate');
const { worstCondition, computeNextDueDate } = require('./maintenanceInterval');
const { writeLog } = require('./activityLog');

const RANK: Record<string, number> = { OK: 0, WARN: 1, CRIT: 2 };

/**
 * Governing condition for an asset given its three human axes plus the two
 * computed flags. autoConditionC3 contributes a C3 driver; autoConditionMonitoring
 * contributes a C2 driver. worstCondition is variadic and tolerates nulls.
 */
function governingFor(asset: any): 'C1' | 'C2' | 'C3' {
  return worstCondition(
    asset.conditionPhysical,
    asset.conditionCriticality,
    asset.conditionEnvironment,
    asset.autoConditionC3 ? 'C3' : null,
    asset.autoConditionMonitoring ? 'C2' : null,
  );
}

/**
 * Recompute the monitoring flag from the count of OPEN (unacknowledged) CRIT
 * notifications, and if it transitions, update governingCondition, cascade the
 * asset's non-overridden active schedules, and log a cited condition_changed.
 * Idempotent. `db` is prisma or a transaction client.
 */
async function applyMonitoringState(db: any, accountId: string, assetId: string, now: Date = new Date()) {
  const asset = await db.asset.findFirst({
    where: { id: assetId, accountId },
    select: {
      id: true, conditionPhysical: true, conditionCriticality: true, conditionEnvironment: true,
      governingCondition: true, autoConditionC3: true, autoConditionMonitoring: true,
      schedules: {
        where: { isActive: true },
        select: { id: true, lastCompletedDate: true, conditionOverride: true,
          taskDefinition: { select: { intervalC1Months: true, intervalC2Months: true, intervalC3Months: true } } },
      },
    },
  });
  if (!asset) return { changed: false };

  const openCrit = await db.telemetryNotification.count({
    where: { accountId, assetId, status: 'CRIT', acknowledgedAt: null },
  });
  const shouldMonitor = openCrit > 0;
  if (shouldMonitor === asset.autoConditionMonitoring) return { changed: false, autoConditionMonitoring: shouldMonitor, governing: asset.governingCondition };

  const governing = governingFor({ ...asset, autoConditionMonitoring: shouldMonitor });
  await db.asset.update({ where: { id: asset.id }, data: { autoConditionMonitoring: shouldMonitor, governingCondition: governing } });

  // Cascade interval math to the schedules the asset's condition governs.
  for (const s of asset.schedules) {
    if (s.conditionOverride || !s.lastCompletedDate) continue;
    const nd = computeNextDueDate(s.lastCompletedDate, s.taskDefinition, governing);
    await db.maintenanceSchedule.update({ where: { id: s.id }, data: { nextDueDate: nd } });
  }

  if (asset.governingCondition !== governing) {
    await writeLog({
      assetId: asset.id, userId: null, accountId, action: 'condition_changed',
      details: {
        from: asset.governingCondition, to: governing,
        reason: shouldMonitor
          ? 'Auto Condition 2 -- unaddressed continuous-monitoring notification (NFPA 70B:2023 condition-based maintenance)'
          : 'Auto Condition 2 cleared -- continuous-monitoring notification addressed (NFPA 70B:2023)',
        standardRef: 'NFPA 70B:2023', auto: true, trigger: 'telemetry',
      },
    });
  }

  // Auto-quote on first CRIT escalation (false -> true transition only).
  // Creates a QuoteRequest so the rep has an action item waiting in their queue.
  // Idempotent: skipped if an open/quoted TELEMETRY_CRIT request already exists.
  // Non-fatal: failure is logged but does not block the monitoring state update.
  if (shouldMonitor) {
    try {
      const existingQuote = await db.quoteRequest.findFirst({
        where: { accountId, assetId: asset.id, triggerType: 'TELEMETRY_CRIT', status: { not: 'declined' } },
        select: { id: true },
      });
      if (!existingQuote) {
        const requester = await db.user.findFirst({
          where: { accountId, role: { in: ['admin', 'manager'] }, isActive: true },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (requester) {
          await db.quoteRequest.create({
            data: {
              accountId,
              assetId: asset.id,
              requestedById: requester.id,
              driver: 'suspected_failing' as any,
              timeline: 'within_1_week' as any,
              triggerType: 'TELEMETRY_CRIT',
              notes: 'Auto-generated: continuous-monitoring CRIT alert (NFPA 70B:2023 condition-based maintenance). Review sensor readings and schedule inspection.',
              dossierSnapshot: {
                source: 'telemetry_crit', autoGenerated: true,
                generatedAt: now.toISOString(), governingCondition: governing,
              },
            },
          });
        }
      }
    } catch (err: any) {
      // Non-fatal: log but do not fail the monitoring state update.
      console.error('[telemetry-auto-quote] Failed to create auto quote request:', err.message);
    }
  }

  return { changed: true, autoConditionMonitoring: shouldMonitor, governing };
}

/**
 * Ingest one already-validated reading for a known channel + asset. Grades it,
 * persists the reading (idempotent on externalId), updates channel state, opens
 * / resolves notifications on transitions, then recomputes the asset's monitoring
 * condition. Returns a per-reading summary. `db` is prisma or a tx client.
 */
async function ingestReading(db: any, params: {
  accountId: string; asset: any; channel: any;
  value: number; unit?: string | null; recordedAt: Date; source?: string | null; externalId?: string | null;
}) {
  const { accountId, asset, channel } = params;

  // Idempotent: a repeated externalId on the same channel returns the prior row.
  if (params.externalId) {
    const prior = await db.telemetryReading.findUnique({
      where: { channelId_externalId: { channelId: channel.id, externalId: params.externalId } },
      select: { id: true, status: true },
    });
    if (prior) return { readingId: prior.id, status: prior.status, duplicate: true, notificationOpened: false };
  }

  const grade = gradeReading(params.value, channel);
  const newStatus: string = grade.status;
  const prevStatus: string = channel.lastStatus || 'OK';

  const reading = await db.telemetryReading.create({
    data: {
      accountId, channelId: channel.id, assetId: asset.id,
      value: params.value, unit: params.unit ?? channel.unit ?? null,
      status: newStatus as any, recordedAt: params.recordedAt,
      source: params.source ?? null, externalId: params.externalId ?? null,
    },
    select: { id: true },
  });

  await db.telemetryChannel.update({
    where: { id: channel.id },
    data: { lastValue: params.value, lastStatus: newStatus as any, lastReadingAt: params.recordedAt },
  });

  // Resolve open notifications no longer met by the current status.
  if (newStatus === 'OK') {
    await db.telemetryNotification.updateMany({
      where: { channelId: channel.id, acknowledgedAt: null },
      data: { acknowledgedAt: new Date(), autoResolved: true },
    });
  } else if (newStatus === 'WARN') {
    await db.telemetryNotification.updateMany({
      where: { channelId: channel.id, status: 'CRIT', acknowledgedAt: null },
      data: { acknowledgedAt: new Date(), autoResolved: true },
    });
  }

  // Open a notification on an upward transition into a worse band.
  let notificationOpened = false;
  if (newStatus !== 'OK' && RANK[newStatus] > RANK[prevStatus]) {
    const label = channel.label || channel.key;
    const unit = params.unit ?? channel.unit ?? '';
    const dir = grade.thresholdKind && grade.thresholdKind.endsWith('Low') ? 'below' : 'above';
    const message = `${label} ${newStatus === 'CRIT' ? 'critical' : 'warning'}: ${params.value}${unit ? ' ' + unit : ''} ${dir} ${grade.threshold}${unit ? ' ' + unit : ''} threshold`;
    await db.telemetryNotification.create({
      data: {
        accountId, assetId: asset.id, channelId: channel.id, status: newStatus as any,
        value: params.value, threshold: grade.threshold ?? null, thresholdKind: grade.thresholdKind ?? null,
        message: message.slice(0, 500),
      },
    });
    notificationOpened = true;
  }

  const monitoring = await applyMonitoringState(db, accountId, asset.id);

  return {
    readingId: reading.id, status: newStatus, duplicate: false,
    notificationOpened, governingCondition: monitoring.governing,
    autoConditionMonitoring: monitoring.autoConditionMonitoring,
  };
}

module.exports = { governingFor, applyMonitoringState, ingestReading };

export { governingFor, applyMonitoringState, ingestReading };
