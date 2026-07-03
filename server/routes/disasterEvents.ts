/**
 * routes/disasterEvents.ts
 * ─────────────────────────
 * Disaster Response Mode — API routes.
 *
 * Endpoints:
 *
 *   GET  /api/disaster-events
 *     List active (unresolved) disaster events that affect the requesting
 *     account's sites. Returns system-detected regional events where at
 *     least one of affectedSiteIds belongs to this account, PLUS any
 *     declarations made by this account. Sorted by severity then declaredAt.
 *
 *   GET  /api/disaster-events/regional
 *     [manager+] Full regional view: all active system events regardless of
 *     whether any site is matched, plus affected account counts and asset
 *     criticality summary. Used by OEM-style dashboards.
 *
 *   POST /api/disaster-events/declare
 *     Customer declares an emergency for their account. Creates a DisasterEvent
 *     with accountId set and source='manual'. Notifies the service rep.
 *     Body: { title?, eventType, affectedSiteIds? }
 *
 *   POST /api/disaster-events/:id/resolve
 *     [manager+] Mark a manual/account-scoped disaster event as resolved.
 *     System events (source='nws') are resolved by the scanner automatically.
 *
 *   GET  /api/disaster-events/queue-position
 *     Returns this account's position in the emergency service queue: count
 *     of unresolved declarations in the same region(s) that were declared
 *     before this account's most recent declaration.
 *
 * TENANCY: every query scopes to req.user.accountId. System events with
 * accountId=null are readable by all accounts (they are regional broadcasts)
 * but only deletable/resolvable by admins.
 */

import { Router } from 'express';
import prisma from '../lib/prisma';
const { requireManager } = require('../middleware/roles');

const router: Router = Router();

// ── GET /api/disaster-events ─────────────────────────────────────────────────
// Active events for this account: regional events that include one of our
// sites, plus our own declarations.
router.get('/', async (req: any, res) => {
  try {
    const accountId = req.user.accountId;

    // Get this account's site IDs once.
    const mySites = await prisma.site.findMany({
      where: { accountId, archivedAt: null },
      select: { id: true },
    });
    const mySiteIds = mySites.map((s) => s.id);

    // Active = resolvedAt is null.
    // We want:
    //   (a) regional events (accountId=null) where ANY of affectedSiteIds is in mySiteIds
    //   (b) our own declarations (accountId = this account)
    // Prisma doesn't natively filter by array overlap, so we do two queries.

    const [regional, ours] = await Promise.all([
      // Regional events — filter client-side for site overlap since Prisma
      // doesn't have array-contains-any. We limit to the last 200 so this
      // doesn't become a table scan in catastrophic scenarios.
      prisma.disasterEvent.findMany({
        where: {
          accountId:  null,
          resolvedAt: null,
        },
        orderBy: { declaredAt: 'desc' },
        take:    200,
      }),
      // This account's own declarations.
      prisma.disasterEvent.findMany({
        where:   { accountId, resolvedAt: null },
        orderBy: { declaredAt: 'desc' },
      }),
    ]);

    // Filter regional events to those that overlap our sites.
    const mySiteSet = new Set(mySiteIds);
    const filteredRegional = mySiteIds.length > 0
      ? regional.filter((ev: any) =>
          ev.affectedSiteIds.some((sid: string) => mySiteSet.has(sid))
        )
      : [];

    // Merge + deduplicate (our declarations won't be in regional since they
    // have accountId set, but guard anyway).
    const seenIds = new Set<string>();
    const merged: any[] = [];
    for (const ev of [...filteredRegional, ...ours]) {
      if (!seenIds.has(ev.id)) {
        seenIds.add(ev.id);
        merged.push(ev);
      }
    }

    // Sort: emergency > warning > watch, then newest first.
    const SEV_RANK: Record<string, number> = { emergency: 3, warning: 2, watch: 1 };
    merged.sort((a, b) => {
      const diff = (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0);
      if (diff !== 0) return diff;
      return new Date(b.declaredAt).getTime() - new Date(a.declaredAt).getTime();
    });

    // SECURITY: system (regional) events carry a global affectedSiteIds array
    // spanning EVERY tenant whose sites matched the NWS zone. Never return other
    // tenants' site ids — narrow system events to the caller's own sites.
    const events = merged.map((ev: any) =>
      ev.accountId === null && Array.isArray(ev.affectedSiteIds)
        ? { ...ev, affectedSiteIds: ev.affectedSiteIds.filter((sid: string) => mySiteSet.has(sid)) }
        : ev
    );

    res.json({ success: true, data: { events } });
  } catch (err) {
    console.error('GET /disaster-events error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch disaster events' });
  }
});

