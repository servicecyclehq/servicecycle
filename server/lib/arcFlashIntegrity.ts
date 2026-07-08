/**
 * arcFlashIntegrity.ts — expanded arc flash study invalidation engine.
 *
 * Task 25 — three additional scenarios beyond equipment-change triggers:
 *
 *   1. 5-year re-evaluation (NFPA 70E (2021+ editions) §130.5 mandatory review —
 *      NOT an Annex D best practice; corrected 2026-07-08):
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
  ppeCategory: number | null = null,
  incidentEnergy: number | null = null,
): string {
  const hazardLine = (ppeCategory !== null || incidentEnergy !== null)
    ? `<p style="font-size:13px;color:#374151;margin:8px 0 16px;padding:8px 12px;background:#fef3c7;border-left:3px solid #b45309;border-radius:0 4px 4px 0;">Hazard level: ${ppeCategory !== null ? `PPE Category ${ppeCategory}` : 'N/A'} | Incident energy: ${incidentEnergy !== null ? `${incidentEnergy} cal/cm²` : 'N/A'}</p>`
    : '';
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
      ${hazardLine}<p style="font-size:13px;color:#374151;margin:0 0 8px;">
        An outdated or invalidated study exposes personnel to unquantified arc flash hazard per NFPA 70E §130.5(G) and Annex D.
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
  // [2026-07-06 fallback-masks-capture fix] User.email is required/
  // non-nullable/unique -- `{ not: null }` against a non-nullable Prisma
  // field throws PrismaClientValidationError unconditionally on every call
  // (see the same bug + full writeup in lib/qemwAlerts.ts). `{ not: '' }`
  // preserves the original defensive intent without the invalid-argument
  // crash.
  return prisma.user.findMany({
    where: {
      accountId,
      role:     { in: ['admin', 'manager'] },
      isActive: true,
      email:    { not: '' },
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

  // ── Path 0: per-study 5-year re-evaluation (#25, NFPA 70E §130.5 mandatory) ─
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
      coveredAssets: { select: { assetId: true, incidentEnergyCalCm2: true, ppeCategory: true }, take: 1 },
    },
  });

  // Group studies by accountId so we only fetch AccountSetting once per account
  const studiesByAccount = new Map<string, typeof arcStudies>();
  for (const study of arcStudies) {
    if (!studiesByAccount.has(study.accountId)) studiesByAccount.set(study.accountId, []);
    studiesByAccount.get(study.accountId)!.push(study);
  }

  for (const [accountId, accountStudies] of studiesByAccount) {
    // Read configurable warning thresholds for this account.
    // Default "90,60,30" means send notifications at 90, 60, and 30 days before expiry.
    const warnSetting = await prisma.accountSetting.findUnique({
      where: { accountId_key: { accountId, key: 'ARC_FLASH_EXPIRY_WARNING_DAYS' } },
    });
    const warnDays: number[] = (warnSetting?.value || '90,60,30')
      .split(',')
      .map((d: string) => parseInt(d.trim(), 10))
      .filter((d: number) => !isNaN(d) && d > 0)
      .sort((a: number, b: number) => b - a); // largest first so we check from widest window

    for (const study of accountStudies) {
      const expiresAt = study.expiresAt ? new Date(study.expiresAt) : null;
      if (!expiresAt || isNaN(expiresAt.getTime())) continue;

      const msToExpiry = expiresAt.getTime() - now.getTime();
      const expired    = msToExpiry <= 0;

      // Determine which warning threshold this study has crossed, if any
      const crossedDay = warnDays.find((d: number) => msToExpiry <= d * MS_PER_DAY);
      if (!expired && crossedDay === undefined) continue;
      perStudyExpired++;

      const template = expired
        ? `arc_flash_study_expired:${study.id}`
        : `arc_flash_expiring_${crossedDay}d:${study.id}`;

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
        ? 'Arc flash study 5-year re-evaluation (NFPA 70E §130.5 mandatory review)'
        : `Arc flash study approaching 5-year re-evaluation (${crossedDay} days remaining)`;
      // [AFX-11] The 5-year review interval is itself a mandatory NFPA 70E (2021+
      // editions) §130.5 "shall" — reviewed for accuracy at intervals not exceeding
      // 5 years — NOT an Annex D best practice (audit 2026-07-08 correction; the
      // trigger logic above was already correct, only this citation was wrong).
      // §130.5(C) separately requires re-evaluation whenever system changes may
      // affect the results; lead with the mandatory citation in both cases.
      const detail = expired
        ? `Study performed ${new Date(study.performedDate).toISOString().slice(0, 10)} expired ${expiresAt.toISOString().slice(0, 10)}. NFPA 70E §130.5 requires the arc flash risk assessment to be reviewed for accuracy at intervals not exceeding 5 years — a mandatory "shall", not an Annex D best practice. Re-evaluation is also independently required under §130.5(C) whenever changes to the electrical distribution system may affect arc flash results.`
        : `Study performed ${new Date(study.performedDate).toISOString().slice(0, 10)} expires ${expiresAt.toISOString().slice(0, 10)} (within ${crossedDay} days). Plan the re-study now to avoid a compliance gap.`;

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
      const coveredAsset = study.coveredAssets[0] ?? null;
      const studyPpeCategory = coveredAsset?.ppeCategory ?? null;
      const studyIncidentEnergy = coveredAsset?.incidentEnergyCalCm2 != null
        ? Number(coveredAsset.incidentEnergyCalCm2) : null;
      const html    = buildArcFlashHtml(reason, account?.companyName ?? study.accountId, detail, studyPpeCategory, studyIncidentEnergy);
      const subject = `[Arc Flash Alert] ${reason} — ${account?.companyName ?? study.accountId}`;
      let pathEmailsSent = 0;
      for (const admin of admins) {
        try { await sendEmail({ to: admin.email, subject, html }); pathEmailsSent++; emailsSent++; }
        catch (e: any) { console.error(`[arcFlashIntegrity] email failed for ${redactEmail(admin.email)}:`, e.message); }
      }
      await prisma.notificationLog.create({
        data: {
          accountId: study.accountId, channel: 'email', template,
          recipient: admins.map((a: any) => a.email).join(', '),
          status: pathEmailsSent > 0 ? 'sent' : 'failed', alertCount: 1,
        },
      }).catch(() => {});
      accountsChecked++;
    }
  }
  quoteRequests += studyCounter.count;

  // ── Path 1: 5-year re-evaluation (NFPA 70E §130.5 mandatory review) ────────
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
      ? 'Arc flash study 5-year re-evaluation (NFPA 70E §130.5 mandatory review)'
      : 'Arc flash study approaching 5-year re-evaluation — 6 months remaining';

    // [AFX-11] The 5-year review interval is itself a mandatory NFPA 70E (2021+
    // editions) §130.5 "shall" — reviewed for accuracy at intervals not exceeding
    // 5 years — NOT an Annex D best practice (audit 2026-07-08 correction; the
    // trigger logic above was already correct, only this citation was wrong).
    // §130.5(C) separately requires re-evaluation whenever system changes may
    // affect the results; lead with the mandatory citation in both cases.
    const detail = expired5yr
      ? `Study date: ${studyDate.toISOString().slice(0, 10)} — now ${(ageYears).toFixed(1)} years old. NFPA 70E §130.5 requires the arc flash risk assessment to be reviewed for accuracy at intervals not exceeding 5 years — a mandatory "shall", not an Annex D best practice. Re-evaluation is also independently required under §130.5(C) whenever changes to the electrical distribution system may affect arc flash results.`
      : `Study date: ${studyDate.toISOString().slice(0, 10)} — expires in approximately 6 months. Plan re-study now to avoid a compliance gap.`;

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

    let path1EmailsSent = 0;
    for (const admin of admins) {
      try {
        await sendEmail({ to: admin.email, subject, html });
        emailsSent++;
        path1EmailsSent++;
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
        status:    path1EmailsSent > 0 ? 'sent' : 'failed',
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
      `Auto-triggered: Load growth recorded at ${pct}% (threshold >10%). NFPA 70E §130.5(G) mandates re-study when system changes may affect incident energy levels.`,
      `loadgrowth:${accountId}`,
      quotedSet, qrCounter,
    );

    const account = await prisma.account.findUnique({
      where: { id: accountId }, select: { companyName: true },
    });
    const reason = `Load growth of ${pct}% exceeds 10% threshold — arc flash re-study required`;
    const detail = `Your facility has recorded ${pct}% load growth. NFPA 70E §130.5(G) mandates that the arc flash hazard analysis be re-studied whenever changes in the electrical distribution system — including load additions — may affect incident energy levels.`;
    const html    = buildArcFlashHtml(reason, account?.companyName ?? accountId, detail);
    const subject = `[Arc Flash Alert] Load growth ${pct}% — re-study required — ${account?.companyName ?? accountId}`;

    let path2EmailsSent = 0;
    for (const admin of admins) {
      try { await sendEmail({ to: admin.email, subject, html }); emailsSent++; path2EmailsSent++; }
      catch (e: any) { console.error('[arcFlashIntegrity] email failed:', (e as any).message); }
    }
    await prisma.notificationLog.create({
      data: {
        accountId, channel: 'email', template,
        recipient: admins.map((a) => a.email).join(', '),
        status: path2EmailsSent > 0 ? 'sent' : 'failed', alertCount: 1,
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
      `Auto-triggered: IMMEDIATE deficiency involving relay/breaker calibration detected on ${assetLabel}.\nDeficiency: "${def.description.slice(0, 200)}".\nNFPA 70E §130.5(G): changes to protective device settings that may affect incident energy levels require a re-study.`,
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
    const detail = `Asset: ${assetLabel}. Deficiency: "${def.description.slice(0, 200)}". Protective device settings and calibration directly affect arc flash incident energy. NFPA 70E §130.5(G) mandates re-study when protective device changes may affect incident energy levels.`;
    const html    = buildArcFlashHtml(reason, account?.companyName ?? def.accountId, detail);
    const subject = `[Arc Flash Alert] Relay/breaker deficiency — re-study required — ${account?.companyName ?? def.accountId}`;

    let path3EmailsSent = 0;
    for (const admin of admins) {
      try { await sendEmail({ to: admin.email, subject, html }); emailsSent++; path3EmailsSent++; }
      catch (e: any) { console.error('[arcFlashIntegrity] email failed:', (e as any).message); }
    }
    await prisma.notificationLog.create({
      data: {
        accountId: def.accountId, channel: 'email', template,
        recipient: admins.map((a) => a.email).join(', '),
        status: path3EmailsSent > 0 ? 'sent' : 'failed', alertCount: 1,
      },
    }).catch(() => {});
  }
  quoteRequests += qrCounter.count;

  return { accountsChecked, expiredStudies, perStudyExpired, loadGrowthAlerts, deficiencyAlerts, quoteRequests, emailsSent };
}
