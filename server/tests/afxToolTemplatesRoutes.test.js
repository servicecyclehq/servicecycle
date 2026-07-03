'use strict';

/**
 * /api/arc-flash/afx/tool-templates* + the toolTemplate pre-mapping on
 * /afx/import-multi/preview. Mounts the REAL router with the REAL roles
 * middleware on a throwaway express app (same harness as
 * arcFlashIngestAuthScope.test.js) so the gates below are genuine:
 *   - GET tool-template reads are any-authed (matches /afx/spec + /afx/template)
 *   - POST /afx/import-multi/preview stays requireManager
 *   - toolTemplate pre-maps vendor CSV → AFX → tables BEFORE the existing
 *     validation/plan, which remains the source of truth
 *   - PPE columns are provably dropped end-to-end at the route boundary
 */

jest.mock('../lib/prisma', () => {
  const client = {
    // One existing bus so the preview plan proves matched-vs-new splitting.
    systemStudyAsset: {
      findMany: async () => [
        { busName: 'FICTION-MCC-N1', nominalVoltage: null, cableLengthFt: null, cableSize: null, cableMaterial: null, conductorsPerPhase: null },
      ],
    },
    activityLog: { create: async () => ({}) },
  };
  client.default = client;
  return client;
});

jest.mock('../lib/activityLog', () => ({ writeLog: jest.fn() }));

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const FIXTURES = path.join(__dirname, '..', 'data', 'afx', 'fixtures');
const etapCsv = fs.readFileSync(path.join(FIXTURES, 'etap_result_analyzer_sample.csv'), 'utf8');

let currentUser;
let app;
beforeAll(() => {
  const router = require('../routes/arcFlashIngest');
  app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use('/api/arc-flash', router);
});

beforeEach(() => {
  currentUser = { id: 'user-m', accountId: 'acct-a', role: 'manager' };
});

describe('GET /afx/tool-templates — readable by any authed role (spec/template stance)', () => {
  test('viewer gets the three-tool list with confidence histograms + policy note', async () => {
    currentUser = { id: 'user-v', accountId: 'acct-a', role: 'viewer' };
    const res = await request(app).get('/api/arc-flash/afx/tool-templates');
    expect(res.status).toBe(200);
    const tools = res.body.data.tools.map((t) => t.tool).sort();
    expect(tools).toEqual(['easypower', 'etap', 'skm']);
    for (const t of res.body.data.tools) {
      expect(t.policyNote).toMatch(/PPE/);
      expect(t.ignoredByPolicyCount).toBeGreaterThan(0);
    }
  });

  test('viewer gets a single template with full mappings; unknown tool → 404', async () => {
    currentUser = { id: 'user-v', accountId: 'acct-a', role: 'viewer' };
    const ok = await request(app).get('/api/arc-flash/afx/tool-templates/skm');
    expect(ok.status).toBe(200);
    expect(ok.body.data.tool).toBe('skm');
    expect(ok.body.data.mappings.length).toBeGreaterThan(8);
    expect(ok.body.data.mappings.every((m) => ['verified', 'probable', 'assumed'].includes(m.confidence))).toBe(true);
    const nope = await request(app).get('/api/arc-flash/afx/tool-templates/powerworld');
    expect(nope.status).toBe(404);
    expect(nope.body.error).toMatch(/easypower, etap, skm/);
  });
});

describe('POST /afx/import-multi/preview — toolTemplate pre-mapping', () => {
  test('viewer is still blocked by requireManager (gate unchanged)', async () => {
    currentUser = { id: 'user-v', accountId: 'acct-a', role: 'viewer' };
    const res = await request(app)
      .post('/api/arc-flash/afx/import-multi/preview')
      .send({ toolTemplate: 'etap', csv: etapCsv });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Manager or admin access required' });
  });

  test('manager + toolTemplate:etap + fixture CSV → mapped, validated, planned (dry-run)', async () => {
    const res = await request(app)
      .post('/api/arc-flash/afx/import-multi/preview')
      .send({ toolTemplate: 'etap', csv: etapCsv });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.dryRun).toBe(true);
    // Pre-mapping report is surfaced...
    expect(d.toolTemplate.tool).toBe('etap');
    expect(d.toolTemplate.policyNote).toMatch(/PPE/);
    expect(d.toolTemplate.summary.rowCount).toBe(5);
    expect(d.toolTemplate.summary.unknownColumns).toBe(0);
    expect(d.toolTemplate.columns.ignoredByPolicy.map((c) => c.header)).toContain('PPE Category');
    // ...and the EXISTING validation/plan remains the source of truth.
    expect(d.validation.ok).toBe(true);
    expect(d.plan.summary.incomingBuses).toBe(5);
    expect(d.plan.summary.matchedBuses).toBe(1); // FICTION-MCC-N1 pre-exists in the fake DB
    expect(d.plan.summary.newBuses).toBe(4);
    expect(d.plan.matchedByName).toEqual([{ incoming: 'FICTION-MCC-N1', existing: 'FICTION-MCC-N1' }]);
  });

  test('unknown toolTemplate → 400 listing the real tools', async () => {
    const res = await request(app)
      .post('/api/arc-flash/afx/import-multi/preview')
      .send({ toolTemplate: 'powerworld', csv: etapCsv });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown toolTemplate/);
    expect(res.body.error).toMatch(/easypower, etap, skm/);
  });

  test('toolTemplate without csv/rows → 400 with a usable message', async () => {
    const res = await request(app)
      .post('/api/arc-flash/afx/import-multi/preview')
      .send({ toolTemplate: 'etap' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/csv.*rows|rows.*csv/i);
  });

  test('rows[] body works too (already-parsed export)', async () => {
    const res = await request(app)
      .post('/api/arc-flash/afx/import-multi/preview')
      .send({ toolTemplate: 'skm', rows: [{ 'Bus Name': 'FICTION-R1', 'Bus kV': '0.48', 'Incident Energy (cal/cm2)': '3.1', 'PPE Level / Notes (*N)': 'Level 1' }] });
    expect(res.status).toBe(200);
    expect(res.body.data.toolTemplate.tool).toBe('skm');
    expect(res.body.data.toolTemplate.columns.ignoredByPolicy.map((c) => c.header)).toContain('PPE Level / Notes (*N)');
    expect(res.body.data.plan.summary.incomingBuses).toBe(1);
  });

  test('back-compat: plain JSON tables body still previews, toolTemplate is null', async () => {
    const res = await request(app)
      .post('/api/arc-flash/afx/import-multi/preview')
      .send({ buses: [{ busId: 'FICTION-LEGACY-1', nominalVoltageV: 480 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.toolTemplate).toBeNull();
    expect(res.body.data.plan.summary.incomingBuses).toBe(1);
  });
});