// ── GET /api/disaster-events/regional ────────────────────────────────────────
// Full regional view for OEM-style dashboards: all active system events with
// affected account + asset summary. Any authenticated manager+ can read this.
router.get('/regional', requireManager, async (req: any, res) => {
  try {
    const accountId = req.user.accountId;

    // TENANCY: system broadcasts (accountId=null) plus this account's own
    // declarations only, never other tenants' declarations. Matches the
    // two-bucket scoping in GET / above; without this an account with zero
    // sites fell through the hasSites filter below and saw every tenant's
    // manual declarations.
    const systemEvents: any[] = await prisma.disasterEvent.findMany({
      where: {
        resolvedAt: null,
        OR: [{ accountId: null }, { accountId }],
      },
      orderBy: { declaredAt: 'desc' },
      take:    100,
    });

    // For each event, enrich with accounts affected that share accountId with
    // the requesting user (i.e., accounts in their org — for now, just the
    // requesting account's sites). In a multi-account OEM scenario, the OEM
    // would see all their customer accounts. For now we scope to self.
    const enriched = await Promise.all(
      systemEvents.map(async (ev: any) => {
        // Count affected sites belonging to this account.
        const mySites = await prisma.site.findMany({
          where: {
            id:         { in: ev.affectedSiteIds },
            accountId,
            archivedAt: null,
          },
          select: { id: true, name: true },
        });

        // Count assets at those sites with criticality 4–5 (high-risk).
        const highRiskAssets = mySites.length > 0
          ? await prisma.asset.count({
              where: {
                siteId:          { in: mySites.map((s) => s.id) },
                accountId,
                archivedAt:      null,
                criticalityScore: { gte: 4 },
              },
            })
          : 0;

        return {
          ...ev,
          // SECURITY: strip the cross-tenant global site list on system events;
          // expose only the caller's own affected sites (myAffectedSites below).
          ...(ev.accountId === null ? { affectedSiteIds: mySites.map((s) => s.id) } : {}),
          myAffectedSites:     mySites,
          myAffectedSiteCount: mySites.length,
          myHighRiskAssets:    highRiskAssets,
        };
      })
    );

    // Only return events that affect at least one of our sites (or all if
    // the account has no sites yet — show everything so they're aware).
    const hasSites = (await prisma.site.count({ where: { accountId } })) > 0;
    const filtered = hasSites
      ? enriched.filter((ev) => ev.myAffectedSiteCount > 0 || ev.accountId === accountId)
      : enriched;

    res.json({ success: true, data: { events: filtered } });
  } catch (err) {
    console.error('GET /disaster-events/regional error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch regional events' });
  }
});

// ── GET /api/disaster-events/queue-position ───────────────────────────────────
// Returns this account's position in the emergency service queue.
// Position = count of OTHER accounts that declared before us in the same
// region (affectedStates overlap), plus 1.
router.get('/queue-position', async (req: any, res) => {
  try {
    const accountId = req.user.accountId;

    // Find this account's most recent active declaration.
    const myDeclaration: any = await prisma.disasterEvent.findFirst({
      where:   { accountId, source: 'manual', resolvedAt: null },
      orderBy: { declaredAt: 'desc' },
    });

    if (!myDeclaration) {
      return res.json({ success: true, data: { position: null, declaration: null } });
    }

    // Count declarations by OTHER accounts in overlapping states declared before ours.
    const earlierDeclarations: any[] = await prisma.disasterEvent.findMany({
      where: {
        source:     'manual',
        resolvedAt: null,
        accountId:  { not: accountId },
        declaredAt: { lt: myDeclaration.declaredAt },
      },
      select: { accountId: true, affectedStates: true, declaredAt: true },
    });

    // Filter to same region (state overlap).
    const myStates = new Set(myDeclaration.affectedStates);
    const sameRegion = earlierDeclarations.filter((d: any) =>
      d.affectedStates.some((s: string) => myStates.has(s))
    );

    // Distinct accounts in the queue ahead of us.
    const aheadAccounts = new Set(sameRegion.map((d: any) => d.accountId));
    const position = aheadAccounts.size + 1;

    res.json({
      success: true,
      data: {
        position,
        declaration: myDeclaration,
        totalAheadInRegion: aheadAccounts.size,
      },
    });
  } catch (err) {
    console.error('GET /disaster-events/queue-position error:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch queue position' });
  }
});

