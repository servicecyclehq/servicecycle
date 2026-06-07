'use strict';

/**
 * scripts/seed-categories.js
 * --------------------------
 * Phase 1 of the non-SaaS expansion (2026-05-10). Seeds the 9 default
 * contract categories per account, and (optionally) backfills any
 * categoryless contracts to the account's "saas" category.
 *
 * Two entry points:
 *
 *   CLI (one-off, for backfilling an existing on-prem account):
 *     node server/scripts/seed-categories.js [accountId]
 *
 *   Programmatic (called by the demo-seed and the /api/auth/register flow):
 *     const { seedCategoriesForAccount } = require('./seed-categories');
 *     await seedCategoriesForAccount(accountId);
 *
 * The function is **idempotent** — runs safely on accounts that already
 * have categories. It uses upsert-by-(accountId, slug), so:
 *   - First call: creates all 9 system defaults
 *   - Subsequent calls: no-op (system defaults already exist with isSystemDefault=true)
 *   - User-renamed defaults: NOT reset (we match on slug, not name; user
 *     customizations to name/icon/color survive)
 *
 * The defaults encode renewal-management domain knowledge — typical notice
 * windows and auto-renewal patterns per category. See
 * docs/sessions/2026-05-10/non-saas-schema-design.md for the rationale.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ── The 9 default categories ─────────────────────────────────────────────────
// Order matters: displayOrder controls how they render in the picker. SaaS
// stays first because it's the historical default; Other stays last because
// it's the escape hatch.
const DEFAULT_CATEGORIES = [
  {
    slug: 'saas',
    name: 'SaaS subscription',
    icon: '💻',
    color: '#3b82f6',
    defaultNoticeDays: 30,
    defaultAutoRenewal: true,
    displayOrder: 10,
  },
  {
    slug: 'telecom',
    name: 'Telecom',
    icon: '📞',
    color: '#06b6d4',
    defaultNoticeDays: 30,
    defaultAutoRenewal: true,
    displayOrder: 20,
  },
  {
    slug: 'utilities',
    name: 'Utilities',
    icon: '⚡',
    color: '#eab308',
    defaultNoticeDays: 30,
    defaultAutoRenewal: false,
    displayOrder: 30,
  },
  {
    slug: 'insurance',
    name: 'Insurance',
    icon: '🛡️',
    color: '#10b981',
    defaultNoticeDays: 30,
    defaultAutoRenewal: true,
    displayOrder: 40,
  },
  {
    slug: 'lease_rent',
    name: 'Lease / rent',
    icon: '🏢',
    color: '#8b5cf6',
    defaultNoticeDays: 90, // commercial real estate notice is long; broker engagement adds months
    defaultAutoRenewal: false,
    displayOrder: 50,
  },
  {
    slug: 'facilities',
    name: 'Facilities',
    icon: '🧰',
    color: '#0ea5e9',
    defaultNoticeDays: 60,
    defaultAutoRenewal: true,
    displayOrder: 55,
  },
  {
    slug: 'hardware',
    name: 'Hardware & maintenance',
    icon: '🛠️',
    color: '#ef4444',
    defaultNoticeDays: 60,
    defaultAutoRenewal: true,
    displayOrder: 60,
  },
  {
    slug: 'services',
    name: 'Services & retainers',
    icon: '🤝',
    color: '#f97316',
    defaultNoticeDays: 30,
    defaultAutoRenewal: true,
    displayOrder: 70,
  },
  {
    slug: 'supplies',
    name: 'Supplies & consumables',
    icon: '📦',
    color: '#84cc16',
    defaultNoticeDays: 30,
    defaultAutoRenewal: false,
    displayOrder: 80,
  },
  {
    slug: 'other',
    name: 'Other',
    icon: '📋',
    color: '#64748b',
    defaultNoticeDays: 30,
    defaultAutoRenewal: false,
    displayOrder: 999,
  },
];

/**
 * Seed the 9 default categories for one account. Idempotent — safe to call
 * on accounts that already have categories.
 *
 * @param {string} accountId
 * @returns {Promise<{ created: number, alreadyExisted: number, total: number }>}
 */
async function seedCategoriesForAccount(accountId) {
  if (!accountId) throw new Error('seedCategoriesForAccount: accountId is required');

  let created = 0;
  let alreadyExisted = 0;

  for (const c of DEFAULT_CATEGORIES) {
    // Upsert by (accountId, slug). If the user has renamed a default, the
    // slug still matches; we update icon/color/defaultNoticeDays/defaultAutoRenewal
    // to our latest defaults but DO NOT overwrite the user's chosen name.
    // archivedAt is also preserved (so a category the user archived stays archived).
    const existing = await prisma.category.findUnique({
      where: { accountId_slug: { accountId, slug: c.slug } },
    });

    if (existing) {
      alreadyExisted++;
      continue;
    }

    await prisma.category.create({
      data: {
        accountId,
        slug:               c.slug,
        name:               c.name,
        icon:               c.icon,
        color:              c.color,
        defaultNoticeDays:  c.defaultNoticeDays,
        defaultAutoRenewal: c.defaultAutoRenewal,
        isSystemDefault:    true,
        displayOrder:       c.displayOrder,
        createdById:        null, // system-seeded
      },
    });
    created++;
  }

  return { created, alreadyExisted, total: DEFAULT_CATEGORIES.length };
}

/**
 * Backfill: assign the account's "saas" category to any contracts that have
 * categoryId IS NULL. Used once after the first migration so legacy contracts
 * (created before the category column existed) have a sensible default.
 *
 * Idempotent: contracts already assigned a category are skipped.
 *
 * @param {string} accountId
 * @returns {Promise<{ backfilled: number }>}
 */
async function backfillContractCategories(accountId) {
  if (!accountId) throw new Error('backfillContractCategories: accountId is required');

  const saasCategory = await prisma.category.findUnique({
    where: { accountId_slug: { accountId, slug: 'saas' } },
  });
  if (!saasCategory) {
    throw new Error(
      `backfillContractCategories: no "saas" category found for account ${accountId}. ` +
      `Run seedCategoriesForAccount first.`
    );
  }

  const result = await prisma.contract.updateMany({
    where: { accountId, categoryId: null },
    data:  { categoryId: saasCategory.id },
  });

  return { backfilled: result.count };
}

/**
 * Combined: seed defaults + backfill. The standard entry point for both
 * the demo-seed and an existing-account migration pass.
 */
async function seedAndBackfill(accountId) {
  const seed = await seedCategoriesForAccount(accountId);
  const backfill = await backfillContractCategories(accountId);
  return { ...seed, ...backfill };
}

// ── CLI entry ────────────────────────────────────────────────────────────────
if (require.main === module) {
  const accountId = process.argv[2];

  (async () => {
    if (!accountId) {
      console.error('Usage: node server/scripts/seed-categories.js <accountId>');
      console.error('');
      console.error('Seeds the 9 default categories for the specified account and');
      console.error('backfills any categoryless contracts to the saas category.');
      process.exit(1);
    }

    const result = await seedAndBackfill(accountId);
    console.log('Seed-categories complete:');
    console.log(JSON.stringify(result, null, 2));
    await prisma.$disconnect();
  })().catch(async (err) => {
    console.error('Seed-categories failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_CATEGORIES,
  seedCategoriesForAccount,
  backfillContractCategories,
  seedAndBackfill,
};
