/**
 * #20 Photo-of-paper capture. The imageToPdf helper wraps a phone photo into a
 * single-page PDF so it flows through the existing OCR + parse ingest pipeline.
 */
import '../helpers/setup';

const sharp = require('sharp');
const { imageToPdf } = require('../../lib/imageToPdf');

describe('#20 imageToPdf', () => {
  test('wraps a PNG into a valid PDF', async () => {
    const png = await sharp({ create: { width: 240, height: 160, channels: 3, background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
    const pdf = await imageToPdf(png, 'image/png');
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(500);
  });

  test('wraps a JPEG into a valid PDF', async () => {
    const jpg = await sharp({ create: { width: 200, height: 300, channels: 3, background: { r: 200, g: 200, b: 200 } } }).jpeg().toBuffer();
    const pdf = await imageToPdf(jpg, 'image/jpeg');
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
  });
});

export {};
