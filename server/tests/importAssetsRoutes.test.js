'use strict';

/**
 * routes/importAssets (SMART CSV/XLSX importer with AI column mapping) --
 * contract suite. In-memory express + fake prisma (same pattern as
 * workOrderFromDeficiency.test.js: jest.config's moduleNameMapper points every
 * '../lib/prisma' request at the global stub; we override that module with a
 * stateful fake). lib/ai is mocked (no provider layer); middleware/roles is
 * REAL so the viewer/consultant 403 is the production gate.
 *
 * Guards:
 *   - requireManager: viewer + consultant get 403 on both endpoints
 *   - preview: synonym/exact mapping tiers with per-column confidence,
 *     unmapped columns, AI merge (source 'ai') incl. the claimed-target steal
 *     guard, AI_ENABLED=false fail-soft, user-mapping re-validation pass,
 *     multipart file upload + extension filter, row cap
 *   - commit: server-side re-validation, per-row outcomes
 *     created|skipped_duplicate|error, TENANCY (foreign sites invisible,
 *     foreign serials never dedupe), normalized-serial duplicate skip
 *     (O->0/I->1) + manufacturer veto, serial-less identity-tuple skip,
 *     in-file repeats, IDEMPOTENT RE-RUN of the same payload, partial
 *     success, allowCreateSites gating (per-row error when off, site create
 *     when on), custom-field value persistence, mapping guards (duplicate
 *     targets / missing required), single assets_imported activity row with
 *     counts
 */

jest.mock('../lib/prisma', () => {
  const state = {
    sites: [], buildings: [], areas: [], positions: [],
    assets: [], customFieldDefs: [], customFieldValues: [],
    seq: 0, txCount: 0,
  };
  const lcx = (s) => String(s == null ? '' : s).trim().toLowerCase();

  const client = {
    customFieldDefinition: {
      findMany: async ({ where }) =>
        state.customFieldDefs.filter((d) => d.accountId === where.accountId && d.archivedAt == null),
    },
    site: {
      findMany: async ({ where }) => {
        const names = (where.OR || []).map((o) => lcx(o.name.equals));
        return state.sites
          .filter((s) => s.accountId === where.accountId && names.includes(lcx(s.name)))
          .map((s) => ({ id: s.id, name: s.name }));
      },
      create: async ({ data }) => {
        const site = { id: `site-new-${++state.seq}`, ...data };
        state.sites.push(site);
        return { id: site.id, name: site.name };
      },
    },
    building: {
      findMany: async ({ where }) =>
        state.buildings.filter((b) => b.accountId === where.accountId && where.siteId.in.includes(b.siteId)),
      create: async ({ data }) => {
        const b = { id: `bld-${++state.seq}`, ...data };
        state.buildings.push(b);
        return { id: b.id, siteId: b.siteId, name: b.name };
      },
    },
    area: {
      findMany: async ({ where }) =>
        state.areas.filter((a) => a.accountId === where.accountId && where.siteId.in.includes(a.siteId)),
      create: async ({ data }) => {
        const a = { id: `area-${++state.seq}`, buildingId: null, ...data };
        state.areas.push(a);
        return { id: a.id, siteId: a.siteId, buildingId: a.buildingId, name: a.name };
      },
    },
    equipmentPosition: {
      findMany: async ({ where }) =>
        state.positions.filter((p) => p.accountId === where.accountId && where.siteId.in.includes(p.siteId)),
      create: async ({ data }) => {
        const p = { id: `pos-${++state.seq}`, areaId: null, ...data };
        state.positions.push(p);
        return { id: p.id, siteId: p.siteId, areaId: p.areaId, name: p.name };
      },
    },
    asset: {
      findMany: async ({ where }) => {
        let list = state.assets.filter((a) => a.accountId === where.accountId && a.archivedAt == null);
        if (where.serialNumber && where.serialNumber.not === null) list = list.filter((a) => a.serialNumber != null);
        if (where.siteId && where.siteId.in) list = list.filter((a) => where.siteId.in.includes(a.siteId));
        if (where.equipmentType && where.equipmentType.in) list = list.filter((a) => where.equipmentType.in.includes(a.equipmentType));
        return list.map((a) => ({
          ...a,
          position: a.positionId
            ? { name: (state.positions.find((p) => p.id === a.positionId) || {}).name || null }
            : null,
        }));
      },
      create: async ({ data }) => {
        const asset = { id: `asset-new-${++state.seq}`, archivedAt: null, ...data };
        state.assets.push(asset);
        return { id: asset.id };
      },
    },
    customFieldValue: {
      createMany: async ({ data }) => {
        state.customFieldValues.push(...data);
        return { count: data.length };
      },
    },
    $transaction: async (fn) => {
      state.txCount++;
      return fn(client);
    },
  };

  globalThis.__iaState = state;
  client.default = client;
  return client;
});

