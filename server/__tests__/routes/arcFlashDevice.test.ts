/**
 * Arc-flash Slice 2.7 — field-collection: collection tasks from the gap punch-list,
 * durable ProtectiveDevice CRUD + versioning, and breaker/fuse photo-read.
 * AI is mocked: the default vision return is the system fixture (so the ingest
 * upload extracts buses); the photo-read test overrides it once with a device.
 */
const SYSTEM_FIXTURE = {
  system: {
    sourceVoltage: '13.8kV',
    mainTransformer: { kva: 1500, primaryVoltage: '13.8kV', secondaryVoltage: '480V', impedancePct: 5.5 },
    serviceFaultCurrentKA: 22,
    studyMeta: { peName: 'S. Hawthorne', date: '2024-01-15', method: 'IEEE 1584-2018', software: 'EasyPower' },
  },
  buses: [
    { busName: 'SWGR-9A', equipmentType: 'switchgear', fedFromBusName: null, nominalVoltage: '13.8kV', boltedFaultCurrentKA: 22, clearingTimeMs: 200, electrodeConfig: 'VCB', conductorGapMm: 152, workingDistanceIn: 36 },
    { busName: 'MCC-9B', equipmentType: 'motor control center', fedFromBusName: 'SWGR-9A', nominalVoltage: '480V', boltedFaultCurrentKA: 30 }, // no device -> blocked
    { busName: 'PNL-9C', equipmentType: 'panelboard', fedFromBusName: 'MCC-9B', nominalVoltage: '480V' }, // no fault, no device -> blocked
  ],
};
const DEVICE_FIXTURE = {
  deviceType: 'breaker', manufacturer: 'Square D', model: 'PowerPact H', partNumber: 'HJL36150',
  frameRatingA: 150, sensorRatingA: 100, settings: { longTimePickup: 0.9, longTimeDelay: 12, instantaneous: 6 },
  confidenceNote: 'dial positions clear',
};

jest.mock('../../lib/ai', () => ({
  complete: jest.fn().mockResolvedValue({ text: JSON.stringify(SYSTEM_FIXTURE), provider: 'mock' }),
  completeWithImage: jest.fn().mockResolvedValue({ text: JSON.stringify(SYSTEM_FIXTURE), provider: 'mock' }),
  parseJSON: (t: string) => JSON.parse(t),
}));

import request from 'supertest';
import '../helpers/setup';
import { createTestUser, type TestUser } from '../helpers/auth';

let app: any;
let prisma: any;
let ai: any;
let manager: TestUser;
let other: TestUser;
let siteId: string;
let ingestId: string;
let deviceId: string;

const auth = (u: TestUser) => `Bearer ${u.token}`;
const png = Buffer.from('89504e470d0a1a0a', 'hex');

beforeAll(async () => {
  app = require('../../index').default ?? require('../../index');
  prisma = require('../../lib/prisma').default;
  ai = require('../../lib/ai');
  manager = await createTestUser('manager');
  other = await createTestUser('manager');
  const site = await prisma.site.create({ data: { accountId: manager.accountId, name: `AFD ${Date.now()}` } });
  siteId = site.id;

  const up = await request(app)
    .post('/api/arc-flash/ingest')
    .set('Authorization', auth(manager))
    .field('siteId', siteId)
    .field('sourceType', 'one_line')
    .attach('file', png, { filename: 'oneline.png', contentType: 'image/png' });
  ingestId = up.body.data.ingestId;
});

afterAll(async () => {
  for (const u of [manager, other]) {
    const acc = u.accountId;
    try { await prisma.arcFlashCollectionTask.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.protectiveDevice.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.arcFlashIngestBus.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.arcFlashIngest.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.asset.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.site.deleteMany({ where: { accountId: acc } }); } catch {}
    try { await prisma.user.delete({ where: { id: u.id } }); } catch {}
    try { await prisma.account.delete({ where: { id: acc } }); } catch {}
  }
  await prisma.$disconnect();
});

