// dependency-cruiser config — architectural boundaries + cycle detection.
// Run report-only in CI (.github/workflows/depcruise.yml).
// Docs: https://github.com/sverweij/dependency-cruiser
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Circular dependencies make code hard to reason about and test.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-server-to-client',
      comment: 'The server package must never import from the client package.',
      severity: 'error',
      from: { path: '^server/' },
      to: { path: '^client/' },
    },
    {
      name: 'no-client-to-server',
      comment: 'The client package must never import from the server package.',
      severity: 'error',
      from: { path: '^client/' },
      to: { path: '^server/' },
    },
    {
      name: 'no-sdk-to-app',
      comment: 'The published SDK must stay standalone — no imports from server/ or client/.',
      severity: 'error',
      from: { path: '^sdk/' },
      to: { path: '^(server|client)/' },
    },
    {
      name: 'no-orphans',
      comment: 'Warn on modules that nothing imports and that import nothing (candidate dead code).',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$', // dotfiles
          '\\.d\\.ts$',
          '(^|/)tsconfig\\.',
          '(^|/)(index|main)\\.[jt]sx?$',
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    exclude: 'node_modules|/dist/|dist-verify|\\.timestamp-|/backups/|/uploads/|/sbom/|/pyextract/',
    enhancedResolveOptions: {
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json'],
    },
  },
};
