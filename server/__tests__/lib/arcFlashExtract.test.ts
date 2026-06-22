/**
 * Unit tests for the arc-flash extraction pipeline (Slice 2).
 * AI + PDF text extraction are mocked, so this is fast and offline.
 */
jest.mock('../../lib/ai', () => ({
  complete: jest.fn(),
  completeWithImage: jest.fn(),
  parseJSON: (t: string) => JSON.parse(t),
}));
jest.mock('../../lib/testReportParse', () => ({
  extractPdfText: jest.fn(),
}));
jest.mock('../../lib/rasterizePdf', () => ({
  rasterizePdf: jest.fn(),
}));
jest.mock('../../lib/pdfText', () => ({
  extractPdfPlumber: jest.fn(),
}));

import { extractArcFlashDocument, normalizeExtraction, mapEquipmentType } from '../../lib/arcFlashExtract';
const ai = require('../../lib/ai');
const { extractPdfText } = require('../../lib/testReportParse');
const { rasterizePdf } = require('../../lib/rasterizePdf');
const { extractPdfPlumber } = require('../../lib/pdfText');

const buf = Buffer.from('dummy');

const FIXTURE = {
  system: {
    sourceVoltage: '13.8kV',
    mainTransformer: { kva: 1500, primaryVoltage: '13.8kV', secondaryVoltage: '480V', impedancePct: 5.5 },
    serviceFaultCurrentKA: 22,
    studyMeta: { peName: 'S. Hawthorne', date: '2024-01-15', method: 'IEEE 1584-2018', software: 'SKM' },
  },
  buses: [
    { busName: 'SWGR-1A', equipmentType: 'Switchgear', fedFromBusName: null, nominalVoltage: '13.8kV',
      boltedFaultCurrentKA: 22, electrodeConfig: 'vcb', conductorGapMm: 152, workingDistanceIn: 36,
      clearingTimeMs: 200, upstreamDevice: 'Utility 51 relay', incidentEnergyCalCm2: 14.2, arcFlashBoundaryIn: 68, ppeCategory: 4 },
    { busName: 'MCC-2', equipmentType: 'motor control center', fedFromBusName: 'SWGR-1A', nominalVoltage: '480V', boltedFaultCurrentKA: 'N/A' },
  ],
};

beforeEach(() => { jest.clearAllMocks(); extractPdfPlumber.mockResolvedValue({ ok: false }); });

describe('mapEquipmentType', () => {
  test('maps common one-line labels to the enum', () => {
    expect(mapEquipmentType('Motor Control Center')).toBe('MCC');
    expect(mapEquipmentType('SWGR-1A switchgear')).toBe('SWITCHGEAR');
    expect(mapEquipmentType('Main Switchboard')).toBe('SWITCHBOARD');
    expect(mapEquipmentType('XFMR T-1')).toBe('TRANSFORMER_LIQUID');
    expect(mapEquipmentType('dry-type transformer')).toBe('TRANSFORMER_DRY');
    expect(mapEquipmentType('PANELBOARD')).toBe('PANELBOARD'); // verbatim enum
    expect(mapEquipmentType('automatic transfer switch')).toBe('TRANSFER_SWITCH');
  });
  test('returns null for unmappable junk', () => {
    expect(mapEquipmentType('refrigerator')).toBeNull();
    expect(mapEquipmentType('')).toBeNull();
    expect(mapEquipmentType(null)).toBeNull();
  });
});

describe('normalizeExtraction — defensive parsing', () => {
  test('coerces numbers, maps types, nulls N/A, drops nameless + dup buses', () => {
    const { systemMeta, buses, warnings } = normalizeExtraction({
      system: { sourceVoltage: '480V', mainTransformer: { kva: '1500' }, serviceFaultCurrentKA: '22', studyMeta: {} },
      buses: [
        { busName: 'A', equipmentType: 'switchgear', boltedFaultCurrentKA: '12.5' },
        { busName: '', equipmentType: 'panel' },              // dropped (no name)
        { busName: 'A', equipmentType: 'mcc' },               // duplicate collapsed
        { busName: 'B', equipmentType: 'mystery', clearingTimeMs: 'N/A' },
      ],
    });
    expect(systemMeta.mainTransformer.kva).toBe(1500);
    expect(systemMeta.serviceFaultCurrentKA).toBe(22);
    expect(buses).toHaveLength(2);
    expect(buses[0].boltedFaultCurrentKA).toBe(12.5);
    expect(buses[1].equipmentTypeGuess).toBeNull(); // "mystery" unmapped
    expect(buses[1].clearingTimeMs).toBeNull();      // "N/A" -> null
    expect(warnings.join(' ')).toMatch(/no name|Duplicate|Unmapped/);
  });
});

