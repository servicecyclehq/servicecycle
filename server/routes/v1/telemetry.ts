/**
 * Phase 4 #8 -- continuous condition-monitoring telemetry (v1 public API).
 *
 *   POST /api/v1/telemetry/channels            -- create/update a channel + thresholds (write)
 *   GET  /api/v1/telemetry/channels            -- list channels (+ last status)
 *   POST /api/v1/telemetry/readings            -- batch ingest readings (write, idempotent)
 *   GET  /api/v1/telemetry/readings            -- time-series read
 *   GET  /api/v1/telemetry/notifications       -- open/all breach notifications
 *   POST /api/v1/telemetry/notifications/:id/acknowledge  -- clear a notification (write)
 *
 * Auth: API key (apiKeyAuth sets req.apiKeyAccountId + req.apiKeyScopes). Reads
 * accept any valid key; writes require the 'write' scope. Ingest is the
 * forward-looking moat: a CRIT reading escalates the asset to NFPA 70B:2023
 * Condition 2 until the notification is addressed (see lib/telemetryMonitoring).
 *
 * Edge gateways speaking OPC-UA + MQTT/Sparkplug B bridge onto POST /readings;
 * see docs/api/TELEMETRY.md.
 */

const router = require('express').Router();
const { z } = require('zod');
import prisma from '../../lib/prisma';
const { requireScope } = require('../../middleware/apiKeyAuth');
const { normalizeKey, findStored, store } = require('../../lib/apiIdempotency');
const { ingestReading, applyMonitoringState } = require('../../lib/telemetryMonitoring');

const UUID = /^[0-9a-f-]{36}$/i;
const KEY_RE = /^[A-Za-z0-9_.:-]{1,120}$/;
const MAX_BATCH = 1000;

const dateLike = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));
const threshold = z.number().finite().nullable().optional();

const ChannelSchema = z.object({
  assetId: z.string().regex(UUID),
  key:     z.string().regex(KEY_RE),
  label:   z.string().max(160).optional(),
  unit:    z.string().max(40).optional(),
  warnHigh: threshold, critHigh: threshold, warnLow: threshold, critLow: threshold,
  enabled: z.boolean().optional(),
});

const ReadingSchema = z.object({
  assetId:    z.string().regex(UUID),
  channel:    z.string().regex(KEY_RE),
  value:      z.number().finite(),
  unit:       z.string().max(40).optional(),
  recordedAt: dateLike.optional(),
  source:     z.string().max(120).optional(),
  externalId: z.string().max(200).optional(),
});
const BatchSchema = z.object({ readings: z.array(ReadingSchema).min(1).max(MAX_BATCH) });

const CHANNEL_SELECT: any = {
  id: true, assetId: true, key: true, label: true, unit: true,
  warnHigh: true, critHigh: true, warnLow: true, critLow: true,
  enabled: true, lastValue: true, lastStatus: true, lastReadingAt: true, createdAt: true, updatedAt: true,
};

