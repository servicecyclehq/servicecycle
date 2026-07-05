'use strict';

/**
 * lib/testReportExtract.js — A2 Half 2 (2026-07-05) `--resume-from` argv
 * forwarding. Scoped narrowly to the subprocess-args wiring (mocks
 * child_process.execFile; never spawns the real python3 process). The
 * page-resilience behavior itself lives in pyextract/extractor.py and is
 * covered by the golden-set eval harness, not jest.
 */

jest.mock('child_process', () => ({
  execFile: jest.fn((_cmd, _args, _opts, cb) => cb(null, '{"ok":true,"measurements":[]}')),
}));

const { execFile } = require('child_process');
const { runDeterministic } = require('../lib/testReportExtract');

describe('runDeterministic — --resume-from forwarding', () => {
  test('appends --resume-from <N> when options.resumeFrom is set', async () => {
    execFile.mockClear();
    await runDeterministic(Buffer.from('%PDF-fake'), { resumeFrom: 7 });
    expect(execFile).toHaveBeenCalledTimes(1);
    const args = execFile.mock.calls[0][1];
    const idx = args.indexOf('--resume-from');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('7');
  });

  test('omits --resume-from on a first attempt (no resumeFrom passed)', async () => {
    execFile.mockClear();
    await runDeterministic(Buffer.from('%PDF-fake'));
    const args = execFile.mock.calls[0][1];
    expect(args).not.toContain('--resume-from');
  });

  test('omits --resume-from when resumeFrom is explicitly undefined', async () => {
    execFile.mockClear();
    await runDeterministic(Buffer.from('%PDF-fake'), { resumeFrom: undefined });
    const args = execFile.mock.calls[0][1];
    expect(args).not.toContain('--resume-from');
  });
});