describe('arc-flash collection tasks', () => {
  test('generates a task per BLOCKED bus with safety sequencing', async () => {
    const res = await request(app).post(`/api/arc-flash/ingest/${ingestId}/collection-tasks`).set('Authorization', auth(manager)).send({});
    expect(res.status).toBe(201);
    expect(res.body.data.created).toBe(2); // MCC-9B + PNL-9C blocked; SWGR-9A is ready
    const names = res.body.data.tasks.map((t: any) => t.busName).sort();
    expect(names).toEqual(['MCC-9B', 'PNL-9C']);
    const mcc = res.body.data.tasks.find((t: any) => t.busName === 'MCC-9B');
    expect(mcc.requiresQualifiedPerson).toBe(true);
    expect(mcc.requiresOutage).toBe(true);          // device collection => door open
    expect(mcc.hazardClass).toBe('WARNING');         // 480V, no high energy
    expect(mcc.ppeNote).toBeTruthy();
    expect(mcc.instructions).toMatch(/protective device/i);
    expect(Array.isArray(mcc.neededFields)).toBe(true);
    expect(mcc.neededFields.some((f: any) => f.field === 'protectiveDevice')).toBe(true);
  });

  test('regenerate is idempotent (skips buses with a live task)', async () => {
    const res = await request(app).post(`/api/arc-flash/ingest/${ingestId}/collection-tasks`).set('Authorization', auth(manager)).send({});
    expect(res.status).toBe(201);
    expect(res.body.data.created).toBe(0);
    expect(res.body.data.skipped).toBe(2);
  });

  test('lists tasks for the site', async () => {
    const res = await request(app).get(`/api/arc-flash/collection-tasks?siteId=${siteId}&status=open`).set('Authorization', auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.data.tasks.length).toBe(2);
  });

  test('assign + status update', async () => {
    const list = await request(app).get(`/api/arc-flash/collection-tasks?siteId=${siteId}`).set('Authorization', auth(manager));
    const t = list.body.data.tasks[0];
    const res = await request(app).patch(`/api/arc-flash/collection-tasks/${t.id}`).set('Authorization', auth(manager)).send({ status: 'in_progress', assignedUserId: manager.id });
    expect(res.status).toBe(200);
    expect(res.body.data.task.status).toBe('in_progress');
    expect(res.body.data.task.assignedUserId).toBe(manager.id);
  });

  test('cross-account: other account sees no tasks', async () => {
    const res = await request(app).get(`/api/arc-flash/collection-tasks?siteId=${siteId}`).set('Authorization', auth(other));
    expect(res.status).toBe(200);
    expect(res.body.data.tasks.length).toBe(0);
  });
});

