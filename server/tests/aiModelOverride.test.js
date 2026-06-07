'use strict';

/**
 * L2: AI_MODEL_OVERRIDE precedence — pure unit test.
 *
 * Mocks the @anthropic-ai/sdk so the test runs offline and burns no API credit.
 * Captures the exact `model` parameter sent to messages.create() and asserts
 * the resolution order:
 *   1. AI_MODEL_OVERRIDE (env)         — wins over everything (operator forced)
 *   2. settings.model (per-call arg)
 *   3. AI_MODEL (env)
 *   4. provider default (claude-haiku-4-5 for anthropic)
 */

const path = require('path');

// Snapshot env so per-test mutations don't leak.
const ORIG = {
  AI_MODEL_OVERRIDE: process.env.AI_MODEL_OVERRIDE,
  AI_MODEL:          process.env.AI_MODEL,
  AI_PROVIDER:       process.env.AI_PROVIDER,
  AI_API_KEY:        process.env.AI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
};

let lastCreateArgs;

// Mock the Anthropic SDK before lib/ai.js requires it.
jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: {
      create: async (args) => {
        lastCreateArgs = args;
        return { content: [{ text: '{}' }] };
      },
    },
  }));
});

const ai = require('../lib/ai');

beforeEach(() => {
  lastCreateArgs = undefined;
  delete process.env.AI_MODEL_OVERRIDE;
  delete process.env.AI_MODEL;
  process.env.AI_PROVIDER = 'anthropic';
  process.env.AI_API_KEY  = 'sk-test-not-real';
});

afterAll(() => {
  for (const [k, v] of Object.entries(ORIG)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('L2: AI_MODEL_OVERRIDE precedence in lib/ai.js', () => {

  test('with no env, falls through to provider default (claude-haiku-4-5)', async () => {
    await ai.complete({ system: 'sys', user: 'hi' });
    expect(lastCreateArgs.model).toBe('claude-haiku-4-5');
  });

  test('AI_MODEL is honoured when AI_MODEL_OVERRIDE is unset', async () => {
    process.env.AI_MODEL = 'claude-sonnet-4-5-20250929';
    await ai.complete({ system: 'sys', user: 'hi' });
    expect(lastCreateArgs.model).toBe('claude-sonnet-4-5-20250929');
  });

  test('per-call settings.model wins over AI_MODEL', async () => {
    process.env.AI_MODEL = 'claude-sonnet-4-5-20250929';
    await ai.complete({ system: 'sys', user: 'hi', settings: { model: 'claude-opus-4-5-20250101' } });
    expect(lastCreateArgs.model).toBe('claude-opus-4-5-20250101');
  });

  test('AI_MODEL_OVERRIDE wins over per-call settings.model and AI_MODEL (the demo lever)', async () => {
    process.env.AI_MODEL          = 'claude-sonnet-4-5-20250929';
    process.env.AI_MODEL_OVERRIDE = 'claude-haiku-4-5-20251001';
    await ai.complete({ system: 'sys', user: 'hi', settings: { model: 'claude-opus-4-5-20250101' } });
    expect(lastCreateArgs.model).toBe('claude-haiku-4-5-20251001');
  });

  test('completeWithImage also respects AI_MODEL_OVERRIDE', async () => {
    process.env.AI_MODEL_OVERRIDE = 'claude-haiku-4-5-20251001';
    const fakeBuf = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // PNG-ish header bytes
    await ai.completeWithImage({ imageBuffer: fakeBuf, mediaType: 'image/png', prompt: 'extract' });
    expect(lastCreateArgs.model).toBe('claude-haiku-4-5-20251001');
  });

  test('the model param flows through to the SDK unchanged (no transformation)', async () => {
    process.env.AI_MODEL_OVERRIDE = 'some-future-model-2026-12-25';
    await ai.complete({ user: 'hi' });
    expect(lastCreateArgs.model).toBe('some-future-model-2026-12-25');
  });
});
