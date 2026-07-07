/**
 * Regression test — 2026-07-06/07 overnight cron bug hunt (Tier 2,
 * continuation of [[servicecycle-bughunt-restore-branch-2026-07-06]]).
 *
 * `weatherScanner` (every 15 min, index.ts) had zero test coverage. Mocks
 * ONLY the outbound network layer (global fetch, NWS active-alerts API) —
 * the severity/urgency filter, UGC->state geocode extraction, real
 * Site/Account state-matching query, DisasterEvent create, and the
 * idempotent re-run (existing nwsAlertId skip) all run against a real
 * Postgres DB.
 */
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let prisma: any;
let admin: TestUser;
let siteId: string;
let originalFetch: any;

function nwsFeature(overrides: any = {}) {
  return {
    id: `https://api.weather.gov/alerts/test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    properties: {
      event: 'Tornado Warning',
      severity: 'Extreme',
      urgency: 'Immediate',
      headline: 'Tornado Warning issued for test region',
      areaDesc: 'Test County, WY',
      geocode: { UGC: ['WYC001'] },
      ...overrides,
    },
  };
}

beforeAll(async () => {
  prisma = require('../../lib/prisma').default;
  admin = await createTestUser('admin');
  const site = await prisma.site.create({ data: { accountId: admin.accountId, name: `WS Site ${Date.now()}`, state: 'WY' } });
  siteId = site.id;
  originalFetch = global.fetch;
});

afterEach(async () => {
  await prisma.disasterEvent.deleteMany({ where: { affectedSiteIds: { has: siteId } } });
});

afterAll(async () => {
  global.fetch = originalFetch;
  try { await prisma.site.delete({ where: { id: siteId } }); } catch {}
  try { await prisma.user.delete({ where: { id: admin.id } }); } catch {}
  try { await prisma.account.delete({ where: { id: admin.accountId } }); } catch {}
  await prisma.$disconnect();
});

test('runWeatherScanner(): a qualifying NWS alert real-matches a site by state and creates a DisasterEvent, idempotent on re-run', async () => {
  const feature = nwsFeature();
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ features: [feature] }),
  });

  const { runWeatherScanner } = require('../../lib/weatherScanner');

  const result1 = await runWeatherScanner();
  expect(result1.errors).toBe(0);
  expect(result1.checked).toBeGreaterThanOrEqual(1);
  expect(result1.created).toBeGreaterThanOrEqual(1);

  const event = await prisma.disasterEvent.findFirst({ where: { nwsAlertId: feature.id } });
  expect(event).toBeTruthy();
  expect(event.eventType).toBe('tornado');
  expect(event.severity).toBe('emergency'); // NWS severity 'Extreme' -> internal 'emergency'
  expect(event.affectedStates).toContain('WY');
  expect(event.affectedSiteIds).toContain(siteId);

  // Second run, same active alert -- must be idempotent (existing nwsAlertId
  // is skipped, not re-created).
  const result2 = await runWeatherScanner();
  expect(result2.created).toBe(0);
  const count = await prisma.disasterEvent.count({ where: { nwsAlertId: feature.id } });
  expect(count).toBe(1);
});

test('runWeatherScanner(): a Moderate-severity alert (below the Extreme/Severe threshold) is filtered out, no DisasterEvent created', async () => {
  const feature = nwsFeature({ severity: 'Moderate' });
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ features: [feature] }),
  });

  const { runWeatherScanner } = require('../../lib/weatherScanner');
  const result = await runWeatherScanner();

  expect(result.errors).toBe(0);
  expect(result.checked).toBe(0);
  expect(result.created).toBe(0);
  const event = await prisma.disasterEvent.findFirst({ where: { nwsAlertId: feature.id } });
  expect(event).toBeNull();
});

export {};
