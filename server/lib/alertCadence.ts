export {};
/**
 * alertCadence.ts -- watermark-driven cadence for the rep briefing.
 *
 * The pilot customer's reality: standards/maintenance tracking is important but
 * NOT a daily/weekly thing. So the outbound rep briefing defaults to MONTHLY, with
 * semi-monthly / weekly / off configurable per account (AccountSetting
 * `alert_cadence`). Customer-triggered events (quotes/emergencies) are a
 * separate IMMEDIATE lane and never touch this.
 *
 * Sturdiness (per engineering-guidelines sec.1): we do NOT rely on a job firing
 * exactly on the 1st (in-process node-cron has no catch-up). Instead the cron
 * runs DAILY and this module decides per-account "is a briefing due since the
 * last one?" using a persisted watermark (AccountSetting
 * `alert_briefing_last_sent`). A missed day self-heals on the next run, and the
 * watermark only advances after a successful send (idempotent). This makes the
 * existing single-instance cron + advisory-lock + healthcheck stack sufficient;
 * a heavier scheduler (pg-boss/BullMQ) would be a drop-in later with no logic
 * change because the gate is watermark-based, not fire-time-based.
 */

const prisma = require('./prisma').default;

const CADENCE_KEY = 'alert_cadence';
const WATERMARK_KEY = 'alert_briefing_last_sent';

// Minimum days between briefings per cadence. Thresholds (not calendar anchors)
// keep it self-healing and simple; small slack absorbs cron-time jitter.
const INTERVAL_DAYS: Record<string, number> = {
  monthly: 28, semimonthly: 14, weekly: 7,
};
const VALID_CADENCES = ['monthly', 'semimonthly', 'weekly', 'off'];

function _normalizeCadence(v: any): string {
  const s = String(v || '').trim().toLowerCase();
  return VALID_CADENCES.includes(s) ? s : 'monthly'; // default monthly
}

async function getCadence(accountId: string): Promise<string> {
  const row = await prisma.accountSetting.findUnique({
    where: { accountId_key: { accountId, key: CADENCE_KEY } }, select: { value: true },
  });
  return _normalizeCadence(row?.value);
}

// Is a briefing due for this account right now? (off => never)
async function dueForBriefing(accountId: string, now: Date = new Date()): Promise<boolean> {
  const cadence = await getCadence(accountId);
  if (cadence === 'off') return false;
  const interval = INTERVAL_DAYS[cadence] ?? 28;
  const wm = await prisma.accountSetting.findUnique({
    where: { accountId_key: { accountId, key: WATERMARK_KEY } }, select: { value: true },
  });
  if (!wm?.value) return true; // never sent -> due
  const last = new Date(wm.value).getTime();
  if (!Number.isFinite(last)) return true;
  const daysSince = (now.getTime() - last) / (24 * 60 * 60 * 1000);
  return daysSince >= interval - 0.5;
}

// Advance the watermark after a successful send (idempotent).
async function markBriefingSent(accountId: string, now: Date = new Date()): Promise<void> {
  await prisma.accountSetting.upsert({
    where: { accountId_key: { accountId, key: WATERMARK_KEY } },
    update: { value: now.toISOString() },
    create: { accountId, key: WATERMARK_KEY, value: now.toISOString() },
  });
}

module.exports = {
  getCadence, dueForBriefing, markBriefingSent,
  CADENCE_KEY, WATERMARK_KEY, VALID_CADENCES, INTERVAL_DAYS,
};
