/**
 * #26 NFPA 110 genset + IEEE 450/1188 battery modules. Verifies the new
 * standards-grounded task definitions are present with mandate-fixed intervals
 * and that seed-standards remains idempotent (global rows upsert, never
 * duplicate). Pure-array assertions + one DB round-trip through seedStandards.
 */
import '../helpers/setup';
const { seedStandards, TASKS } = require('../../scripts/seed-standards');

let prisma: any;

beforeAll(() => {
  prisma = require('../../lib/prisma').default;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const byCode = (code: string) => TASKS.find((t: any) => t.code === code);

describe('#26 genset + battery modules — task catalog', () => {
  test('NFPA 110 genset gains starting-battery + engine-service tasks', () => {
    const batt = byCode('GEN_BATTERY_INSPECT');
    expect(batt).toBeDefined();
    expect(batt.equipmentType).toBe('GENERATOR');
    expect(batt.standardKey).toBe('NFPA 110');
    expect([batt.c1, batt.c2, batt.c3]).toEqual([1, 1, 1]); // mandate-fixed monthly

    const eng = byCode('GEN_ENGINE_SERVICE');
    expect(eng).toBeDefined();
    expect(eng.equipmentType).toBe('GENERATOR');
    expect(eng.standardKey).toBe('NFPA 110');
  });

  test('IEEE 450 / 1188 monthly string tier exists distinct from quarterly per-cell', () => {
    const battMonthly = byCode('BATT_MONTHLY_STRING');
    expect(battMonthly).toBeDefined();
    expect(battMonthly.equipmentType).toBe('BATTERY_SYSTEM');
    expect(battMonthly.standardKey).toBe('IEEE 450');
    expect([battMonthly.c1, battMonthly.c2, battMonthly.c3]).toEqual([1, 1, 1]);
    // the existing quarterly per-cell task is still its own separate row
    expect(byCode('BATT_OHMIC_FLOAT')).toBeDefined();

    const upsMonthly = byCode('UPS_BATT_MONTHLY_STRING');
    expect(upsMonthly).toBeDefined();
    expect(upsMonthly.equipmentType).toBe('UPS_BATTERY');
    expect(upsMonthly.standardKey).toBe('IEEE 1188');
    expect([upsMonthly.c1, upsMonthly.c2, upsMonthly.c3]).toEqual([1, 1, 1]);
  });
});

describe('#26 seed idempotency + interval persistence', () => {
  test('seedStandards persists new rows with mandate-fixed intervals (not 70B-overridden)', async () => {
    await seedStandards(prisma);

    const rows = await prisma.maintenanceTaskDefinition.findMany({
      where: { accountId: null, taskCode: { in: ['GEN_BATTERY_INSPECT', 'BATT_MONTHLY_STRING', 'UPS_BATT_MONTHLY_STRING', 'GEN_ENGINE_SERVICE'] } },
      select: { taskCode: true, equipmentType: true, intervalC1Months: true, intervalC2Months: true, intervalC3Months: true },
    });
    const map: any = Object.fromEntries(rows.map((r: any) => [r.taskCode, r]));
    expect(rows.length).toBe(4);
    // monthly tasks must keep 1/1/1 (seventyBInterval returns null for them)
    expect(map['GEN_BATTERY_INSPECT'].intervalC2Months).toBe(1);
    expect(map['BATT_MONTHLY_STRING'].intervalC2Months).toBe(1);
    expect(map['UPS_BATT_MONTHLY_STRING'].intervalC2Months).toBe(1);
    expect(map['GEN_ENGINE_SERVICE'].intervalC2Months).toBe(12);
  });

  test('re-running seedStandards creates zero new global rows (idempotent)', async () => {
    const r = await seedStandards(prisma);
    expect(r.tasksCreated).toBe(0);
    expect(r.tasksUpdated).toBe(TASKS.length);
  });

  test('every EquipmentType enum value still carries at least one global template', async () => {
    const grouped = await prisma.maintenanceTaskDefinition.groupBy({
      by: ['equipmentType'],
      where: { accountId: null },
      _count: true,
    });
    // GENERATOR, BATTERY_SYSTEM, UPS_BATTERY all carry multiple tasks now
    const counts: any = Object.fromEntries(grouped.map((g: any) => [g.equipmentType, g._count]));
    expect(counts['GENERATOR']).toBeGreaterThanOrEqual(7);
    expect(counts['BATTERY_SYSTEM']).toBeGreaterThanOrEqual(4);
    expect(counts['UPS_BATTERY']).toBeGreaterThanOrEqual(5);
  });
});

export {};