describe('extractArcFlashDocument — routing + extraction', () => {
  test('text path: PDF with a text layer -> ai.complete -> normalized model', async () => {
    extractPdfText.mockResolvedValue('A'.repeat(400)); // meaningful text layer
    ai.complete.mockResolvedValue({ text: JSON.stringify(FIXTURE), provider: 'groq' });

    const r = await extractArcFlashDocument({ buffer: buf, mimeType: 'application/pdf', fileName: 'study.pdf' });
    expect(r.method).toBe('text');
    expect(r.aiProvider).toBe('groq');
    expect(ai.complete).toHaveBeenCalledTimes(1);
    expect(ai.completeWithImage).not.toHaveBeenCalled();
    expect(r.buses).toHaveLength(2);
    expect(r.buses[0].equipmentTypeGuess).toBe('SWITCHGEAR');
    expect(r.buses[0].electrodeConfig).toBe('VCB'); // 'vcb' normalized upper
    expect(r.buses[1].equipmentTypeGuess).toBe('MCC');
    expect(r.buses[1].boltedFaultCurrentKA).toBeNull(); // 'N/A'
    expect(r.systemMeta.mainTransformer.kva).toBe(1500);
  });

  test('text path prefers deterministic pdfplumber (tables); does NOT fall back to pdfjs', async () => {
    extractPdfPlumber.mockResolvedValue({ ok: true, text: 'A'.repeat(400), tables: [[['Bus', 'kA'], ['SWGR-1A', '22']]] });
    ai.complete.mockResolvedValue({ text: JSON.stringify(FIXTURE), provider: 'groq' });
    const r = await extractArcFlashDocument({ buffer: buf, mimeType: 'application/pdf', fileName: 'study.pdf' });
    expect(r.method).toBe('text');
    expect(extractPdfPlumber).toHaveBeenCalledTimes(1);
    expect(extractPdfText).not.toHaveBeenCalled(); // pdfjs not needed when pdfplumber has the text
    expect(r.buses).toHaveLength(2);
  });

  test('vision path: image upload -> ai.completeWithImage', async () => {
    ai.completeWithImage.mockResolvedValue({ text: JSON.stringify({ system: {}, buses: [{ busName: 'P1', equipmentType: 'panelboard' }] }) });
    const r = await extractArcFlashDocument({ buffer: buf, mimeType: 'image/png', fileName: 'oneline.png' });
    expect(r.method).toBe('vision');
    expect(ai.completeWithImage).toHaveBeenCalledTimes(1);
    expect(ai.complete).not.toHaveBeenCalled();
    expect(r.buses[0].equipmentTypeGuess).toBe('PANELBOARD');
  });

  test('scanned PDF auto-rasterizes to images -> vision_pdf, buses merged across pages', async () => {
    extractPdfText.mockResolvedValue(''); // no text layer
    rasterizePdf.mockResolvedValue([Buffer.from('p1'), Buffer.from('p2')]); // two rendered pages
    ai.completeWithImage
      .mockResolvedValueOnce({ text: JSON.stringify({ system: { sourceVoltage: '13.8kV' }, buses: [{ busName: 'SWGR-1A', equipmentType: 'switchgear' }] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ system: {}, buses: [{ busName: 'MCC-2', equipmentType: 'mcc', nominalVoltage: '480V' }] }) });
    const r = await extractArcFlashDocument({ buffer: buf, mimeType: 'application/pdf', fileName: 'scan.pdf' });
    expect(r.method).toBe('vision_pdf');
    expect(rasterizePdf).toHaveBeenCalledTimes(1);
    expect(ai.completeWithImage).toHaveBeenCalledTimes(2); // one vision call per page
    expect(ai.complete).not.toHaveBeenCalled();
    expect(r.buses.map((b: any) => b.busName).sort()).toEqual(['MCC-2', 'SWGR-1A']);
    expect(r.systemMeta.sourceVoltage).toBe('13.8kV');
    expect(r.warnings.join(' ')).toMatch(/Auto-converted 2/);
  });

  test('scanned PDF that cannot be rasterized -> needs_image fallback', async () => {
    extractPdfText.mockResolvedValue('   ');
    rasterizePdf.mockResolvedValue([]); // rasterization failed (best-effort)
    const r = await extractArcFlashDocument({ buffer: buf, mimeType: 'application/pdf', fileName: 'scan.pdf' });
    expect(r.method).toBe('needs_image');
    expect(r.buses).toHaveLength(0);
    expect(r.warnings.join(' ')).toMatch(/could not be auto-converted|upload a png/i);
  });

  test('unsupported file type -> unsupported, clear warning', async () => {
    const r = await extractArcFlashDocument({ buffer: buf, mimeType: 'application/zip', fileName: 'x.zip' });
    expect(r.method).toBe('unsupported');
    expect(r.warnings.join(' ')).toMatch(/Unsupported file type/i);
  });

  test('malformed AI JSON -> soft fail with warning, no throw', async () => {
    extractPdfText.mockResolvedValue('A'.repeat(400));
    ai.complete.mockResolvedValue({ text: 'not json {{{', provider: 'groq' });
    const r = await extractArcFlashDocument({ buffer: buf, mimeType: 'application/pdf', fileName: 'study.pdf' });
    expect(r.buses).toHaveLength(0);
    expect(r.warnings.join(' ')).toMatch(/Could not parse/i);
  });
});
