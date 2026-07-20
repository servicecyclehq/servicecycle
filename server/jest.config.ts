import type { Config } from 'jest';

// Pin the test process to UTC. date-fns interval math (lib/maintenanceInterval)
// is local-time based; on a UTC-behind host (America/Chicago) UTC-midnight date
// anchors roll to the prior day and month/year assertions drift. CI runs in UTC;
// this makes local runs match. Set here (loaded before any test Date usage).
process.env.TZ = 'UTC';

const config: Config = {
  // Serialize all tests — new integration tests hit a shared DB
  maxWorkers: 1,

  projects: [
    // ──────────────────────────────────────────────────────────────────────
    // Existing unit / security tests (JS, esbuild transform, stubbed Prisma)
    // ──────────────────────────────────────────────────────────────────────
    {
      displayName: 'unit',
      testEnvironment: 'node',
      transform: {
        '^.+\\.[tj]sx?$': '<rootDir>/jest.esbuild.cjs',
      },
      testMatch: ['<rootDir>/tests/**/*.test.js'],
      transformIgnorePatterns: ['node_modules/(?!(uuid|nanoid)/)'],
      moduleNameMapper: {
        // 2026-07-08 audit (QA Medium W1-M8) — INVESTIGATED, NOT applied as
        // originally proposed. The audit's diagnosis is correct: this pattern
        // requires a path segment between the leading `./`/`../` and the
        // trailing `/prisma` (it needs two slashes), so it matches
        // `../lib/prisma` but not the bare `./prisma` form ~48 lib/*.ts files
        // use (e.g. activityLog.ts, webhookDlq.ts). The prescribed fix
        // ("broaden the regex so both forms resolve to the mock") was tried
        // and reverted after verification: at least 5 existing test files
        // (activityLogIp, partnerWebhookSigning, oemTargetAccountScope,
        // extractionTelemetryCommitScope, webhookDlq — see their own
        // in-file comments) DELIBERATELY rely on the exact gap this would
        // close, either via an explicit `.ts`-suffixed jest.mock('../lib/
        // prisma.ts', factory) that only lines up with activityLog.ts's
        // unmapped `./prisma` import today, or via a real PrismaClient the
        // test swaps in specifically because "the row lands in the real
        // table IS the contract" (earlyAccess/webhookDlq's own words).
        // Broadening the mapper redirects those lib files' `./prisma` to the
        // generic no-op stub instead, silently breaking the mock/spy wiring
        // those tests assert against — confirmed by an isolated repro run
        // (4 suites, 18/27 tests, 100% deterministic, zero DB/flakiness
        // involved: `npx jest --selectProjects unit tests/activityLogIp.test.js
        // tests/partnerWebhookSigning.test.js tests/oemTargetAccountScope.test.js
        // tests/extractionTelemetryCommitScope.test.js`). A correct fix needs
        // a per-file pass (either migrate the real-DB-contract tests into the
        // "integration" project below, where a real DB is the point, or
        // repoint each custom mock at the mapper's actual redirect target)
        // — that's a real remediation project, not a one-line regex change,
        // and is called out as a follow-up in the audit-remediation report
        // rather than risking a shipped regression here. Left unchanged.
        '^(\\.{1,2}/.*)/prisma$': '<rootDir>/tests/__mocks__/prisma.js',
      },
    },

    // ──────────────────────────────────────────────────────────────────────
    // New Partner Flywheel integration tests (TypeScript, ts-jest, real DB)
    // ──────────────────────────────────────────────────────────────────────
    {
      displayName: 'integration',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/__tests__/**/*.test.ts'],
      transform: {
        // TypeScript files → ts-jest (type-aware, handles .ts/.tsx)
        '^.+\\.tsx?$': ['ts-jest', {
          tsconfig: {
            module: 'CommonJS',
            esModuleInterop: true,
            skipLibCheck: true,
            types: ['node', 'jest'],
          },
        }],
        // Plain JS (incl. ESM-only node_modules like uuid@14) → esbuild CJS
        '^.+\\.m?js$': '<rootDir>/jest.esbuild.cjs',
      },
      // Transform uuid/nanoid instead of ignoring them — they ship pure ESM
      transformIgnorePatterns: ['node_modules/(?!(uuid|nanoid)/)'],
      // setup-env.ts: sets NODE_ENV=test + env vars BEFORE any module loads
      // setup.ts:     jest.mock() calls (needs jest framework installed first)
      setupFiles: ['<rootDir>/__tests__/helpers/setup-env.ts'],
      setupFilesAfterEnv: ['<rootDir>/__tests__/helpers/setup.ts'],
      testTimeout: 30000,
    },
  ],

  // 2026-07-08 audit (QA Low — "no coverage threshold anywhere"): a starting
  // floor, not a target. Measured locally on the "unit" project with the
  // SAME command CI's "Unit tests" step now runs (--coverage added there):
  // ~43.6% statements / 34.3% branches / 46.9% functions / 45.9% lines.
  // Set comfortably below that (not at it) so this doesn't immediately fail
  // CI on day one; it exists to catch a REGRESSION (coverage dropping), not
  // to certify "well tested." Jest only measures files actually required by
  // the tests that ran (no collectCoverageFrom configured), so this scopes
  // to the same files the number above covers. Raise these over time as real
  // coverage improves — don't lower them.
  coverageThreshold: {
    global: {
      statements: 35,
      branches: 25,
      functions: 35,
      lines: 35,
    },
  },
};

export default config;
