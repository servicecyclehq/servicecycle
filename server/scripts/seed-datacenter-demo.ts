/**
 * scripts/seed-datacenter-demo.ts -- idempotent demo seeder for a realistic 2N data-center
 * site, used to showcase the multi-source topology + redundancy-impact engine.
 *
 * Attaches an "East Hall - 2N" site (dual utility + generators, A/B trains, UPS, RPP/PDU,
 * dual-corded IT racks, mechanical loads) with AssetFeed edges to an existing demo account
 * (prefers "Summit Data Center", else the first account). Safe to re-run: it wipes and
 * rebuilds only its own site. Run in-container: node node_modules/tsx/dist/cli.mjs scripts/seed-datacenter-demo.ts
 *
 * NOTE: not part of seed-demo.js, so a full demo reseed does NOT recreate this site --
 * re-run this script after a reseed if the data-center showcase is needed.
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const SITE_NAME = 'East Hall - 2N';

async function main() {
  const db = new PrismaClient();
  try {
    let acct = await db.account.findFirst({ where: { companyName: 'Summit Data Center' }, select: { id: true, companyName: true } });
    if (!acct) acct = await db.account.findFirst({ select: { id: true, companyName: true }, orderBy: { createdAt: 'asc' } });
    if (!acct) throw new Error('no account found to attach the demo site');
    const accountId = acct.id;

    let site = await db.site.findFirst({ where: { accountId, name: SITE_NAME }, select: { id: true } });
    if (!site) site = await db.site.create({ data: { accountId, name: SITE_NAME, oneLineDiagramOnFile: true }, select: { id: true } });
    const siteId = site.id;
    await db.assetFeed.deleteMany({ where: { siteId } });
    await db.asset.deleteMany({ where: { siteId } });

    const id: Record<string, string> = {};
    const A = async (tag: string, et: string, extra: any = {}) => {
      const a = await db.asset.create({ data: { accountId, siteId, equipmentType: et, model: tag, ...extra }, select: { id: true } });
      id[tag] = a.id; return a.id;
    };
    const F = async (load: string, src: string, role: string, side: string, sk: string, transfer: string | null = null) => {
      await db.assetFeed.create({ data: { accountId, siteId, loadAssetId: id[load], sourceAssetId: id[src], role, side, sourceKind: sk, transferAssetId: transfer ? id[transfer] : null } });
    };

    for (const s of ['A', 'B']) {
      await A(`UTIL-${s}`, 'UTILITY_SERVICE');
      await A(`GEN-${s}`, 'GENERATOR');
      await A(`ATS-MV-${s}`, 'TRANSFER_SWITCH');
      await A(`MV-SWGR-${s}`, 'SWITCHGEAR');
      await A(`XFMR-${s}`, 'TRANSFORMER_LIQUID');
      await A(`LV-SWGR-${s}`, 'SWITCHGEAR');
      await A(`UPS-${s}`, 'UPS_BATTERY');
      await A(`CRIT-BUS-${s}`, 'SWITCHGEAR');
      await A(`RPP-${s}`, 'REMOTE_POWER_PANEL');
      await A(`PDU-${s}`, 'POWER_DISTRIBUTION_UNIT');
    }
    for (let i = 1; i <= 6; i++) await A(`RACK-${String(i).padStart(2, '0')}`, 'IT_RACK', { redundancyStatus: 'TWO_N' });
    for (let i = 1; i <= 2; i++) await A(`CRAH-${i}`, 'MECHANICAL_LOAD', { redundancyStatus: 'N_PLUS_1' });

    for (const s of ['A', 'B']) {
      await F(`MV-SWGR-${s}`, `UTIL-${s}`, 'normal', s, 'utility', `ATS-MV-${s}`);
      await F(`MV-SWGR-${s}`, `GEN-${s}`, 'emergency', s, 'generator', `ATS-MV-${s}`);
      await F(`XFMR-${s}`, `MV-SWGR-${s}`, 'normal', s, 'derived');
      await F(`LV-SWGR-${s}`, `XFMR-${s}`, 'normal', s, 'derived');
      await F(`UPS-${s}`, `LV-SWGR-${s}`, 'normal', s, 'derived');
      await F(`CRIT-BUS-${s}`, `UPS-${s}`, 'normal', s, 'ups');
      await F(`RPP-${s}`, `CRIT-BUS-${s}`, 'normal', s, 'derived');
      await F(`PDU-${s}`, `RPP-${s}`, 'normal', s, 'derived');
    }
    for (let i = 1; i <= 6; i++) { const r = `RACK-${String(i).padStart(2, '0')}`; await F(r, 'PDU-A', 'normal', 'A', 'derived'); await F(r, 'PDU-B', 'normal', 'B', 'derived'); }
    for (let i = 1; i <= 2; i++) { const c = `CRAH-${i}`; await F(c, 'LV-SWGR-A', 'normal', 'A', 'derived'); await F(c, 'LV-SWGR-B', 'normal', 'B', 'derived'); }

    const assets = await db.asset.count({ where: { siteId } });
    const feeds = await db.assetFeed.count({ where: { siteId } });
    console.log(`[seed-datacenter-demo] account=${acct.companyName} site=${siteId} assets=${assets} feeds=${feeds}`);
  } finally {
    await db.$disconnect();
  }
}
main().catch((e) => { console.error('[seed-datacenter-demo] ERR', e.message); process.exit(1); });
export {};