jest.mock('../lib/activityLog', () => ({ writeLog: jest.fn() }));
jest.mock('../lib/ai', () => ({
  complete: jest.fn(),
  parseJSON: (text) => {
    const cleaned = String(text || '').trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(cleaned);
  },
}));
// middleware/roles stays REAL -- the viewer 403 must be the production gate.

const express = require('express');
const request = require('supertest');
const { writeLog } = require('../lib/activityLog');
const ai = require('../lib/ai');

const state = () => globalThis.__iaState;
const OLD_AI_ENABLED = process.env.AI_ENABLED;

let app;
let currentUser;

beforeAll(() => {
  const router = require('../routes/importAssets');
  app = express();
  app.use(express.json({ limit: '6mb' }));
  app.use((req, res, next) => {
    req.user = currentUser;
    next();
  });
  app.use('/api/import/assets', router);
});

beforeEach(() => {
  currentUser = { id: 'user-a', accountId: 'acct-a', role: 'manager', name: 'Mgr', email: 'mgr@a.test' };
  const s = state();
  s.sites = [
    { id: 'site-1', accountId: 'acct-a', name: 'Eastgate Plant' },
    { id: 'site-b', accountId: 'acct-b', name: 'Westgate Works' },
  ];
  s.buildings = [];
  s.areas = [];
  s.positions = [];
  s.assets = [
    { id: 'asset-ex1', accountId: 'acct-a', siteId: 'site-1', equipmentType: 'PANELBOARD', manufacturer: 'Eaton', model: null, serialNumber: 'SN-100', positionId: null, archivedAt: null },
    { id: 'asset-bx',  accountId: 'acct-b', siteId: 'site-b', equipmentType: 'PANELBOARD', manufacturer: 'Eaton', model: null, serialNumber: 'SN-200', positionId: null, archivedAt: null },
  ];
  s.customFieldDefs = [
    { id: 'cfdef-1', accountId: 'acct-a', name: 'Feeder Tag', type: 'text',   options: null, archivedAt: null, displayOrder: 0 },
    { id: 'cfdef-2', accountId: 'acct-a', name: 'Panel Amps', type: 'number', options: null, archivedAt: null, displayOrder: 1 },
  ];
  s.customFieldValues = [];
  s.txCount = 0;
  writeLog.mockClear();
  ai.complete.mockReset();
  if (OLD_AI_ENABLED === undefined) delete process.env.AI_ENABLED;
  else process.env.AI_ENABLED = OLD_AI_ENABLED;
});

const preview = (body) => request(app).post('/api/import/assets/preview').send(body);
const commit  = (body) => request(app).post('/api/import/assets/commit').send(body);

const CSV_BASIC = 'Facility,Equipment Type,Mfr,S/N,Widget Kind\nEastgate Plant,Panelboard,Eaton,SN-900,ACME-9\n';

// --- Role gate ------------------------------------------------------------------

