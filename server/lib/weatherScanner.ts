/**
 * lib/weatherScanner.ts
 * ─────────────────────
 * Polls the NOAA/NWS active-alerts API for severe weather events that may
 * affect ServiceCycle customer facilities, then creates or resolves
 * DisasterEvent records and fires alertEngine notifications to the relevant
 * accounts and service reps.
 *
 * DATA SOURCES (all free, no API key required):
 *   NWS Active Alerts  https://api.weather.gov/alerts/active
 *   FEMA Declarations  https://www.fema.gov/api/open/v2/disasterDeclarations
 *
 * GEO-MATCHING STRATEGY:
 *   Sites have address / city / state / postalCode but NO lat/lng. Rather
 *   than calling a geocoder for every site on every scan cycle, we match at
 *   the state level using the UGC geocode prefixes embedded in each NWS
 *   alert (e.g. "WIC079" → state = "WI"). This is conservative — a site in
 *   WI will match any WI alert even if it's in a distant county — but for
 *   disaster-response purposes it's better to over-notify than under-notify.
 *   A future improvement can refine to county level using Census FIPS lookup.
 *
 * SEVERITY FILTER:
 *   Only Extreme/Severe + Immediate/Expected alerts for the event types the
 *   spec calls out (tornado, hurricane, ice storm, blizzard, flash flood,
 *   severe thunderstorm, wildfire, extreme heat). "Minor" / "Moderate"
 *   advisories are skipped — they don't warrant queue prioritisation.
 *
 * IDEMPOTENCY:
 *   Each NWS alert carries a unique @id (URL). The scanner stores this as
 *   nwsAlertId and uses upsert semantics: if the event already exists it
 *   checks whether the NWS alert is still active; if the NWS alert has
 *   expired or been replaced, it sets resolvedAt. This means the scanner
 *   can run on a 15-minute cron without duplicating events.
 *
 * ENABLED FLAG:
 *   WEATHER_SCANNER_ENABLED defaults to true. Set to 'false' in .env to
 *   disable outbound NWS polling (air-gapped / strict-egress installs).
 */

import prisma from './prisma';

const SCANNER_ENABLED = process.env.WEATHER_SCANNER_ENABLED !== 'false';
const NWS_AGENT = 'ServiceCycle/1.0 (servicecyclehq@gmail.com)';

// ── Severity / urgency filter ─────────────────────────────────────────────────
// Only alert on conditions that warrant immediate equipment triage.
const SEVERITY_INCLUDE  = new Set(['Extreme', 'Severe']);
const URGENCY_INCLUDE   = new Set(['Immediate', 'Expected']);

// ── Event type mappings: NWS event → internal eventType ──────────────────────
// NWS uses verbose names like "Tornado Warning". We normalise these to the
// compact enum used in DisasterEvent.eventType.
const NWS_EVENT_MAP: Record<string, string> = {
  'Tornado Warning':               'tornado',
  'Tornado Watch':                 'tornado',
  'Hurricane Warning':             'hurricane',
  'Hurricane Watch':               'hurricane',
  'Typhoon Warning':               'hurricane',
  'Ice Storm Warning':             'ice_storm',
  'Blizzard Warning':              'blizzard',
  'Flash Flood Warning':           'flash_flood',
  'Flash Flood Watch':             'flash_flood',
  'Severe Thunderstorm Warning':   'severe_thunderstorm',
  'Severe Thunderstorm Watch':     'severe_thunderstorm',
  'Fire Weather Watch':            'wildfire',
  'Red Flag Warning':              'wildfire',
  'Extreme Fire Danger':           'wildfire',
  'Excessive Heat Warning':        'extreme_heat',
  'Extreme Heat Warning':          'extreme_heat',
  'Heat Emergency':                'extreme_heat',
};

// NWS "event" name → severity value we store. "Warning" is more severe than
// "Watch"; we store "warning" for both but flag "Watch" as "watch".
function nwsSeverityToInternal(event: string, nwsSeverity: string): string {
  if (nwsSeverity === 'Extreme') return 'emergency';
  if (event.includes('Warning')) return 'warning';
  if (event.includes('Watch'))   return 'watch';
  return 'warning';
}