describe('protective device CRUD + versioning', () => {
  test('create a device', async () => {
    const res = await request(app).post('/api/arc-flash/devices').set('Authorization', auth(manager)).send({
      siteId, label: 'Main CB 52-M1', deviceType: 'breaker', manufacturer: 'Square D', sensorRatingA: 100, settings: { longTimePickup: 0.8 },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.device.status).toBe('active');
    expect(res.body.data.device.sensorRatingA).toBe(100);
    expect(res.body.data.device.settingsCollectedAt).toBeTruthy();
    deviceId = res.body.data.device.id;
  });

  test('rejects a bad device type', async () => {
    const res = await request(app).post('/api/arc-flash/devices').set('Authorization', auth(manager)).send({ siteId, label: 'X', deviceType: 'frobnicator' });
    expect(res.status).toBe(400);
  });

  test('lists active devices for the site', async () => {
    const res = await request(app).get(`/api/arc-flash/devices?siteId=${siteId}`).set('Authorization', auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.data.devices.some((d: any) => d.id === deviceId)).toBe(true);
  });

  test('supersede creates a new version and retires the old', async () => {
    const res = await request(app).post(`/api/arc-flash/devices/${deviceId}/supersede`).set('Authorization', auth(manager)).send({ settings: { longTimePickup: 1.0, instantaneous: 8 } });
    expect(res.status).toBe(201);
    const newId = res.body.data.device.id;
    expect(newId).not.toBe(deviceId);
    expect(res.body.data.supersededId).toBe(deviceId);
    // active list now shows only the new one
    const active = await request(app).get(`/api/arc-flash/devices?siteId=${siteId}&status=active`).set('Authorization', auth(manager));
    expect(active.body.data.devices.some((d: any) => d.id === newId)).toBe(true);
    expect(active.body.data.devices.some((d: any) => d.id === deviceId)).toBe(false);
  });

  test('cross-account: other account cannot create on this site', async () => {
    const res = await request(app).post('/api/arc-flash/devices').set('Authorization', auth(other)).send({ siteId, label: 'sneaky', deviceType: 'breaker' });
    expect(res.status).toBe(404);
  });
});

describe('device photo-read', () => {
  test('reads a device draft from a photo (vision)', async () => {
    process.env.AI_ENABLED = 'true';
    ai.completeWithImage.mockResolvedValueOnce({ text: JSON.stringify(DEVICE_FIXTURE), provider: 'mock' });
    const res = await request(app)
      .post('/api/arc-flash/photo-read')
      .set('Authorization', auth(manager))
      .attach('photo', png, { filename: 'breaker.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.data.device.deviceType).toBe('breaker');
    expect(res.body.data.device.manufacturer).toBe('Square D');
    expect(res.body.data.device.sensorRatingA).toBe(100);
    expect(res.body.data.device.settings.longTimePickup).toBe(0.9);
  });
});

describe('field collection (scoped) closes the loop', () => {
  test('collecting a device on a blocked bus moves it toward ready', async () => {
    const list = await request(app).get(`/api/arc-flash/collection-tasks?siteId=${siteId}`).set('Authorization', auth(manager));
    const mccTask = list.body.data.tasks.find((t: any) => t.busName === 'MCC-9B');
    expect(mccTask).toBeTruthy();
    const res = await request(app)
      .post(`/api/field/arc-flash/tasks/${mccTask.id}/collect`)
      .set('Authorization', auth(manager))
      .send({ device: { deviceType: 'breaker', manufacturer: 'Eaton', sensorRatingA: 400, settings: { longTimePickup: 0.9, instantaneous: 5 } } });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('collected');
    expect(res.body.data.deviceId).toBeTruthy();
    expect(res.body.data.readiness).toBe('defaultable'); // device closed the must-obtain; typicals IEEE-defaulted
  });

  test('task is now collected and a durable field device exists', async () => {
    const tasks = await request(app).get('/api/field/arc-flash/tasks?status=collected').set('Authorization', auth(manager));
    expect(tasks.body.data.tasks.some((t: any) => t.busName === 'MCC-9B')).toBe(true);
    const devs = await request(app).get(`/api/arc-flash/devices?siteId=${siteId}`).set('Authorization', auth(manager));
    expect(devs.body.data.devices.some((d: any) => d.source === 'field' && d.sensorRatingA === 400)).toBe(true);
  });
});

describe('gap engine: fixed-trip devices need no recorded settings (Brady finding)', () => {
  const { analyzeBusGaps } = require('../../lib/arcFlashGap');
  const base = { busName: 'B', equipmentTypeGuess: 'PANELBOARD', nominalVoltage: '480V', boltedFaultCurrentKA: 10 };
  const devBlocked = (g: any) => (g.missingRequired || []).includes('protectiveDevice');
  test('fuse + rating (no settings) satisfies the protective-device must-obtain', () => {
    expect(devBlocked(analyzeBusGaps({ ...base, deviceType: 'fuse', deviceRatingA: 200 }))).toBe(false);
  });
  test('thermal-mag breaker + rating (no settings) satisfies via the published TCC', () => {
    expect(devBlocked(analyzeBusGaps({ ...base, deviceType: 'breaker', deviceRatingA: 225 }))).toBe(false);
  });
  test('relay still requires settings', () => {
    expect(devBlocked(analyzeBusGaps({ ...base, deviceType: 'relay', deviceRatingA: 600 }))).toBe(true);
    expect(devBlocked(analyzeBusGaps({ ...base, deviceType: 'relay', deviceRatingA: 600, deviceSettings: { pickup: 0.8 } }))).toBe(false);
  });
  test('a device type with no rating stays blocked', () => {
    expect(devBlocked(analyzeBusGaps({ ...base, deviceType: 'breaker' }))).toBe(true);
  });
  test('no device at all stays blocked', () => {
    expect(devBlocked(analyzeBusGaps({ ...base }))).toBe(true);
  });
  test('electronic LSIG breaker (type+rating, NO settings) now correctly NEEDS settings -> blocked', () => {
    expect(devBlocked(analyzeBusGaps({ ...base, deviceType: 'breaker', deviceRatingA: 800, tripUnitType: 'electronic_lsig' }))).toBe(true);
  });
  test('electronic LSIG breaker WITH settings -> satisfied', () => {
    expect(devBlocked(analyzeBusGaps({ ...base, deviceType: 'breaker', deviceRatingA: 800, tripUnitType: 'electronic_lsig', deviceSettings: { ltPickupA: 640 } }))).toBe(false);
  });
  test('thermal-magnetic breaker (explicit trip-unit, no settings) -> satisfied via TCC', () => {
    expect(devBlocked(analyzeBusGaps({ ...base, deviceType: 'breaker', deviceRatingA: 225, tripUnitType: 'thermal_magnetic' }))).toBe(false);
  });
});

describe('arc-flash dashboard aggregate', () => {
  test('returns account-scoped counts', async () => {
    const res = await request(app).get('/api/arc-flash/dashboard').set('Authorization', auth(manager));
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.blockedBuses).toBeGreaterThanOrEqual(1);     // PNL-9C still blocked
    expect(d.openCollectionTasks).toBeGreaterThanOrEqual(1); // PNL-9C task open/in_progress
    expect(Array.isArray(d.topDanger)).toBe(true);
  });

  test('cross-account sees zeros', async () => {
    const res = await request(app).get('/api/arc-flash/dashboard').set('Authorization', auth(other));
    expect(res.status).toBe(200);
    expect(res.body.data.blockedBuses).toBe(0);
    expect(res.body.data.openCollectionTasks).toBe(0);
    expect(res.body.data.dangerBuses).toBe(0);
  });
});

describe('confirm persists the collected device/cable onto the durable study record', () => {
  test('confirm + createStudy carries the field-collected breaker to SystemStudyAsset', async () => {
    const res = await request(app)
      .post(`/api/arc-flash/ingest/${ingestId}/confirm`)
      .set('Authorization', auth(manager))
      .send({ createStudy: true, studyType: 'arc_flash' });
    expect(res.status).toBe(200);
    expect(res.body.data.studyId).toBeTruthy();
    expect(res.body.data.boundCount).toBeGreaterThanOrEqual(1);
    // MCC-9B had a breaker collected in the field earlier; it must survive onto the study binding.
    const ssa = await prisma.systemStudyAsset.findFirst({ where: { studyId: res.body.data.studyId, busName: 'MCC-9B' } });
    expect(ssa).toBeTruthy();
    expect(ssa.deviceType).toBe('breaker');
    expect(Number(ssa.deviceRatingA)).toBe(400);
    expect(ssa.labelSeverity).toBe('warning'); // 480 V, no high incident energy
    const swgr = await prisma.systemStudyAsset.findFirst({ where: { studyId: res.body.data.studyId, busName: 'SWGR-9A' } });
    expect(swgr.labelSeverity).toBe('danger'); // 13.8 kV > 600 V
  });
});
