// F-QA-JEST-TS (2026-06-02): the server's specs import .ts modules, but Jest's
// default Babel couldn't parse TS syntax, so every .ts-importing test silently
// failed to run (incl. webhook.ssrf.test.js). This wires an esbuild transform
// (no new dependency) so the security test suite actually executes.
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]sx?$': '<rootDir>/jest.esbuild.cjs',
  },
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  // uuid v14 (and other ESM-only deps) ship ESM; let the transform handle them
  // instead of Jest's default "ignore all node_modules".
  transformIgnorePatterns: ['node_modules/(?!(uuid|nanoid)/)'],
  // Prisma client instantiates at import; stub it so unit tests don't need a DB.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)/prisma$': '<rootDir>/tests/__mocks__/prisma.js',
  },
};
