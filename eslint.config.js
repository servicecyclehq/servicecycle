// Flat ESLint config (v0.92.3 QA) — first JS/JSX lint gate for the repo.
// Scope: the Vite React client (client/src) plus Node tooling/tests. The
// server is TypeScript and already gated by `tsc --noEmit`, so it's excluded
// here. Rules are intentionally pragmatic (warnings, not a wall of errors) so
// the gate is adoptable; tighten over time.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/dist-verify/**',
      'audit/**',
      '**/node_modules/**',
      'qa/**',
      'marketing-site/**',
      'client/public/**',
      '**/*.min.js',
      'server/**', // TS server is gated by tsc --noEmit
    ],
  },
  js.configs.recommended,
  {
    // Base: every JS file gets browser+node globals and JSX parsing so we
    // don't get a flood of no-undef false positives for console/window/etc.
    files: ['**/*.{js,jsx,cjs,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^[A-Z_]' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    // v0.92.17 QA: react-hooks lint gate on the client. exhaustive-deps as warn
    // (catches stale-closure / missing-dep bugs like the v0.92.15 Help-drawer
    // regression that opened the wrong screen's help); rules-of-hooks as error.
    files: ['client/src/**/*.{js,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
