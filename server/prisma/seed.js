// prisma/seed.js — intentionally minimal.
//
// ServiceCycle conversion note: the inherited contract-renewal demo seed
// (Acme account + vendors + 10 contracts) was removed with the schema
// rework. Demo / sample data now lives in scripts/seed-demo.js, which owns
// the DEMO_ACCOUNT_ID lifecycle and is invoked by the demo reset cron and
// the operator tooling.
//
// This file stays as the `prisma db seed` / `npm run seed` entry point so
// the Prisma tooling contract is unchanged, but it deliberately seeds
// nothing — the setup wizard creates the first account/user on a fresh
// install, and global infrastructure rows (InstanceConfig singleton, the
// NFPA 70B / NETA task-definition matrix, ComplianceStandard editions) are
// created lazily by the application / owned by scripts/seed-demo.js.

console.log('[seed] prisma/seed.js is a no-op — demo/sample data seeding is handled by scripts/seed-demo.js.');
