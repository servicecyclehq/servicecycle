'use strict';

/**
 * Regression-lock for the 2026-07-04 nameplate fix (commit 919d389) — proves
 * that the `POST /api/assets/ocr-nameplate` handler keeps its two safety
 * invariants under fixture-controlled model responses. Both were LATENT before
 * this test file: green units + a live-traffic cap of 5 scans/day meant any
 * future maxTokens trim or dropped responseMimeType could silently re-break
 * the read rate again without any test catching it.
 *
 *   INVARIANT A — the vision call always ships with JSON mode ON and an
 *   adequate maxTokens (>= 8192). Gemini 2.5-flash is a THINKING model whose
 *   reasoning tokens bill against maxOutputTokens; the 2026-07-04 failure was
 *   maxTokens=1536 truncating the JSON mid-object → parseJSON 500 → quota
 *   refund → read rate collapsed to 1/7 plates. This test asserts the call
 *   signature so a regression on either half fails loudly at CI time.
 *
 *   INVARIANT B — the handler stays graceful on a truncated / malformed model
 *   response. That was today's failure shape; ensure it still refunds the
 *   quota and returns 500 with the tech-facing "try a clearer photo" message.
 *
 *   ADDITIONALLY — a valid multi-field response with kva=60 AND frequency
 *   "60 Hz" (the observed adjacent-value grab class) should return 200 and
 *   emit a `reasons.kva` finding + downgraded confidence, proving the domain
 *   validators shipped in 294613d are wired into the route.
 *
 * The real routes/assetPhotoInspect module is exercised via supertest with a
 * multipart upload. Only these dependencies are mocked:
 *   - lib/imageNormalize   — bypass sharp (no need to shell in a real image)
 *   - lib/ai               — completeWithImage returns fixture text; parseJSON
 *                            is a thin wrapper the route can use as-is
 *   - AI-gate plumbing     — same pattern as photoInspectRoleGate.test.js
 *   - prisma               — deliberately never touched (route never persists)
 */

// AI kill-switch must be OFF for the route to actually reach completeWithImage.
delete process.env.AI_ENABLED;

// Mock every module the route requires that would otherwise pull a real dep
// tree (prisma, sharp, ai keys). Order matters — must be declared before the
// route is required. See photoInspectRoleGate.test.js for the sibling pattern.
jest.mock('../lib/prisma', () => ({ default: {} }));
jest.mock('../lib/aiConsent', () => ({ ensureAiConsent: jest.fn(async () => true) }));
jest.mock('../lib/aiBudgetGuard', () => ({ ensureAiBudget: jest.fn(() => true) }));

const refundIncrementMock = jest.fn();
const checkAndIncrementMock = jest.fn(async () => ({ ok: true, count: 1, cap: 5, resetAt: null }));
jest.mock('../lib/aiQuota', () => ({
  checkAndIncrement: checkAndIncrementMock,
  refundIncrement: refundIncrementMock,
}));

jest.mock('../middleware/aiIpLimit', () => ({ aiIpLimiter: (req, res, next) => next() }));
jest.mock('../lib/storage', () => ({ uploadFile: jest.fn() }));
jest.mock('../lib/extractionTelemetry', () => ({ recordExtraction: jest.fn() }));
jest.mock('../lib/activityLog', () => ({ writeLog: jest.fn() }));
jest.mock('../lib/imageNormalize', () => ({
  // Pass the buffer through unchanged. The route's next step is
  // completeWithImage (mocked), which never actually looks at the bytes.
  normalizeImage: jest.fn(async (buffer, mimeType) => ({
    buffer, mimeType: mimeType || 'image/jpeg',
  })),
}));

// `completeWithImage` is the invariant-A subject: this mock captures every
// call so a test can assert both what came back AND how it was invoked.
const completeWithImageMock = jest.fn();
jest.mock('../lib/ai', () => {
  // A real parseJSON so the route's parse behavior is under test (that's the
  // codepath that trips on truncation). Copied verbatim from lib/ai.ts:415.
  const parseJSON = (text, providerName) => {
    const cleaned = String(text || '').trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    try { return JSON.parse(cleaned); }
    catch (e) {
      throw new Error(`[ai] ${providerName} returned invalid JSON: ${e.message}\nRaw: ${String(text).slice(0, 500)}`);
    }
  };
  return { completeWithImage: completeWithImageMock, parseJSON, complete: jest.fn() };
});

