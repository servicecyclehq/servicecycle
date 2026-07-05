'use strict';

/**
 * lib/drawingConverter — EDMS Phase 1 scaffold (2026-07-05, feat/edms-phase-1
 * branch). No DB, no network -- pure adapter-interface tests.
 */

const { PdfConverter, DwgConverter, getDrawingConverter } = require('../lib/drawingConverter');

describe('PdfConverter', () => {
  test('passes the buffer through unchanged', async () => {
    const buf = Buffer.from('fake pdf bytes');
    const out = await new PdfConverter().convert(buf, {});
    expect(out.pdfBuffer).toBe(buf);
    expect(out.sourceFormat).toBe('pdf');
  });

  test('rejects an empty buffer', async () => {
    await expect(new PdfConverter().convert(Buffer.alloc(0), {})).rejects.toThrow(/empty or invalid/);
  });
});

describe('DwgConverter', () => {
  const ORIGINAL_ENV = process.env.EDMS_DWG_CONVERSION_ENABLED;
  afterEach(() => { process.env.EDMS_DWG_CONVERSION_ENABLED = ORIGINAL_ENV; });

  test('flag unset/false -> throws the locked "PDF-first" upload copy', async () => {
    delete process.env.EDMS_DWG_CONVERSION_ENABLED;
    await expect(new DwgConverter().convert(Buffer.from('x'), { filename: 'panel.dwg' }))
      .rejects.toThrow(/not yet available.*panel\.dwg/s);
  });

  test('flag true -> throws the distinct "scaffolded but not implemented" message', async () => {
    process.env.EDMS_DWG_CONVERSION_ENABLED = 'true';
    await expect(new DwgConverter().convert(Buffer.from('x'), {}))
      .rejects.toThrow(/scaffolded but not yet implemented/);
  });
});

describe('getDrawingConverter', () => {
  test.each(['dwg', 'DWG', '.dwg', 'dxf'])('routes %s to DwgConverter', (fmt) => {
    expect(getDrawingConverter(fmt)).toBeInstanceOf(DwgConverter);
  });

  test.each(['pdf', 'PDF', 'image', 'png', '', undefined])('routes %s to PdfConverter (default)', (fmt) => {
    expect(getDrawingConverter(fmt)).toBeInstanceOf(PdfConverter);
  });
});
