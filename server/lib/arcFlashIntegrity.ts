/**
 * arcFlashIntegrity.ts — expanded arc flash study invalidation engine.
 *
 * Task 25 — three additional scenarios beyond equipment-change triggers:
 *
 *   1. 5-year expiration (NFPA 70E §130.5):
 *      AccountSetting key ARC_FLASH_STUDY_DATE — alert at 4yr 6mo and 5yr.
 *
 *   2. Load growth exceeding 10%:
 *      AccountSetting key LOAD_GROWTH_PCT — when > 10 trigger invalidation.
 *
 *   3. Breaker/relay deficiency at IMMEDIATE severity with type
 *      RELAY_SETTINGS or BREAKER_CALIBRATION — auto-create QuoteRequest.
 *
 * All three paths create a QuoteRequest with triggerType: 'ARC_FLASH_STUDY'
 * and email account contacts.
 *
 * Wire: registered as daily 09:30 UTC cron in server/index.ts.
 */

import prisma from './prisma';
const { sendEmail }   = require('./email');
const { redactEmail } = require('./redact');

const MS_PER_DAY  = 86_400_000;
const MS_PER_YEAR = 365 * MS_PER_DAY;

// ── helpers ────────────────────────────────────────────────────────────────────

function escHtml(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildArcFlashHtml(
  reason: string,
  accountName: string,
  detail: string,
): string {
  return `<!DOCTYPE html>
<html>
<body style="font-family:system-ui,sans-serif;color:#111827;background:#f9fafb;margin:0;padding:20px;">
  <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    <div style="background:#b45309;padding:16px 24px;">
      <h2 style="margin:0;color:#fff;font-size:18px;">&#9889; Arc Flash Study Review Required</h2>
      <p style="margin:4px 0 0;color:#fef3c7;font-size:13px;">${escHtml(accountName)}</p>
    </div>
    <div style="padding:20px 24px;">
      <p style="font-size:14px;color:#374151;margin:0 0 4px;"><strong>${escHtml(reason)}</strong></p>
      <p style="font-size:13px;color:#374151;margin:8px 0 16px;">${escHtml(detail)}</p>
      <p style="font-size:13px;color:#374151;margin:0 0 8px;">
        NFPA 70E §130.5 requires arc flash hazard analysis to be reviewed any time
        changes in the electrical distribution system affect the incident energy levels.
        An outdated or invalidated study exposes personnel to unquantified arc flash hazard.
      </p>
      <p style="font-size:12px;color:#9ca3af;margin:20px 0 0;">
        A quote request has been automatically opened with your service representative.
        Log in to ServiceCycle to view and prioritise. Do not reply to this email.
      </p>
    </div>
  </div>
</body>
</html>`;
}

async function getAdmins(accountId: string) {
  return prisma.user.findMany({
    where: {
      accountId,
      role:     { in: ['admin', 'manager'] },
      isActive: true,
      email:    { not: null },
    },
    select: { id: true, email: true },
  });
}

async function maybeCreateArcFlashQuote(
  accountId: string,
  assetId: string,
  requestedById: string,
  notes: string,
  key: string, // dedup key for quotedSet
  quotedSet: Set<string>,
  counter: { count: number },
) {
  if (quotedSet.has(key)) return;

  const existing = await prisma.quoteRequest.findFirst({
    where: {
      accountId,
      assetId,
      status:      { in: ['requested', 'quoted'] },
      triggerType: 'ARC_FLASH_STUDY',
    },
  });
  if (existing) { quotedSet.add(key); return; }

  await prisma.quoteRequest.create({
    data: {
      accountId,
      assetId,
      requestedById,
      driver:        'failed_inspection',
      timeline:      'within_30_days',
      status:        'requested',
      triggerType:   'ARC_FLASH_STUDY',
      emergencyMode: false,
      notes,
    },
  }).catch((e: any) =>
    console.warn('[arcFlashIntegrity] QuoteRequest create failed:', e.message),
  );
  quotedSet.add(key);
  counter.count++;
}

// ── main export ────────────────────────────────────────────────────────────────

export interface ArcFlashIntegrityResult {
  accountsChecked:  number;
  expiredStudies:   number;
  perStudyExpired:  number; // #25: per-study SystemStudy 5-yr expirations
  loadGrowthAlerts: number;
  deficiencyAlerts: number;
  quoteRequests:    number;
  emailsSent:       number;
}

export async function runArcFlashIntegrity(): Promise<ArcFlashIntegrityResult> {
  let accountsChecked  = 0;
  let expiredStudies   = 0;
  let perStudyExpired  = 0;
  let loadGrowthAlerts = 0;
  let deficiencyAlerts = 0;
  let quoteRequests    = 0;
  let emailsSent       = 0;

  const now = new Date();
  const quotedSet = new Set<string>();

  // ── Path 0: per-study 5-year expiration (#25, NFPA 70E §130.5) ─────────────
  // First-class SystemStudy arc_flash records each carry their own expiresAt
  // (performedDate + 5yr). The account-level ARC_FLASH_STUDY_DATE setting
  // (Path 1 below) is the legacy single-clock fallback; per-study records win
  // for multi-site customers. We alert at the 6-month warning mark and at
  // expiry, dedup per study via a study-scoped NotificationLog template, and
  // bind the QuoteRequest to a covered asset when the study has coverage.
  const studyCounter = { count: 0 };
  const arcStudies = await prisma.systemStudy.findMany({
    where: {
      studyType:      'arc_flash',
      supersededById: null, // only the active/latest study in each chain
    },
    select: {
      id: true, accountId: true, siteId: true, performedDate: true, expiresAt: true,
      coveredAssets: { select: { assetId: true }, take: 1 },
    },
  });

  for (const study of arcStudies) {
    const expiresAt = study.expiresAt ? new Date(study.expiresAt) : null;
    if (!expiresAt || isNaN(expiresAt.getTime())) continue;

    const msToExpiry = expiresAt.getTime() - now.getTime();
    const expired    = msToExpiry <= 0;
    const warn6mo    = !expired && msToExpiry <= 182 * MS_PER_DAY;
    if (!expired && !warn6mo) continue;
    perStudyExpired++;

    const template = expired
      ? `arc_flash_study_expired:${study.id}`
      : `arc_flash_study_expiring:${study.id}`;
    const alreadySent = await prisma.notificationLog.findFirst({
      where: {
        accountId: study.accountId, template,
        sentAt: { gte: new Date(now.getTime() - 30 * MS_PER_DAY) },
        status: 'sent',
      },
    });
    if (alreadySent) continue;

    const admins = await getAdmins(study.accountId);
    if (admins.length === 0) continue;

    // Prefer a covered asset; otherwise a representative distribution asset.
    let targetAssetId = study.coveredAssets[0]?.assetId ?? null;
    if (!targetAssetId) {
      const rep = await prisma.asset.findFirst({
        where: {
          accountId: study.accountId, archivedAt: null,
          equipmentType: { in: ['SWITCHGEAR', 'PANELBOARD', 'SWITCHBOARD', 'ARC_FLASH_PANEL'] },
        },
        select: { id: true },
      });
      targetAssetId = rep?.id ?? null;
    }

    const reason = expired
      ? 'Arc flash study 5-year expiration (NFPA 70E §130.5)'
      : 'Arc flash study approaching 5-year expiration';
    const detail = expired
      ? `Study performed ${new Date(study.performedDate).toLocaleDateString()} expired ${expiresAt.toLocaleDateString()}. NFPA 70E §130.5 requires review every 5 years or on system change.`
      : `Study performed ${new Date(study.performedDate).toLocaleDateString()} expires ${expiresAt.toLocaleDateString()} (within 6 months). Plan the re-study now to avoid a compliance gap.`;

    if (targetAssetId) {
      await maybeCreateArcFlashQuote(
        study.accountId, targetAssetId, admins[0].id,
        `${reason}\n${detail}`,
        `study:${study.id}`,
        quotedSet, studyCounter,
      );
    }

    const account = await prisma.account.findUnique({
      where: { id: study.accountId }, select: { companyName: true },
    });
    const html    = buildArcFlashHtml(reason, account?.companyName ?? study.accountId, detail);
    const subject = `[Arc Flash Alert] ${reason} — ${account?.companyName ?? study.accountId}`;
    for (const admin of admins) {
      try { await sendEmail({ to: admin.email, subject, html }); emailsSent++; }
      catch (e: any) { console.error(`[arcFlashIntegrity] email failed for ${redactEmail(admin.email)}:`, e.message); }
    }
    await prisma.notificationLog.create({
      data: {
        accountId: study.accountId, channel: 'email', template,
        recipient: admins.map((a) => a.email).join(', '),
        status: 'sent', alertCount: 1,
      },
    }).catch(() => {});
    accountsChecked++;
  }
  quoteRequests += studyCounter.count;

  // ── Path 1: 5-year expiration (NFPA 70E §130.5) ───────────────────────────
  // Alert at 4yr 6mo (warning) and 5yr (critical).
  const arcSettings = await prisma.accountSetting.findMany({
    where: { key: 'ARC_FLASH_STUDY_DATE' },
    select: { accountId: true, value: true },
  });

  const qrCounter = { count: 0 };

  for (const setting of arcSettings) {
    const { accountId, value } = setting;
    const studyDate = new Date(value);
    if (isNaN(studyDate.getTime())) continue;

    const ageMs         = now.getTime() - studyDate.getTime();
    const ageYears      = ageMs / MS_PER_YEAR;
    const warn4yr6mo    = ageYears >= 4.5 && ageYears < 5.0;
    const expired5yr    = ageYears >= 5.0;

    if (!warn4yr6mo && !expired5yr) continue;
    expiredStudies++;

    const reason = expired5yr
      ? 'Arc flash study 5-year expiration (NFPA 70E §130.5)'
      : 'Arc flash study approaching 5-year expiration — 6 months remaining';

    const detail = expired5yr
      ? `Study date: ${studyDate.toLocaleDateString()} — now ${(ageYears).toFixed(1)} years old. NFPA 70E §130.5 requires review every 5 years or when the electrical system changes.`
      : `Study date: ${studyDate.toLocaleDateString()} — expires in approximately 6 months. Plan re-study now to avoid a compliance gap.`;

    // Dedup: skip if notified in the last 30 days for the same reason
    const template = expired5yr ? 'arc_flash_expired' : 'arc_flash_expiring_warning';
    const alreadySent = await prisma.notificationLog.findFirst({
      where: {
        accountId,
        template,
        sentAt: { gte: new Date(now.getTime() - 30 * MS_PER_DAY) },
        status: 'sent',
      },
    });
    if (alreadySent) continue;

    const admins = await getAdmins(accountId);
    if (admins.length === 0) continue;

    // Find a representative asset (any SWITCHGEAR or PANELBOARD) for the quote
    const repAsset = await prisma.asset.findFirst({
      where: {
        accountId,
        archivedAt: null,
        equipmentType: { in: ['SWITCHGEAR', 'PANELBOARD', 'SWITCHBOARD'] },
      },
      select: { id: true },
    });
    if (!repAsset) continue;

    await maybeCreateArcFlashQuote(
      accountId, repAsset.id, admins[0].id,
      `${reason}\n${detail}`,
      `expiry:${accountId}`,
      quotedSet, qrCounter,
    );

    // Email all admins
    const account = await prisma.account.findUnique({
      where: { id: accountId }, select: { companyName: true },
    });
    const html    = buildArcFlashHtml(reason, account?.companyName ?? accountId, detail);
    const subject = `[Arc Flash Alert] ${reason} — ${account?.companyName ?? accountId}`;

    for (const admin of admins) {
      try {
        await sendEmail({ to: admin.email, subject, html });
        emailsSent++;
      } catch (e: any) {
        console.error(`[arcFlashIntegrity] email failed for ${redactEmail(admin.email)}:`, e.message);
      }
    }
    await prisma.notificationLog.create({
      data: {
        accountId,
        channel:   'email',
        template,
        recipient: admins.map((a) => a.email).join(', '),
        status:    'sent',
        alertCount: 1,
      },
    }).catch(() => {});

    accountsChecked++;
  }
  quoteRequests += qrCounter.count;
  qrCounter.count = 0;

  // ── Path 2: Load growth > 10% ────────────────────────────────────────────
  const loadSettings = await prisma.accountSetting.findMany({
    where: { key: 'LOAD_GROWTH_PCT' },
    select: { accountId: true, value: true },
  });

  for (const setting of loadSettings) {
    const { accountId, value } = setting;
    const pct = parseFloat(value);
    if (isNaN(pct) || pct <= 10) continue;
    loadGrowthAlerts++;

    const template = 'arc_flash_load_growth';
    const alreadySent = await prisma.notificationLog.findFirst({
      where: {
        accountId, template,
        sentAt: { gte: new Date(now.getTime() - 30 * MS_PER_DAY) },
        status: 'sent',
      },
    });
    if (alreadySent) continue;

    const admins = await getAdmins(accountId);
    if (admins.length === 0) continue;

    const repAsset = await prisma.asset.findFirst({
      where: { accountId, archivedAt: null, equipmentType: { in: ['SWITCHGEAR', 'PANELBOARD', 'SWITCHBOARD'] } },
      select: { id: true },
    });
    if (!repAsset) continue;

    await maybeCreateArcFlashQuote(
      accountId, repAsset.id, admins[0].id,
      `Auto-triggered: Load growth recorded at ${pct}% (threshold >10%). NFPA 70E §130.5 requires arc flash re-study when load changes alter incident energy levels.`,
      `loadgrowth:${accountId}`,
      quotedSet, qrCounter,
    );

    const account = await prisma.account.findUnique({
      where: { id: accountId }, select: { companyName: true },
    });
    const reason = `Load growth of ${pct}% exceeds 10% threshold — arc flash re-study required`;
    const detail = `Your facility has recorded ${pct}% load growth. NFPA 70E §130.5 requires that the arc flash hazard analysis be reviewed whenever changes in the electrical distribution system — including load additions — may affect incident energy levels.`;
    const html    = buildArcFlashHtml(reason, account?.companyName ?? accountId, detail);
    const subject = `[Arc Flash Alert] Load growth ${pct}% — re-study required — ${account?.companyName ?? accountId}`;

    for (const admin of admins) {
      try { await sendEmail({ to: admin.email, subject, html }); emailsSent++; }
      catch (e: any) { console.error('[arcFlashIntegrity] email failed:', (e as any).message); }
    }
    await prisma.notificationLog.create({
      data: {
        accountId, channel: 'email', template,
        recipient: admins.map((a) => a.email).join(', '),
        status: 'sent', alertCount: 1,
      },
    }).catch(() => {});

    accountsChecked++;
  }
  quoteRequests += qrCounter.count;
  qrCounter.count = 0;

  // ── Path 3: RELAY_SETTINGS or BREAKER_CALIBRATION deficiency at IMMEDIATE ─
  // The deficiency type is embedded in the description field (free text).
  // We pattern-match on 'RELAY_SETTINGS' or 'BREAKER_CALIBRATION' in the
  // description (case-insensitive). OEM Note: add a first-class `deficiencyType`
  // enum in a future schema iteration for cleaner matching.
  const relayBreakerDefs = await prisma.deficiency.findMany({
    where: {
      severity:   'IMMEDIATE',
      resolvedAt: null,
      OR: [
        { description: { contains: 'relay_settings',       mode: 'insensitive' } },
        { description: { contains: 'relay settings',       mode: 'insensitive' } },
        { description: { contains: 'breaker_calibration',  mode: 'insensitive' } },
        { description: { contains: 'breaker calibration',  mode: 'insensitive' } },
        { description: { contains: 'breaker cal ',         mode: 'insensitive' } },
        { description: { contains: 'protection relay',     mode: 'insensitive' } },
        { description: { contains: 'relay trip setting',   mode: 'insensitive' } },
      ],
      asset: { archivedAt: null },
    },
    select: {
      id: true, accountId: true, assetId: true, description: true,
      asset: { select: { equipmentType: true, manufacturer: true, model: true, serialNumber: true } },
    },
    take: 500,
  });

  for (const def of relayBreakerDefs) {
    deficiencyAlerts++;
    const admins = await getAdmins(def.accountId);
    if (admins.length === 0) continue;

    const assetLabel = def.asset
      ? [def.asset.manufacturer, def.asset.model].filter(Boolean).join(' ') || def.asset.equipmentType
      : 'Unknown asset';

    await maybeCreateArcFlashQuote(
      def.accountId, def.assetId, admins[0].id,
      `Auto-triggered: IMMEDIATE deficiency involving relay/breaker calibration detected on ${assetLabel}.\nDeficiency: "${def.description.slice(0, 200)}".\nNFPA 70E §130.5: any change to protective device settings invalidates the arc flash study — a re-study is required.`,
      `relaybreaker:${def.accountId}:${def.assetId}`,
      quotedSet, qrCounter,
    );

    // Email dedup per account per day
    const template = 'arc_flash_relay_breaker_deficiency';
    const alreadySent = await prisma.notificationLog.findFirst({
      where: {
        accountId: def.accountId, template,
        sentAt: { gte: new Date(now.getTime() - 20 * 3_600_000) },
        status: 'sent',
      },
    });
    if (alreadySent) continue;

    const account = await prisma.account.findUnique({
      where: { id: def.accountId }, select: { companyName: true },
    });
    const reason = `IMMEDIATE relay/breaker calibration deficiency detected — arc flash re-study required`;
    const detail = `Asset: ${assetLabel}. Deficiency: "${def.description.slice(0, 200)}". Protective device settings and calibration directly affect arc flash incident energy. NFPA 70E §130.5 requires the arc flash hazard analysis to be reviewed when protective device settings change.`;
    const html    = buildArcFlashHtml(reason, account?.companyName ?? def.accountId, detail);
    const subject = `[Arc Flash Alert] Relay/breaker deficiency — re-study required — ${account?.companyName ?? def.accountId}`;

    for (const admin of admins) {
      try { await sendEmail({ to: admin.email, subject, html }); emailsSent++; }
      catch (e: any) { console.error('[arcFlashIntegrity] email failed:', (e as any).message); }
    }
    await prisma.notificationLog.create({
      data: {
        accountId: def.accountId, channel: 'email', template,
        recipient: admins.map((a) => a.email).join(', '),
        status: 'sent', alertCount: 1,
      },
    }).catch(() => {});
  }
  quoteRequests += qrCounter.count;

  return { accountsChecked, expiredStudies, perStudyExpired, loadGrowthAlerts, deficiencyAlerts, quoteRequests, emailsSent };
}