const express = require('express');
const request = require('supertest');

let app;
let currentUser;
beforeAll(() => {
  const router = require('../routes/assetPhotoInspect');
  app = express();
  // Minimal user injection — the ocr-nameplate route is intentionally NOT
  // role-gated (per photoInspectRoleGate.test.js), so viewer is fine.
  app.use((req, res, next) => { req.user = currentUser; next(); });
  app.use('/api/assets', router);
});

beforeEach(() => {
  currentUser = { id: 'user-1', accountId: 'acct-a', role: 'viewer' };
  completeWithImageMock.mockReset();
  refundIncrementMock.mockReset();
  checkAndIncrementMock.mockClear();
});

// A tiny placeholder body — imageNormalize is mocked, so bytes are not parsed.
const dummyImage = Buffer.from('not-a-real-image-but-that-is-fine');

// ── A. Valid multi-field response ────────────────────────────────────────────
describe('POST /api/assets/ocr-nameplate — INVARIANT A (JSON-mode + big token budget)', () => {
  test('valid multi-field JSON → 200 with correct fields and no route error', async () => {
    // Representative gemini 2.5-flash output (fresh, no code fences, all cells
    // as the V7 { value, confidence, sourceText } shape).
    const validResponse = JSON.stringify({
      manufacturer:    { value: 'ACME',        confidence: 'high',   sourceText: 'ACME ELECTRIC' },
      model:           { value: 'XFR-500',     confidence: 'high',   sourceText: 'MODEL XFR-500' },
      serialNumber:    { value: 'SN12345678',  confidence: 'high',   sourceText: 'S/N: SN12345678' },
      voltage:         { value: '480V',        confidence: 'high',   sourceText: '480V' },
      kva:             { value: 75,            confidence: 'high',   sourceText: '75 kVA' },
      amperage:        { value: 90,            confidence: 'medium', sourceText: '90 A' },
      phases:          { value: 3,             confidence: 'high',   sourceText: '3 PHASE' },
      frequency:       { value: '60 Hz',       confidence: 'high',   sourceText: '60 Hz' },
      year:            { value: 2018,          confidence: 'medium', sourceText: '2018' },
      enclosureRating: { value: 'NEMA 3R',     confidence: 'high',   sourceText: 'NEMA 3R' },
    });
    completeWithImageMock.mockResolvedValueOnce({ text: validResponse, model: 'gemini-2.5-flash' });

    const res = await request(app)
      .post('/api/assets/ocr-nameplate')
      .attach('image', dummyImage, { filename: 'plate.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.fields.kva).toBe(75);
    expect(res.body.data.fields.voltage).toBe('480V');
    expect(res.body.data.confidence.kva).toBe('high');
    expect(refundIncrementMock).not.toHaveBeenCalled();
  });

  test('vision call ships with maxTokens >= 8192 AND JSON mode ON', async () => {
    completeWithImageMock.mockResolvedValueOnce({ text: '{}', model: 'gemini-2.5-flash' });

    await request(app)
      .post('/api/assets/ocr-nameplate')
      .attach('image', dummyImage, { filename: 'plate.jpg', contentType: 'image/jpeg' });

    expect(completeWithImageMock).toHaveBeenCalledTimes(1);
    const args = completeWithImageMock.mock.calls[0][0];
    // Reasoning tokens (Gemini 2.5 flash) bill against maxOutputTokens; a
    // future trim below 8192 is the exact regression that broke read rate
    // on 2026-07-04. Lower bound stated explicitly so a change fails loudly.
    expect(args.maxTokens).toBeGreaterThanOrEqual(8192);
    // JSON mode makes Gemini emit a single valid, fence-free JSON object; a
    // dropped responseMimeType would re-open the fence/prose-wrapper class.
    expect(args.responseMimeType).toBe('application/json');
  });
});

// ── B. Truncated / malformed response reproduces today's failure ─────────────
describe('POST /api/assets/ocr-nameplate — INVARIANT B (graceful truncation)', () => {
  test('mid-object truncation → 500 + quota refund', async () => {
    // Reproduces the 2026-07-04 shape: gemini started emitting the JSON, then
    // ran out of maxOutputTokens mid-string. No closing brace, so the brace-
    // fallback regex (assetPhotoInspect.ts:478) also finds nothing.
    const truncated = '{"manufacturer":{"value":"ACME","confidence":"high"},"model":{"value":"XF';
    completeWithImageMock.mockResolvedValueOnce({ text: truncated, model: 'gemini-2.5-flash' });

    const res = await request(app)
      .post('/api/assets/ocr-nameplate')
      .attach('image', dummyImage, { filename: 'plate.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    // Message is tech-facing; assert the shape, not the exact text (the copy
    // may be tuned later without invalidating the contract).
    expect(String(res.body.error || '')).toMatch(/nameplate/i);
    // The scan meter fired before completeWithImage; a failure must NOT burn
    // the user's daily quota. This is the observed 5/day cap becoming 4/day
    // after every truncated read that inspired the 919d389 fix.
    expect(refundIncrementMock).toHaveBeenCalledTimes(1);
    expect(refundIncrementMock).toHaveBeenCalledWith('user-1', 'nameplate_scan', 'acct-a');
  });

  test('completely empty response → 500 + quota refund (no crash)', async () => {
    completeWithImageMock.mockResolvedValueOnce({ text: '', model: 'gemini-2.5-flash' });

    const res = await request(app)
      .post('/api/assets/ocr-nameplate')
      .attach('image', dummyImage, { filename: 'plate.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(500);
    expect(refundIncrementMock).toHaveBeenCalledTimes(1);
  });

  test('prose-wrapped JSON → parseJSON fallback recovers the object (not a crash)', async () => {
    // The route has an intentional brace-fallback for models that fence or
    // wrap. This case must NOT trigger the 500 branch — it's a normal read.
    const wrapped = 'Here is the nameplate data:\n```json\n' + JSON.stringify({
      manufacturer: { value: 'ACME', confidence: 'high' },
      model: { value: 'X1', confidence: 'high' },
      voltage: { value: '480V', confidence: 'high' },
      kva: { value: 75, confidence: 'high' },
      phases: { value: 3, confidence: 'high' },
      frequency: { value: '60 Hz', confidence: 'high' },
    }) + '\n```';
    completeWithImageMock.mockResolvedValueOnce({ text: wrapped, model: 'gemini-2.5-flash' });

    const res = await request(app)
      .post('/api/assets/ocr-nameplate')
      .attach('image', dummyImage, { filename: 'plate.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.data.fields.kva).toBe(75);
    expect(refundIncrementMock).not.toHaveBeenCalled();
  });
});

// ── C. Domain validators wired end-to-end ────────────────────────────────────
describe('POST /api/assets/ocr-nameplate — domain validators reach the response', () => {
  test('kva == frequency (adjacent-value grab) → validator flags + confidence downgrade', async () => {
    // The exact observed failure the nameplate validators were built to catch
    // (2026-07-03 review §4 / commit 294613d): a crisp read from the wrong
    // row put "60" into the kva field while frequency is also "60 Hz". Two
    // separate checks should fire: V1 duplicate_value_across_fields, V2
    // kva_not_standard_size (60 is not on either standard ladder).
    const response = JSON.stringify({
      manufacturer:    { value: 'ACME',    confidence: 'high' },
      voltage:         { value: '480V',    confidence: 'high' },
      kva:             { value: 60,        confidence: 'high' }, // WRONG — grabbed from Hz row
      phases:          { value: 3,         confidence: 'high' },
      frequency:       { value: '60 Hz',   confidence: 'high' },
    });
    completeWithImageMock.mockResolvedValueOnce({ text: response, model: 'gemini-2.5-flash' });

    const res = await request(app)
      .post('/api/assets/ocr-nameplate')
      .attach('image', dummyImage, { filename: 'plate.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.data.fields.kva).toBe(60);
    // Confidence must have been downgraded — the whole point of the validators
    // is that the plate reader's own "high" self-assessment can't stand alone.
    expect(res.body.data.confidence.kva).toBe('low');
    // Machine-readable reasons must be present for the client tooltip.
    expect(Array.isArray(res.body.data.reasons.kva)).toBe(true);
    expect(res.body.data.reasons.kva.length).toBeGreaterThan(0);
  });
});
