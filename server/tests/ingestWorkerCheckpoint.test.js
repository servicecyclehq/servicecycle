'use strict';

/**
 * lib/ingestWorker — checkpoint-plumbing tests (2026-07-05, §11 A2 Half 1).
 * Scoped narrowly to `runIngestJob`'s new resumeFrom/lastGoodPage/pageProgress
 * wiring -- NOT a general worker test suite (the queue-claim SQL is
 * integration-only and already covered by the "builder is injectable" design
 * this file relies on). prisma is fully mocked; no real DB.
 */

// jest.config.ts's moduleNameMapper (`^(\.{1,2}/.*)/prisma$`) only redirects
// specifiers like '../lib/prisma' (an extra path segment before the leaf) to
// the global tests/__mocks__/prisma.js stub -- it does NOT match a bare
// './prisma' sibling require, which is exactly how ingestWorker.ts pulls in
// the client (`require('./prisma').default` from inside lib/). A plain
// `jest.mock('../lib/prisma', ...)` call here would itself get redirected by
// that same mapper and never reach the module ingestWorker.ts actually loads
// -- proven by an earlier run of this file that hit the REAL dev Postgres
// (PrismaClientKnownRequestError: lastGoodPage column doesn't exist locally
// yet). Mocking by absolute path sidesteps the mapper (it only matches
// dot-relative specifiers) and lands on the same resolved file both call
// sites use.
const path = require('path');
const PRISMA_PATH = path.resolve(__dirname, '../lib/prisma');

jest.mock(PRISMA_PATH, () => ({
  default: {
    ingestJob: { update: jest.fn(async () => ({})) },
    activityLog: { create: jest.fn(() => ({ catch: () => {} })) },
  },
}));
jest.mock('../lib/storage', () => ({ downloadFile: jest.fn(async () => Buffer.from('fake-pdf')) }));

const prisma = require(PRISMA_PATH).default;
const { runIngestJob } = require('../lib/ingestWorker');

function baseJob(overrides = {}) {
  return {
    id: 'job-1', accountId: 'acct-1', createdById: 'user-1', kind: 'test_report',
    autoCommit: false, attempts: 1, fileKey: 'k', fileName: 'report.pdf',
    lastGoodPage: null,
    ...overrides,
  };
}

describe('runIngestJob — resumeFrom hint passthrough', () => {
  test('passes resumeFrom: undefined when lastGoodPage is null (first attempt)', async () => {
    const builder = jest.fn(async () => ({ measurements: [], pageCount: 5, pagesScanned: 5 }));
    await runIngestJob(baseJob({ lastGoodPage: null }), builder);
    expect(builder.mock.calls[0][1].resumeFrom).toBeUndefined();
  });

  test('passes resumeFrom: <lastGoodPage> on a retried job', async () => {
    const builder = jest.fn(async () => ({ measurements: [], pageCount: 5, pagesScanned: 5 }));
    await runIngestJob(baseJob({ lastGoodPage: 3 }), builder);
    expect(builder.mock.calls[0][1].resumeFrom).toBe(3);
  });
});

