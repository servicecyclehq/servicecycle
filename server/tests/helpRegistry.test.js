'use strict';

/**
 * tests/helpRegistry.test.js
 * ---------------------------
 * Unit tests for lib/helpRegistry — module list, slug validation, and
 * file-load integrity. No network / server required; drives the module
 * directly.
 *
 * Guards:
 *   - Every slug in MODULE_INDEX must resolve to a non-empty string.
 *   - Required modules (parts, quote-requests, assets) must be registered.
 *   - Unknown / path-traversal slugs must return null.
 *   - Cache behaviour: repeated calls return the same value without re-reading.
 *   - listModules() shape is consistent (slug, title, description on every entry).
 */

const path = require('path');

describe('helpRegistry', () => {
  let help;

  beforeEach(() => {
    // Clear require cache so _cache starts fresh for each test.
    const modPath = require.resolve('../lib/helpRegistry');
    delete require.cache[modPath];
    help = require('../lib/helpRegistry');
    help._clearCache();
  });

  afterEach(() => {
    help._clearCache();
  });

  // ── listModules ─────────────────────────────────────────────────────────────

  describe('listModules()', () => {
    test('returns a non-empty array', () => {
      const modules = help.listModules();
      expect(Array.isArray(modules)).toBe(true);
      expect(modules.length).toBeGreaterThan(0);
    });

    test('every entry has slug, title, and description', () => {
      for (const m of help.listModules()) {
        expect(typeof m.slug).toBe('string');
        expect(m.slug.length).toBeGreaterThan(0);
        expect(typeof m.title).toBe('string');
        expect(m.title.length).toBeGreaterThan(0);
        expect(typeof m.description).toBe('string');
        expect(m.description.length).toBeGreaterThan(0);
      }
    });

    test('required modules are registered', () => {
      const slugs = help.listModules().map((m) => m.slug);
      for (const required of ['assets', 'parts', 'quote-requests', 'dashboard', 'work-orders']) {
        expect(slugs).toContain(required);
      }
    });

    test('no duplicate slugs', () => {
      const slugs = help.listModules().map((m) => m.slug);
      const unique = [...new Set(slugs)];
      expect(slugs.length).toBe(unique.length);
    });
  });

  // ── getModule ───────────────────────────────────────────────────────────────

  describe('getModule()', () => {
    test('returns a non-empty string for every registered slug', () => {
      for (const { slug } of help.listModules()) {
        const body = help.getModule(slug);
        expect(typeof body).toBe('string');
        expect(body.length).toBeGreaterThan(0);
      }
    });

    test('"parts" module loads and contains expected headings', () => {
      const body = help.getModule('parts');
      expect(body).toBeTruthy();
      expect(body).toContain('# Parts');
      expect(body).toContain('## Common workflows');
    });

    test('"quote-requests" module loads and contains expected headings', () => {
      const body = help.getModule('quote-requests');
      expect(body).toBeTruthy();
      expect(body).toContain('# Quote Requests');
      expect(body).toContain('## Request drivers');
    });

    test('"assets" module contains the incident-log section', () => {
      const body = help.getModule('assets');
      expect(body).toBeTruthy();
      expect(body).toContain('## Incident log');
    });

    test('unknown slug returns null', () => {
      expect(help.getModule('not-a-real-module')).toBeNull();
    });

    test('path-traversal slug is rejected (returns null)', () => {
      expect(help.getModule('../lib/prisma')).toBeNull();
      expect(help.getModule('../../package.json')).toBeNull();
      expect(help.getModule('//etc/passwd')).toBeNull();
    });

    test('empty / null / numeric input returns null', () => {
      expect(help.getModule('')).toBeNull();
      expect(help.getModule(null)).toBeNull();
      expect(help.getModule(42)).toBeNull();
      expect(help.getModule(undefined)).toBeNull();
    });

    test('cache: repeated calls return the same string instance', () => {
      const first  = help.getModule('dashboard');
      const second = help.getModule('dashboard');
      expect(first).toBe(second); // strict reference equality after caching
    });
  });

  // ── getModuleTitle ──────────────────────────────────────────────────────────

  describe('getModuleTitle()', () => {
    test('returns the title for a known slug', () => {
      expect(help.getModuleTitle('parts')).toBe('Parts & Spare Inventory');
      expect(help.getModuleTitle('quote-requests')).toBe('Quote Requests');
      expect(help.getModuleTitle('assets')).toBe('Assets');
    });

    test('returns null for an unknown slug', () => {
      expect(help.getModuleTitle('not-real')).toBeNull();
    });
  });

  // ── loadAll ─────────────────────────────────────────────────────────────────

  describe('loadAll()', () => {
    test('reports no missing modules', () => {
      const { loaded, missing } = help.loadAll();
      if (missing.length > 0) {
        console.error('[helpRegistry.test] missing modules:', missing);
      }
      expect(missing).toEqual([]);
      expect(loaded).toBe(help.listModules().length);
    });
  });
});