// ── POST /api/disaster-events/declare ────────────────────────────────────────
// Customer declares an emergency for their account. [manager+] — declaring an
// emergency creates an event + emails the rep (an outbound action), so it sits
// behind the writer-tier gate like /resolve and /scan; read-only roles can view
// but not declare. (F3)
router.post('/declare', requireManager, async (req: any, res) => {
  try {
    const accountId = req.user.accountId;
    const { eventType = 'manual', title, affectedSiteIds = [] } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ success: false, error: 'title is required' });
    }

    // Validate that supplied siteIds belong to this account.
    let validSiteIds: string[] = [];
    if (affectedSiteIds.length > 0) {
      const owned = await prisma.site.findMany({
        where: { id: { in: affectedSiteIds }, accountId, archivedAt: null },
        select: { id: true, state: true },
      });
      validSiteIds = owned.map((s) => s.id);

      // Derive affectedStates from the site records.
      const stateSet = new Set<string>();
      owned.forEach((s) => { if (s.state) stateSet.add(s.state.toUpperCase()); });
      var affectedStates = Array.from(stateSet);
    } else {
      // No sites specified — use account's sites to derive states.
      const sites = await prisma.site.findMany({
        where: { accountId, archivedAt: null },
        select: { id: true, state: true },
      });
      validSiteIds = sites.map((s) => s.id);
      const stateSet = new Set<string>();
      sites.forEach((s) => { if (s.state) stateSet.add(s.state.toUpperCase()); });
      var affectedStates = Array.from(stateSet);
    }

    // Create the declaration.
    const event: any = await prisma.disasterEvent.create({
      data: {
        accountId,
        eventType,
        severity:       'emergency',
        title:          title.trim().slice(0, 300),
        region:         affectedStates.join(', ') || 'unspecified',
        affectedStates,
        affectedSiteIds: validSiteIds,
        declaredBy:     req.user.id,
        source:         'manual',
      },
    });

    // Notify the service rep if configured.
    const account = await prisma.account.findUnique({
      where:  { id: accountId },
      select: { companyName: true, serviceRepName: true, serviceRepEmail: true, serviceRepPhone: true },
    });

    if (account?.serviceRepEmail) {
      const { sendEmail } = require('../lib/email');
      const esc = (v: any) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      sendEmail({
        to:      account.serviceRepEmail,
        subject: `[EMERGENCY] ${account.companyName} has declared an emergency — priority service needed`,
        html:    `<p>Hi ${esc(account.serviceRepName || 'Service Rep')},</p>` +
                 `<p><strong>${esc(account.companyName)}</strong> has declared an emergency in ServiceCycle.</p>` +
                 `<ul>` +
                 `<li><strong>Event:</strong> ${esc(title)}</li>` +
                 `<li><strong>Sites affected:</strong> ${validSiteIds.length}</li>` +
                 `<li><strong>States:</strong> ${esc(affectedStates.join(', '))}</li>` +
                 `</ul>` +
                 `<p>Log in to ServiceCycle to review their assets and triage the response.</p>`,
      }).catch((e: any) =>
        console.warn('[disasterEvents] Service rep email failed:', e.message)
      );
    }

    res.status(201).json({ success: true, data: { event } });
  } catch (err) {
    console.error('POST /disaster-events/declare error:', err);
    res.status(500).json({ success: false, error: 'Failed to create emergency declaration' });
  }
});

// ── POST /api/disaster-events/:id/resolve ────────────────────────────────────
// Resolve a declaration. [manager+] — matches the documented intent and the
// client (which only renders the Resolve control for admin/manager). Blocks
// read-only consultant/viewer writes, consistent with the sibling /scan route.
router.post('/:id/resolve', requireManager, async (req: any, res) => {
  try {
    const accountId = req.user.accountId;

    const event: any = await prisma.disasterEvent.findFirst({
      where: { id: req.params.id },
    });

    if (!event) {
      return res.status(404).json({ success: false, error: 'Event not found' });
    }

    // Tenancy: only the owning account can resolve their declaration;
    // admins can resolve system events that affect their account.
    if (event.accountId && event.accountId !== accountId) {
      return res.status(403).json({ success: false, error: 'Not authorised to resolve this event' });
    }

    if (event.resolvedAt) {
      return res.status(400).json({ success: false, error: 'Event is already resolved' });
    }

    const updated: any = await prisma.disasterEvent.update({
      where: { id: event.id },
      data:  { resolvedAt: new Date() },
    });

    res.json({ success: true, data: { event: updated } });
  } catch (err) {
    console.error('POST /disaster-events/:id/resolve error:', err);
    res.status(500).json({ success: false, error: 'Failed to resolve event' });
  }
});

// ── POST /api/weather/scan ────────────────────────────────────────────────────
// Manually trigger a NWS scan (admin only — useful for testing and in the
// Settings page as a "Force refresh" button).
router.post('/scan', requireManager, async (req: any, res) => {
  try {
    const { runWeatherScanner } = require('../lib/weatherScanner');
    const result = await runWeatherScanner();
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /disaster-events/scan error:', err);
    res.status(500).json({ success: false, error: 'Weather scan failed' });
  }
});

module.exports = router;
export {};
