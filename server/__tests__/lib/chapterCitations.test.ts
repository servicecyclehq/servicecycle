/** 70B chapter-citation correction (provenance). */
import '../helpers/setup';
const { correct70bRef, NFPA70B_CHAPTER, TASKS } = require('../../scripts/seed-standards');

const S = String.fromCharCode(0xA7); // section sign, ASCII-safe source

describe('correct70bRef', () => {
  test('switchgear stale section becomes Ch 12', () => {
    const out = correct70bRef(`NFPA 70B:2023 ${S}11.17 / NETA MTS-2023 Table 100.2`, 'SWITCHGEAR');
    expect(out).toContain('NFPA 70B:2023 Ch 12');
    expect(out).not.toContain(`${S}11.17`);
    expect(out).toContain('NETA MTS-2023 Table 100.2');
  });
  test('transformer maps to Ch 11', () => {
    expect(correct70bRef(`NFPA 70B:2023 ${S}22.6`, 'TRANSFORMER_LIQUID')).toContain('Ch 11');
  });
  test('equipment governed by another standard is left untouched', () => {
    const ref = `NFPA 110:2022 ${S}8.4.6`;
    expect(correct70bRef(ref, 'TRANSFER_SWITCH')).toBe(ref);
  });
  test('a NETA-only ref is unchanged', () => {
    const ref = `NETA MTS-2023 ${S}7.1 / Appendix B`;
    expect(correct70bRef(ref, 'SWITCHGEAR')).toBe(ref);
  });
});

describe('no seeded task keeps a stale per-equipment 70B section number', () => {
  test('mapped equipment types yield chapter citations, no leftover sub-section', () => {
    const re = new RegExp(`NFPA 70B:2023 ${S}[0-9]`);
    for (const t of TASKS) {
      if (!NFPA70B_CHAPTER[t.equipmentType]) continue;
      expect(re.test(correct70bRef(t.ref, t.equipmentType))).toBe(false);
    }
  });
});

export {};