describe('runIngestJob — checkpoint on success', () => {
  test('records lastGoodPage from pagesScanned (NOT the raw pageCount) + pageProgress', async () => {
    // A2 Half 2 correctness fix (2026-07-05): lastGoodPage used to be written
    // as the raw pageCount (12) unconditionally. That was only ever truthful
    // pre-Half-2, when a per-page exception always took the FAILURE branch
    // below -- reaching this success branch implied every page was scanned.
    // Now extract_fields() can catch a per-page exception and still return
    // normally (truncated, pagesScanned < pageCount) -- see
    // pyextract/extractor.py's docstring -- so lastGoodPage must reflect
    // pagesScanned (how far we actually got), not the document's total page
    // count. This test's pageCount(12) != pagesScanned(10) on purpose to
    // catch a regression back to the old (wrong) behavior.
    prisma.ingestJob.update.mockClear();
    const builder = jest.fn(async () => ({ measurements: [], pageCount: 12, pagesScanned: 10, truncated: true, pageError: null }));
    await runIngestJob(baseJob(), builder);
    const doneCall = prisma.ingestJob.update.mock.calls.find((c) => c[0].data.status === 'done');
    expect(doneCall).toBeTruthy();
    expect(doneCall[0].data.lastGoodPage).toBe(10);
    expect(doneCall[0].data.pageProgress).toEqual({ totalPages: 12, pagesCompleted: 10, lastError: null, truncated: true });
  });

  test('records a clean (non-truncated) completion when pagesScanned === pageCount', async () => {
    prisma.ingestJob.update.mockClear();
    const builder = jest.fn(async () => ({ measurements: [], pageCount: 12, pagesScanned: 12, truncated: false }));
    await runIngestJob(baseJob(), builder);
    const doneCall = prisma.ingestJob.update.mock.calls.find((c) => c[0].data.status === 'done');
    expect(doneCall[0].data.lastGoodPage).toBe(12);
    expect(doneCall[0].data.pageProgress).toEqual({ totalPages: 12, pagesCompleted: 12, lastError: null, truncated: false });
  });

  test('A2 Half 2: a caught per-page exception still completes the job, with the page error preserved as pageProgress.lastError', async () => {
    // The actual resilience win: extract_fields() no longer throws when one
    // page in a large document is bad -- it returns normally with whatever
    // it collected before the bad page, so the job still finishes (not
    // 'failed') and the checkpoint records exactly where it stopped.
    prisma.ingestJob.update.mockClear();
    const builder = jest.fn(async () => ({
      measurements: [], pageCount: 150, pagesScanned: 46, truncated: true,
      pageError: 'page 47: division by zero',
    }));
    await runIngestJob(baseJob({ lastGoodPage: null }), builder);
    const doneCall = prisma.ingestJob.update.mock.calls.find((c) => c[0].data.status === 'done');
    expect(doneCall).toBeTruthy();
    expect(doneCall[0].data.lastGoodPage).toBe(46);
    expect(doneCall[0].data.pageProgress).toEqual({
      totalPages: 150, pagesCompleted: 46, lastError: 'page 47: division by zero', truncated: true,
    });
  });

  test('leaves checkpoint fields absent when the result carries no pageCount (e.g. pdfjs fallback)', async () => {
    prisma.ingestJob.update.mockClear();
    const builder = jest.fn(async () => ({ measurements: [] })); // no pageCount at all
    await runIngestJob(baseJob(), builder);
    const doneCall = prisma.ingestJob.update.mock.calls.find((c) => c[0].data.status === 'done');
    expect(doneCall.data ? doneCall.data.lastGoodPage : doneCall[0].data.lastGoodPage).toBeUndefined();
  });
});

describe('runIngestJob — checkpoint on failure', () => {
  test('records pageProgress.lastError without touching lastGoodPage', async () => {
    prisma.ingestJob.update.mockClear();
    const builder = jest.fn(async () => { throw new Error('boom'); });
    await runIngestJob(baseJob({ attempts: 3 }), builder); // terminal (MAX_ATTEMPTS=3)
    const failCall = prisma.ingestJob.update.mock.calls.find((c) => c[0].data.status === 'failed');
    expect(failCall).toBeTruthy();
    expect(failCall[0].data.pageProgress).toEqual({ lastError: 'boom' });
    expect(failCall[0].data.lastGoodPage).toBeUndefined(); // never overwritten with a guess
  });

  test('a non-terminal failure requeues with the same lastError-only pageProgress', async () => {
    prisma.ingestJob.update.mockClear();
    const builder = jest.fn(async () => { throw new Error('transient'); });
    await runIngestJob(baseJob({ attempts: 1 }), builder); // not terminal yet
    const queuedCall = prisma.ingestJob.update.mock.calls.find((c) => c[0].data.status === 'queued');
    expect(queuedCall).toBeTruthy();
    expect(queuedCall[0].data.pageProgress).toEqual({ lastError: 'transient' });
  });
});
