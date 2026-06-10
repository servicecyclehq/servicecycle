import type { Config } from 'jest';

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
};

export default config;