describe('requireManager gate', () => {
  test.each(['viewer', 'consultant'])('%s gets 403 on preview and commit', async (role) => {
    currentUser.role = role;
    const p = await preview({ text: CSV_BASIC });
    expect(p.status).toBe(403);
    expect(p.body.error).toBe('Manager or admin access required');
    const c = await commit({ rows: [{ A: '1' }], mapping: { A: 'siteName' } });
    expect(c.status).toBe(403);
    expect(state().assets).toHaveLength(2); // nothing written
  });
});

// --- Preview ----------------------------------------------------------------------

describe('POST /preview', () => {
  test('maps synonym + exact tiers with confidence and lists unmapped columns', async () => {
    const res = await preview({ text: CSV_BASIC });
    expect(res.status).toBe(200);
    const d = res.body.data;

    expect(d.totalRows).toBe(1);
    expect(d.headers).toEqual(['Facility', 'Equipment Type', 'Mfr', 'S/N', 'Widget Kind']);
    expect(d.mapping['Facility']).toEqual({ field: 'siteName', confidence: 0.85, source: 'synonym' });
    expect(d.mapping['Equipment Type']).toEqual({ field: 'equipmentType', confidence: 1, source: 'exact' });
    expect(d.mapping['Mfr'].field).toBe('manufacturer');
    expect(d.mapping['S/N'].field).toBe('serialNumber');
    expect(d.mapping['Widget Kind'].field).toBe(null); // AI unmocked -> fail-soft
    expect(d.unmappedColumns).toEqual(['Widget Kind']);
    expect(d.missingRequired).toEqual([]);
    expect(d.validation).toMatchObject({ totalRows: 1, validCount: 1, errorCount: 0 });
    expect(d.rows).toHaveLength(1); // echo for commit
    expect(d.columns.find((c) => c.header === 'Mfr').samples).toEqual(['Eaton']);
    // Custom-field definitions surface as mapping targets.
    expect(d.targetFields.some((f) => f.key === 'cf:cfdef-1')).toBe(true);
  });

  test('AI assist fills unresolved headers (source ai) but cannot steal claimed targets', async () => {
    // This test exercises the AI path, so it must not inherit an ambient
    // AI_ENABLED=false from the runner env (central verification sets it).
    process.env.AI_ENABLED = 'true';
    ai.complete.mockResolvedValue({
      text: JSON.stringify({
        mapping: {
          'Widget Kind': { field: 'model', confidence: 0.8 },
          'Mystery':     { field: 'siteName', confidence: 0.95 }, // already claimed by Facility
        },
      }),
    });
    const csv = 'Facility,Equipment Type,Widget Kind,Mystery\nEastgate Plant,Panelboard,ACME-9,huh\n';
    const res = await preview({ text: csv });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.mapping['Widget Kind']).toEqual({ field: 'model', confidence: 0.8, source: 'ai' });
    expect(d.mapping['Mystery'].field).toBe(null); // steal guard
    expect(d.aiUsed).toBe(true);
    expect(ai.complete).toHaveBeenCalledTimes(1);
  });

  test('AI_ENABLED=false: deterministic-only, provider never called, still 200', async () => {
    process.env.AI_ENABLED = 'false';
    const res = await preview({ text: CSV_BASIC });
    expect(res.status).toBe(200);
    expect(res.body.data.mapping['Widget Kind'].field).toBe(null);
    expect(res.body.data.aiUsed).toBe(false);
    expect(ai.complete).not.toHaveBeenCalled();
  });

  test('provider failure is fail-soft: unresolved stays unmapped, still 200', async () => {
    ai.complete.mockRejectedValue(new Error('boom'));
    const res = await preview({ text: CSV_BASIC });
    expect(res.status).toBe(200);
    expect(res.body.data.mapping['Widget Kind'].field).toBe(null);
    expect(res.body.data.aiUsed).toBe(false);
  });

  test('user-edited mapping re-validates without re-guessing; bad targets nulled', async () => {
    const res = await preview({
      text: CSV_BASIC,
      mapping: { Facility: 'siteName', 'Equipment Type': 'equipmentType', Mfr: 'notARealField', 'Widget Kind': 'model' },
    });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.mapping['Facility']).toEqual({ field: 'siteName', confidence: 1, source: 'user' });
    expect(d.mapping['Widget Kind'].source).toBe('user');
    expect(d.mapping['Mfr'].field).toBe(null);       // unknown target dropped
    expect(d.mapping['S/N'].field).toBe(null);       // not in user mapping -> unmapped
    expect(ai.complete).not.toHaveBeenCalled();      // no AI on the re-validate pass
    expect(d.validation.validCount).toBe(1);
  });

  test('multipart file upload parses CSV; wrong extension rejected', async () => {
    const buf = Buffer.from('Site,Type\nEastgate Plant,Switchgear\n', 'utf8');
    const ok = await request(app)
      .post('/api/import/assets/preview')
      .attach('file', buf, 'plant-assets.csv');
    expect(ok.status).toBe(200);
    expect(ok.body.data.mapping['Site'].field).toBe('siteName');
    expect(ok.body.data.mapping['Type'].field).toBe('equipmentType');

    const bad = await request(app)
      .post('/api/import/assets/preview')
      .attach('file', buf, 'plant-assets.txt');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/\.csv or \.xlsx/);
  });

  test('input guards: no input 400, empty rows 400, row cap 400', async () => {
    expect((await preview({})).status).toBe(400);
    expect((await preview({ text: 'Site,Type\n' })).status).toBe(400);
    const big = 'Site,Type\n' + Array(501).fill('A,Panelboard').join('\n');
    const res = await preview({ text: big });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/500-row cap/);
  });

  test('row validation errors are reported per row', async () => {
    const csv = 'Site,Type,Installed\nEastgate Plant,Panelboard,2020-01-01\nEastgate Plant,coffee machine,garbage\n';
    const res = await preview({ text: csv });
    expect(res.status).toBe(200);
    const v = res.body.data.validation;
    expect(v.validCount).toBe(1);
    expect(v.errorCount).toBe(1);
    expect(v.errors[0].row).toBe(3);
    expect(v.errors[0].errors.map((e) => e.field)).toEqual(expect.arrayContaining(['equipmentType', 'installDate']));
  });
});