// -- POST /channels (write) -- create or update a channel by (assetId, key) ----
router.post('/channels', requireScope('write'), async (req: any, res: any) => {
  const accountId = req.apiKeyAccountId;
  const parsed = ChannelSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  const b = parsed.data;
  try {
    const asset = await prisma.asset.findFirst({ where: { id: b.assetId, accountId, archivedAt: null }, select: { id: true } });
    if (!asset) return res.status(404).json({ success: false, error: 'Asset not found' });

    const data: any = { label: b.label ?? undefined, unit: b.unit ?? undefined, enabled: b.enabled ?? undefined };
    for (const k of ['warnHigh', 'critHigh', 'warnLow', 'critLow'] as const) {
      if (b[k] !== undefined) data[k] = b[k]; // null clears, number sets
    }
    const channel = await prisma.telemetryChannel.upsert({
      where: { assetId_key: { assetId: b.assetId, key: b.key } },
      create: { accountId, assetId: b.assetId, key: b.key, ...data },
      update: data,
      select: CHANNEL_SELECT,
    });
    return res.status(201).json({ success: true, data: channel });
  } catch (err: any) {
    console.error('[v1/telemetry] channel upsert error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// -- GET /channels -------------------------------------------------------------
router.get('/channels', async (req: any, res: any) => {
  const accountId = req.apiKeyAccountId;
  const where: any = { accountId };
  if (req.query.assetId) {
    if (!UUID.test(String(req.query.assetId))) return res.status(400).json({ success: false, error: 'Invalid assetId' });
    where.assetId = String(req.query.assetId);
  }
  try {
    const channels = await prisma.telemetryChannel.findMany({ where, select: CHANNEL_SELECT, orderBy: [{ assetId: 'asc' }, { key: 'asc' }] });
    return res.json({ success: true, data: channels });
  } catch (err: any) {
    console.error('[v1/telemetry] channel list error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// -- POST /readings (write, idempotent) -- batch ingest ------------------------
router.post('/readings', requireScope('write'), async (req: any, res: any) => {
  const accountId = req.apiKeyAccountId;
  const idemKey = normalizeKey(req);
  if (idemKey) {
    const prior = await findStored(prisma, accountId, idemKey);
    if (prior) { res.set('Idempotent-Replay', 'true'); return res.status(prior.statusCode).json(prior.responseBody); }
  }

  const parsed = BatchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
  const readings = parsed.data.readings;

  try {
    // Resolve (and auto-create) the channels referenced by this batch up front.
    // assetMap: assetId -> exists?  channelMap: "assetId::key" -> channelId
    const assetIds: string[] = Array.from(new Set<string>(readings.map((r) => r.assetId as string)));
    const ownedAssets = await prisma.asset.findMany({ where: { id: { in: assetIds }, accountId, archivedAt: null }, select: { id: true } });
    const owned = new Set(ownedAssets.map((a: any) => a.id));

    const channelMap = new Map<string, string>();
    for (const r of readings) {
      if (!owned.has(r.assetId)) continue;
      const mapKey = `${r.assetId}::${r.channel}`;
      if (channelMap.has(mapKey)) continue;
      const ch = await prisma.telemetryChannel.upsert({
        where: { assetId_key: { assetId: r.assetId, key: r.channel } },
        create: { accountId, assetId: r.assetId, key: r.channel, unit: r.unit ?? null },
        update: {},
        select: { id: true },
      });
      channelMap.set(mapKey, ch.id);
    }

    const results: any[] = [];
    let accepted = 0, breaches = 0, duplicates = 0;
    for (const r of readings) {
      if (!owned.has(r.assetId)) { results.push({ assetId: r.assetId, channel: r.channel, accepted: false, error: 'asset_not_found' }); continue; }
      const channelId = channelMap.get(`${r.assetId}::${r.channel}`)!;
      const recordedAt = r.recordedAt ? new Date(r.recordedAt) : new Date();
      if (Number.isNaN(recordedAt.getTime())) { results.push({ assetId: r.assetId, channel: r.channel, accepted: false, error: 'invalid_recordedAt' }); continue; }
      // Each reading is atomic: reading + channel state + notification + asset recompute.
      const out = await prisma.$transaction(async (tx: any) => {
        const channel = await tx.telemetryChannel.findUnique({ where: { id: channelId }, select: CHANNEL_SELECT });
        return ingestReading(tx, { accountId, asset: { id: r.assetId }, channel, value: r.value, unit: r.unit, recordedAt, source: r.source, externalId: r.externalId });
      });
      accepted++;
      if (out.duplicate) duplicates++;
      if (out.notificationOpened) breaches++;
      results.push({ assetId: r.assetId, channel: r.channel, accepted: true, status: out.status, duplicate: out.duplicate, notificationOpened: out.notificationOpened, governingCondition: out.governingCondition });
    }

    const responseBody = { success: true, data: { accepted, breaches, duplicates, total: readings.length, results } };
    await store(prisma, { accountId, key: idemKey, method: 'POST', path: '/api/v1/telemetry/readings', statusCode: 201, body: responseBody });
    return res.status(201).json(responseBody);
  } catch (err: any) {
    console.error('[v1/telemetry] ingest error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// -- GET /readings -------------------------------------------------------------
router.get('/readings', async (req: any, res: any) => {
  const accountId = req.apiKeyAccountId;
  const Q = z.object({
    assetId: z.string().regex(UUID).optional(),
    channel: z.string().regex(KEY_RE).optional(),
    since:   dateLike.optional(),
    page:    z.coerce.number().int().positive().default(1),
    limit:   z.coerce.number().int().min(1).max(500).default(100),
  }).safeParse(req.query);
  if (!Q.success) return res.status(400).json({ success: false, error: 'Invalid query parameters', details: Q.error.flatten().fieldErrors });
  const { assetId, channel, since, page, limit } = Q.data;
  const where: any = { accountId };
  if (assetId) where.assetId = assetId;
  if (since) where.recordedAt = { gte: new Date(since) };
  if (channel) {
    const chs = await prisma.telemetryChannel.findMany({ where: { accountId, key: channel, ...(assetId ? { assetId } : {}) }, select: { id: true } });
    where.channelId = { in: chs.map((c: any) => c.id) };
  }
  try {
    const [total, rows] = await Promise.all([
      prisma.telemetryReading.count({ where }),
      prisma.telemetryReading.findMany({ where, orderBy: { recordedAt: 'desc' }, skip: (page - 1) * limit, take: limit,
        select: { id: true, assetId: true, channelId: true, value: true, unit: true, status: true, recordedAt: true, source: true, externalId: true, createdAt: true } }),
    ]);
    return res.json({ success: true, data: rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err: any) {
    console.error('[v1/telemetry] readings list error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// -- GET /notifications --------------------------------------------------------
router.get('/notifications', async (req: any, res: any) => {
  const accountId = req.apiKeyAccountId;
  const status = String(req.query.status || 'open');
  const where: any = { accountId };
  if (status === 'open') where.acknowledgedAt = null;
  if (req.query.assetId) {
    if (!UUID.test(String(req.query.assetId))) return res.status(400).json({ success: false, error: 'Invalid assetId' });
    where.assetId = String(req.query.assetId);
  }
  try {
    const rows = await prisma.telemetryNotification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200,
      select: { id: true, assetId: true, channelId: true, status: true, value: true, threshold: true, thresholdKind: true, message: true, acknowledgedAt: true, autoResolved: true, createdAt: true } });
    return res.json({ success: true, data: rows, count: rows.length });
  } catch (err: any) {
    console.error('[v1/telemetry] notifications list error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// -- POST /notifications/:id/acknowledge (write) -------------------------------
router.post('/notifications/:id/acknowledge', requireScope('write'), async (req: any, res: any) => {
  const accountId = req.apiKeyAccountId;
  const { id } = req.params;
  if (!UUID.test(id)) return res.status(400).json({ success: false, error: 'Invalid notification ID' });
  try {
    const notif = await prisma.telemetryNotification.findFirst({ where: { id, accountId }, select: { id: true, assetId: true, acknowledgedAt: true } });
    if (!notif) return res.status(404).json({ success: false, error: 'Notification not found' });
    if (!notif.acknowledgedAt) {
      await prisma.telemetryNotification.update({ where: { id: notif.id }, data: { acknowledgedAt: new Date() } });
      await applyMonitoringState(prisma, accountId, notif.assetId);
    }
    const fresh = await prisma.telemetryNotification.findUnique({ where: { id: notif.id }, select: { id: true, status: true, acknowledgedAt: true, autoResolved: true } });
    return res.json({ success: true, data: fresh });
  } catch (err: any) {
    console.error('[v1/telemetry] acknowledge error:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;

export {};