// ── UGC → state abbreviation ──────────────────────────────────────────────────
// NWS UGC codes start with a 2-letter state abbreviation followed by a
// letter (C=county, Z=forecast zone) and 3 digits, e.g. "WIC079", "TNZ003".
function extractStatesFromUGC(ugcCodes: string[]): string[] {
  const states = new Set<string>();
  for (const code of ugcCodes) {
    if (code && code.length >= 2) {
      states.add(code.slice(0, 2).toUpperCase());
    }
  }
  return Array.from(states);
}

// ── Fetch with timeout + User-Agent ──────────────────────────────────────────
async function fetchJSON(url: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': NWS_AGENT, Accept: 'application/geo+json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Match sites to affected states ────────────────────────────────────────────
// Returns distinct Site.id values where site.state is in affectedStates AND
// the site has at least a state recorded (skip sites with no location data).
async function matchSitesToStates(affectedStates: string[]): Promise<string[]> {
  if (!affectedStates.length) return [];
  const sites = await prisma.site.findMany({
    where: {
      state: { in: affectedStates, mode: 'insensitive' },
      archivedAt: null,
    },
    select: { id: true },
  });
  return sites.map((s) => s.id);
}

// ── Alert accounts whose sites are affected ───────────────────────────────────
// Sends an in-app alert + email to admin/manager users on each affected
// account, plus the account's service rep if configured.
async function notifyAffectedAccounts(
  event: { id: string; title: string; severity: string; region: string; eventType: string },
  affectedSiteIds: string[]
): Promise<void> {
  if (!affectedSiteIds.length) return;

  // Find all accounts that have at least one site in the impact zone.
  const sites = await prisma.site.findMany({
    where: { id: { in: affectedSiteIds } },
    select: { accountId: true },
    distinct: ['accountId'],
  });
  const accountIds = sites.map((s) => s.accountId);
  if (!accountIds.length) return;

  const accounts = await prisma.account.findMany({
    where: { id: { in: accountIds } },
    select: {
      id: true, companyName: true,
      serviceRepName: true, serviceRepEmail: true, serviceRepPhone: true,
      users: {
        where: { role: { in: ['admin', 'manager'] } },
        select: { id: true, name: true, email: true, role: true },
      },
    },
  });

  // Disaster events surface in-app via the DisasterResponsePage and the
  // DisasterBanner component (which polls GET /api/disaster-events on load).
  // We also send an email digest to admin/manager users so they're aware
  // even if they're not actively logged in.
  const { sendEmail } = require('./email');

  for (const account of accounts) {
    for (const user of account.users) {
      try {
        await sendEmail({
          to:      user.email,
          subject: `[ServiceCycle] ⚠️ ${event.title} — Your Facility May Be Affected`,
          html:    `<p>Hi ${user.name || 'there'},</p>` +
                   `<p>A severe weather event has been detected in your region.</p>` +
                   `<ul>` +
                   `<li><strong>Event:</strong> ${event.title}</li>` +
                   `<li><strong>Region:</strong> ${event.region}</li>` +
                   `<li><strong>Severity:</strong> ${event.severity.toUpperCase()}</li>` +
                   `</ul>` +
                   `<p>Log in to ServiceCycle to review your assets and declare an emergency if needed to prioritise your service queue.</p>` +
                   (account.serviceRepPhone
                     ? `<p>Your service rep (${account.serviceRepName || 'assigned rep'}) can be reached at ${account.serviceRepPhone}.</p>`
                     : ''),
        });
      } catch (e) {
        console.warn(`[weatherScanner] Email failed for ${user.email}:`, (e as any).message);
      }
    }
  }
}

// ── Core NWS scanner ──────────────────────────────────────────────────────────
export async function runWeatherScanner(): Promise<{
  checked: number; created: number; resolved: number; errors: number;
}> {
  if (!SCANNER_ENABLED) {
    console.log('[weatherScanner] Disabled via WEATHER_SCANNER_ENABLED=false — skipping.');
    return { checked: 0, created: 0, resolved: 0, errors: 0 };
  }

  console.log('[weatherScanner] Starting NWS active-alerts scan…');
  let checked = 0; let created = 0; let resolved = 0; let errors = 0;

  // ── Fetch NWS active alerts (Extreme/Severe only) ─────────────────────────
  let nwsAlerts: any[] = [];
  try {
    const data = await fetchJSON(
      'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update&severity=Extreme,Severe'
    );
    nwsAlerts = data?.features ?? [];
    console.log(`[weatherScanner] NWS returned ${nwsAlerts.length} Extreme/Severe active alerts`);
  } catch (e: any) {
    console.error('[weatherScanner] NWS fetch failed:', e.message);
    errors++;
  }

  // Set of NWS alert IDs currently active — used below to resolve stale events.
  const activeNwsIds = new Set<string>();

  for (const feature of nwsAlerts) {
    try {
      const props = feature.properties || {};
      const nwsAlertId: string = feature.id || props.id || '';
      const event: string      = props.event || '';
      const severity: string   = props.severity || '';
      const urgency: string    = props.urgency || '';

      // Filter: known event types + severity + urgency thresholds.
      const eventType = NWS_EVENT_MAP[event];
      if (!eventType) continue;
      if (!SEVERITY_INCLUDE.has(severity)) continue;
      if (!URGENCY_INCLUDE.has(urgency)) continue;
      if (!nwsAlertId) continue;

      checked++;
      activeNwsIds.add(nwsAlertId);

      // UGC geocode → state abbreviations.
      const ugcCodes: string[] = props.geocode?.UGC ?? [];
      const affectedStates = extractStatesFromUGC(ugcCodes);
      if (!affectedStates.length) continue; // can't geo-match without state data

      const title      = (props.headline || event).slice(0, 300);
      const region     = (props.areaDesc || '').slice(0, 500);
      const internalSeverity = nwsSeverityToInternal(event, severity);

      // Check if we already have this alert.
      const existing = await prisma.disasterEvent.findFirst({
        where: { nwsAlertId },
      } as any);

      if (existing) {
        // Already tracked — nothing to do for now (updates are handled by
        // the resolve pass below).
        continue;
      }

      // New event — match sites and create.
      const affectedSiteIds = await matchSitesToStates(affectedStates);

      const newEvent: any = await prisma.disasterEvent.create({
        data: {
          eventType,
          severity: internalSeverity,
          title,
          region,
          affectedStates,
          affectedSiteIds,
          nwsAlertId,
          source: 'nws',
        },
      } as any);

      created++;
      console.log(`[weatherScanner] New event: ${title} (${affectedStates.join(', ')}) — ${affectedSiteIds.length} affected sites`);

      // Fire account notifications asynchronously (non-blocking).
      notifyAffectedAccounts(newEvent, affectedSiteIds).catch((e) =>
        console.warn('[weatherScanner] Notify error:', e.message)
      );

    } catch (e: any) {
      errors++;
      console.warn('[weatherScanner] Alert processing error:', e.message);
    }
  }

  // ── Resolve stale NWS events ───────────────────────────────────────────────
  // Any DisasterEvent with source='nws' that is NOT in the current NWS active
  // set and has no resolvedAt should be resolved now (the alert expired or
  // was cancelled by NWS).
  try {
    const stale: any[] = await (prisma.disasterEvent as any).findMany({
      where: {
        source:     'nws',
        resolvedAt: null,
        nwsAlertId: { not: null },
      },
      select: { id: true, nwsAlertId: true },
    });

    for (const ev of stale) {
      if (!activeNwsIds.has(ev.nwsAlertId)) {
        await (prisma.disasterEvent as any).update({
          where: { id: ev.id },
          data:  { resolvedAt: new Date() },
        });
        resolved++;
      }
    }
    if (resolved > 0) {
      console.log(`[weatherScanner] Resolved ${resolved} expired NWS events`);
    }
  } catch (e: any) {
    console.warn('[weatherScanner] Resolve pass error:', e.message);
    errors++;
  }

  console.log(`[weatherScanner] Done — checked: ${checked}, created: ${created}, resolved: ${resolved}, errors: ${errors}`);
  return { checked, created, resolved, errors };
}

module.exports = { runWeatherScanner };
export {};