// --- Commit -------------------------------------------------------------------------

const MAPPING = { Site: 'siteName', Type: 'equipmentType', Make: 'manufacturer', Model: 'model', Serial: 'serialNumber' };
const ROW_SERIALED    = { Site: 'eastgate plant', Type: 'Dry-type transformer', Make: 'Square D', Model: 'DST-750', Serial: 'SN-NEW-1' };
const ROW_SERIALLESS  = { Site: 'Eastgate Plant', Type: 'Switchgear', Make: 'ABB', Model: 'SG-500', Serial: '' };

describe('POST /commit', () => {
  test('creates assets with tenant + site scoping and logs ONE assets_imported row', async () => {
    const res = await commit({ rows: [ROW_SERIALED, ROW_SERIALLESS], mapping: MAPPING });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.created).toBe(2);
    expect(d.skippedDuplicates).toBe(0);
    expect(d.errorCount).toBe(0);
    expect(d.outcomes).toEqual([
      expect.objectContaining({ row: 2, outcome: 'created', assetId: expect.any(String) }),
      expect.objectContaining({ row: 3, outcome: 'created', assetId: expect.any(String) }),
    ]);

    const created = state().assets.slice(2);
    expect(created).toHaveLength(2);
    for (const a of created) {
      expect(a.accountId).toBe('acct-a');            // TENANCY
      expect(a.siteId).toBe('site-1');               // case-insensitive site match
    }
    expect(created[0].equipmentType).toBe('TRANSFORMER_DRY');
    expect(created[0].governingCondition).toBe('C2'); // axis defaults
    expect(created[0].inService).toBe(true);

    const importLogs = writeLog.mock.calls.filter(([p]) => p.action === 'assets_imported');
    expect(importLogs).toHaveLength(1);
    expect(importLogs[0][0]).toMatchObject({
      accountId: 'acct-a',
      userId: 'user-a',
      details: expect.objectContaining({ created: 2, skippedDuplicates: 0, errorRows: 0, totalRows: 2 }),
    });
  });

  test('RE-RUNNING the same payload creates nothing (serialed + serial-less both skip)', async () => {
    const payload = { rows: [ROW_SERIALED, ROW_SERIALLESS], mapping: MAPPING };
    const first = await commit(payload);
    expect(first.body.data.created).toBe(2);

    const second = await commit(payload);
    expect(second.status).toBe(200);
    expect(second.body.data.created).toBe(0);
    expect(second.body.data.skippedDuplicates).toBe(2);
    expect(second.body.data.outcomes.every((o) => o.outcome === 'skipped_duplicate')).toBe(true);
    expect(second.body.data.outcomes[0].existingAssetId).toBeTruthy();
    expect(state().assets).toHaveLength(4); // 2 seeded + 2 from the first run only
  });

  test('normalized-serial duplicates skip with the existing asset id (O->0 fold)', async () => {
    const res = await commit({
      rows: [{ Site: 'Eastgate Plant', Type: 'Panelboard', Make: 'Eaton', Model: '', Serial: 'SN-1OO' }],
      mapping: MAPPING,
    });
    expect(res.body.data.outcomes[0]).toMatchObject({
      outcome: 'skipped_duplicate',
      existingAssetId: 'asset-ex1',
    });
    expect(res.body.data.created).toBe(0);
  });

  test('a conflicting manufacturer vetoes the serial match (row is created)', async () => {
    const res = await commit({
      rows: [{ Site: 'Eastgate Plant', Type: 'Panelboard', Make: 'Siemens', Model: '', Serial: 'SN-100' }],
      mapping: MAPPING,
    });
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.outcomes[0].outcome).toBe('created');
  });

  test('TENANCY: a serial existing only in another account never dedupes', async () => {
    const res = await commit({
      rows: [{ Site: 'Eastgate Plant', Type: 'Panelboard', Make: 'Eaton', Model: '', Serial: 'SN-200' }],
      mapping: MAPPING,
    });
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.skippedDuplicates).toBe(0);
  });

  test('in-file serial repeats: first creates, repeat skips', async () => {
    const row = { Site: 'Eastgate Plant', Type: 'Generator', Make: 'Cat', Model: 'G-1', Serial: 'GEN-7' };
    const res = await commit({ rows: [row, { ...row }], mapping: MAPPING });
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.skippedDuplicates).toBe(1);
    expect(res.body.data.outcomes[1].reason).toMatch(/repeats earlier/);
  });

  test('partial success: bad rows error, good rows still commit', async () => {
    const res = await commit({
      rows: [ROW_SERIALED, { Site: 'Eastgate Plant', Type: 'coffee machine', Make: '', Model: '', Serial: '' }],
      mapping: MAPPING,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.errorCount).toBe(1);
    expect(res.body.data.outcomes[1].outcome).toBe('error');
    expect(res.body.data.outcomes[1].errors[0].field).toBe('equipmentType');
    const log = writeLog.mock.calls.find(([p]) => p.action === 'assets_imported')[0];
    expect(log.details).toMatchObject({ created: 1, errorRows: 1 });
  });

  test('unknown site without allowCreateSites: per-row error, no site created', async () => {
    const res = await commit({
      rows: [{ ...ROW_SERIALED, Site: 'Brand New Site' }, ROW_SERIALLESS],
      mapping: MAPPING,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1); // the known-site row still lands
    expect(res.body.data.sitesCreated).toBe(0);
    expect(res.body.data.outcomes[0].outcome).toBe('error');
    expect(res.body.data.outcomes[0].errors[0].error).toMatch(/Unknown site "Brand New Site"/);
    expect(state().sites.filter((s) => s.accountId === 'acct-a')).toHaveLength(1);
  });

  test('allowCreateSites=true creates the site (tenant-scoped) and the asset under it', async () => {
    const res = await commit({
      rows: [{ ...ROW_SERIALED, Site: 'Brand New Site' }],
      mapping: MAPPING,
      allowCreateSites: 'true',
    });
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.sitesCreated).toBe(1);
    const newSite = state().sites.find((s) => s.name === 'Brand New Site');
    expect(newSite).toBeTruthy();
    expect(newSite.accountId).toBe('acct-a');
    expect(state().assets[2].siteId).toBe(newSite.id);
  });

  test('TENANCY: another tenant\'s site name is invisible (treated as unknown)', async () => {
    const res = await commit({
      rows: [{ ...ROW_SERIALED, Site: 'Westgate Works' }],
      mapping: MAPPING,
    });
    expect(res.body.data.created).toBe(0);
    expect(res.body.data.outcomes[0].outcome).toBe('error');
    expect(res.body.data.outcomes[0].errors[0].error).toMatch(/Unknown site/);
  });

  test('hierarchy: building auto-creates under allowCreateSites and is reused across rows', async () => {
    const mapping = { ...MAPPING, Building: 'buildingName' };
    const res = await commit({
      rows: [
        { ...ROW_SERIALED, Building: 'Bldg A' },
        { ...ROW_SERIALLESS, Building: 'bldg a' },
      ],
      mapping,
      allowCreateSites: 'true',
    });
    expect(res.body.data.created).toBe(2);
    expect(state().buildings).toHaveLength(1); // case-insensitive cache reuse
    expect(state().assets[2].buildingId).toBe(state().buildings[0].id);
    expect(state().assets[3].buildingId).toBe(state().buildings[0].id);
  });

  test('custom-field values persist through the shared definition validator', async () => {
    const mapping = { ...MAPPING, 'Feeder Tag': 'cf:cfdef-1' };
    const res = await commit({
      rows: [{ ...ROW_SERIALED, 'Feeder Tag': 'FT-9' }],
      mapping,
    });
    expect(res.body.data.created).toBe(1);
    expect(state().customFieldValues).toEqual([
      { assetId: state().assets[2].id, definitionId: 'cfdef-1', value: 'FT-9' },
    ]);
  });

  test('invalid custom-field value is a row error (number definition)', async () => {
    const mapping = { ...MAPPING, Amps: 'cf:cfdef-2' };
    const res = await commit({
      rows: [{ ...ROW_SERIALED, Amps: 'not-a-number' }],
      mapping,
    });
    expect(res.body.data.created).toBe(0);
    expect(res.body.data.outcomes[0].outcome).toBe('error');
    expect(res.body.data.outcomes[0].errors[0].field).toBe('cf:cfdef-2');
  });

  test('mapping guards: duplicate targets and missing required 400 before any write', async () => {
    const dup = await commit({
      rows: [ROW_SERIALED],
      mapping: { Site: 'siteName', Type: 'equipmentType', Make: 'manufacturer', Model: 'manufacturer' },
    });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toMatch(/same field/);

    const missing = await commit({ rows: [ROW_SERIALED], mapping: { Make: 'manufacturer' } });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/Missing required column/);
    expect(state().assets).toHaveLength(2);
  });

  test('payload guards: rows/mapping shape and row cap', async () => {
    expect((await commit({ mapping: MAPPING })).status).toBe(400);
    expect((await commit({ rows: [], mapping: MAPPING })).status).toBe(400);
    expect((await commit({ rows: 'nope', mapping: MAPPING })).status).toBe(400);
    expect((await commit({ rows: [ROW_SERIALED] })).status).toBe(400);
    const tooMany = Array(501).fill(ROW_SERIALED);
    const res = await commit({ rows: tooMany, mapping: MAPPING });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/500-row cap/);
  });

  test('multipart commit: rows/mapping as JSON form fields work end-to-end', async () => {
    const res = await request(app)
      .post('/api/import/assets/commit')
      .field('rows', JSON.stringify([ROW_SERIALED]))
      .field('mapping', JSON.stringify(MAPPING))
      .field('allowCreateSites', 'false');
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(1);
  });
});
