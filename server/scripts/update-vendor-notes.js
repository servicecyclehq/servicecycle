/**
 * update-vendor-notes.js
 * One-shot script: populates vendor.notes with researched procurement intelligence
 * for all 13 seed vendors + upserts 7 missing vendors (IBM, Oracle, VMware,
 * Arctic Wolf, Palo Alto, AWS, Splunk) referenced by prisma/seed-demo.js V map.
 *
 * Safe to re-run (upserts + updates are idempotent).
 * Run: node scripts/update-vendor-notes.js
 */
// Try local dev .env first, then the droplet compose .env
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
if (!process.env.DATABASE_URL) {
  require('dotenv').config({ path: '/root/lapseiq/.env' });
}
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';

const VENDOR_NOTES = [
  // ── Existing vendors (created by prisma/seed.js) ──────────────────────────
  {
    id: '00000000-0000-0000-0000-000000000020', // Microsoft
    notes: 'FY ends June 30; Q4 (Apr-Jun) is highest-leverage window. 33% M365 price increase staged for Jul 2026 -- cumulative 15-23% uplift risk. Negotiate multi-year terms with pre-July price lock, right-size via usage data, and threaten Azure competitive migration for real concessions. Reject auto-renewal defaults and negotiate price caps for next cycle into the current ELA. Start engagement 6+ months out.',
  },
  {
    id: '00000000-0000-0000-0000-000000000021', // Salesforce
    notes: 'FY ends Jan 31; quarter-ends (Apr 30, Jul 31, Oct 31, Jan 31) are peak negotiation windows. Standard renewal uplift 7-10% annually; target 0% on first renewal using HubSpot or Microsoft Dynamics as competitive pressure. Push for 3-year fixed-price terms. Reject "then-current list price" language -- it resets all negotiated discounts at renewal. 60-day opt-out window for auto-renewal; missing it locks another year. Add-on modules offered free during onboarding routinely convert to paid at renewal.',
  },
  {
    id: '00000000-0000-0000-0000-000000000022', // CrowdStrike
    notes: 'FY ends Jan 31; quarter-ends are quota pressure points. Negotiated discount range 10-20% off list. SentinelOne quotes drive 35-50% cost reduction threat -- get one before every renewal. Volume breakpoints at 500, 1,000, and 2,500 endpoints unlock better pricing. Multi-year prepay adds additional savings. Expanding endpoints or adding modules mid-term can trigger full repricing -- negotiate expansion pricing explicitly. Annual prepayment often required for discounted pricing.',
  },
  {
    id: '00000000-0000-0000-0000-000000000023', // Okta
    notes: 'FY ends Jan 31; Nov-Jan window is highest-leverage. Average negotiated savings 14% off list; multi-year unlocks 15-30%. Audit inactive users before renewal -- typically reclaims 8-15% of seats. Microsoft Entra ID (included in M365 E3/E5) is a credible displacement threat driving 20-30% reductions. Customer Identity Cloud uses MAU-based pricing with overage billing -- negotiate MAU bands with rollover provisions. Cap annual escalation at 5% or CPI.',
  },
  {
    id: '00000000-0000-0000-0000-000000000024', // Atlassian
    notes: 'FY ends Jul 31; tier-based cloud pricing post-Server migration. Jira and Confluence can be co-termed on anniversary date for a unified negotiation. Premium tier adds advanced roadmaps and admin insights -- evaluate at renewal if product/engineering teams are scaling. Cloud migration incentive period has ended; negotiate on volume and multi-year terms. Standard 30-day cancel notice on annual plans.',
  },
  {
    id: '00000000-0000-0000-0000-000000000025', // Zoom
    notes: 'FY ends Jan 31; Q4 (Nov-Jan) is peak discount window. Reps authorized to offer 10-15% incremental concessions plus free months for Q4 close. Slowing growth (3-7% YoY since 2023) makes reps flexible on churn prevention. Microsoft Teams overlap (bundled in M365 E3/E5) is a credible displacement threat. Zoom Phone pricing tiers reset upward at renewal if not locked. 30-day written notice required to non-renew.',
  },
  {
    id: '00000000-0000-0000-0000-000000000026', // ServiceNow
    notes: 'FY ends Dec 31; Q4 (Oct-Dec) is prime leverage window. Standard uplift proposals 15-25%; begin negotiations 9-12 months out -- ServiceNow deliberately delays to compress options. Shelfware audit + BMC Helix or Freshservice competitive POC drives 40-50% discounts on core ITSM at scale. Now Assist AI add-ons push 30-42% uplift over ITSM Pro -- reject edition upgrades unless driven by genuine business need. Auto-activation of Enterprise-tier features during upgrades triggers retroactive billing. 60-day non-renewal notice window.',
  },
];

const NEW_VENDORS = [
  {
    id: '00000000-0000-0000-0000-000000000040',
    name: 'IBM',
    cotermComplexity: 'complex',
    cotermNotes: 'Multiple product lines (Watsonx, Cognos, S&S). ELA negotiation consolidates fragmented contracts. Watch for sub-capacity ILMT non-compliance triggering full-physical-capacity billing.',
    notes: 'FY ends Dec 31; Q4 (Oct-Dec) is peak quota pressure -- best window for concessions. Standard 10-20% off list; 25-40% on 3-5yr ELAs. IBM often drops initial discounts at renewal (the "price rollback trap") -- contractualize price holds at year 1 signing. S&S auto-renews by default with no opt-out reminder. LMS audit risk escalates when procurement challenges renewal terms aggressively -- IBM sales and audit teams are organizationally aligned. Engage SAM tooling and external IBM licensing counsel before any audit notice arrives.',
  },
  {
    id: '00000000-0000-0000-0000-000000000041',
    name: 'Oracle',
    cotermComplexity: 'complex',
    cotermNotes: 'Database (UCE/NUP) and application licenses on separate schedules. 4% annual support escalator embedded contractually. 90+ day written notice required to cancel.',
    notes: 'FY ends May 31; Q4 (Mar-May) strongest window -- engage 6-12 months out, never wait for Oracle first offer. Standard 4% support increase embedded contractually; 2026 list price increases 12-18% on database and application licenses. LMS audit notices follow renewal pushback within 60-90 days. Third-party support (Rimini Street, Support Revolution) at 50% cost and documented migration to AWS RDS, Azure SQL, or PostgreSQL are the strongest leverage points. Auto-renewal defaults to invoice at increased price without new signature.',
  },
  {
    id: '00000000-0000-0000-0000-000000000042',
    name: 'VMware / Broadcom',
    cotermComplexity: 'complex',
    cotermNotes: 'Post-Broadcom (Nov 2023): subscription-only, minimum 72 cores/product. All SKUs consolidated into VCF or VVF bundles. 20% late-renewal surcharge if anniversary date is missed.',
    notes: 'Post-Broadcom acquisition (Nov 2023): perpetual licensing eliminated, ~8,000 SKUs consolidated into VCF and VVF bundles. Price increases 150-1,500% vs. prior rates. Minimum 72 cores per product line enforced; 20% late-renewal surcharge if anniversary date is missed -- set calendar alerts 120 days out. Nutanix AHV migration promo (valid through Jul 2026) is the most credible displacement threat. Smaller customers have almost no reseller channel leverage post-acquisition.',
  },
  {
    id: '00000000-0000-0000-0000-000000000043',
    name: 'Arctic Wolf',
    cotermComplexity: 'none',
    cotermNotes: 'Asset-based pricing; all services (MDR, Managed Risk, SAT) on same annual anniversary. 60-day non-renewal notice required -- double the industry standard.',
    notes: 'Asset-based pricing ($8-25/endpoint/month); 1,000+ endpoint deployments negotiate $8-14/endpoint/month. 60-day non-renewal notice window (vs. industry-standard 30 days) -- calendar alert is critical. Physical sensor hardware ($1,250-$22,000 per sensor) billed separately from subscription and often missed in TCO. Bundle MDR + Managed Risk + Security Awareness Training for 15-30% discount. CrowdStrike Falcon Complete and Huntress are credible competitive alternatives. Verify endpoint scope before renewal -- broad "protected assets" language can inflate billable count.',
  },
  {
    id: '00000000-0000-0000-0000-000000000047',
    name: 'Palo Alto Networks',
    cotermComplexity: 'moderate',
    cotermNotes: 'NGFW, Prisma Cloud, and Cortex XDR on separate SKUs. Platformization bundle simplifies but deepens lock-in. 30-day cancellation window on annual subscriptions.',
    notes: 'FY ends Jul 31; June-July is the peak discount window. 3-year terms save ~32% vs. annual -- multi-year is the single strongest lever. Platformization push (NGFW + Prisma Cloud + Cortex XDR bundle) creates deep lock-in at renewal; model per-product cost before accepting bundle pricing. Enterprise buyers with competitive pressure (CrowdStrike, Fortinet, Check Point) can reach 35-50% off quote. Support contracts (Premium/Platinum) escalate 8-12% annually if uplift not capped -- negotiate support escalator limits in the MSA.',
  },
  {
    id: '00000000-0000-0000-0000-000000000048',
    name: 'AWS',
    cotermComplexity: 'complex',
    cotermNotes: 'EDP multi-year spend commit. Annual commit cannot decrease YoY under standard terms. Marketplace spend offsets up to 25% of EDP. Enterprise Support (10% of spend) negotiated separately.',
    notes: 'EDP discount tiers: 5-8% at $500K-$2M annual commit; 8-12% at $2M-$5M; 12-18% at $5M-$10M. Annual commits cannot decrease YoY under standard terms -- negotiate ratchet-down provisions upfront. FY ends Jan 31; Q4 (Nov-Jan) is most urgent. Overcommitment triggers shortfall penalties at full list rate on unmet delta. Marketplace spend offsets up to 25% of EDP commit (eligibility tightened May 2025). Azure and GCP competitive proposals plus RI/Savings Plans utilization data are the strongest levers.',
  },
  {
    id: '00000000-0000-0000-0000-000000000049',
    name: 'Splunk',
    cotermComplexity: 'moderate',
    cotermNotes: 'GB/day ingest-based pricing. 9% annual uplift is published policy. Cisco acquisition (Mar 2024) -- upsell to adjacent Cisco products expected at every renewal.',
    notes: 'Published 9% annual price increase on all licenses -- documented policy, not a negotiating tactic. Under Cisco ownership (acquired Mar 2024), upsell to Observability, ITSI, and adjacent Cisco products is baked into every renewal. FY aligns with Cisco Jul 31; Oct/Jan/Apr/Jul quarter-ends are best windows. Engage 90-120 days out with Microsoft Sentinel or Elastic Security alternatives to achieve 20-35% reduction vs. the 9% path. Lock in GB/day ingest rates now before Cisco transitions to outcome-based billing. GB/day overage charges can spike if log sources grow mid-term.',
  },
];

async function main() {
  console.log('🔧  Updating vendor notes...\n');

  // Update notes on existing vendors
  let updated = 0;
  for (const { id, notes } of VENDOR_NOTES) {
    try {
      const v = await prisma.vendor.update({ where: { id }, data: { notes } });
      console.log(`  ✓  Updated ${v.name}`);
      updated++;
    } catch (e) {
      console.warn(`  ⚠  ${id}: ${e.message}`);
    }
  }

  // Upsert missing vendors
  let upserted = 0;
  for (const { id, name, cotermComplexity, cotermNotes, notes } of NEW_VENDORS) {
    try {
      const v = await prisma.vendor.upsert({
        where: { id },
        update: { notes },
        create: { id, accountId: ACCOUNT_ID, name, cotermComplexity, cotermNotes, notes },
      });
      console.log(`  ✓  Upserted ${v.name}`);
      upserted++;
    } catch (e) {
      console.warn(`  ⚠  ${name} (${id}): ${e.message}`);
    }
  }

  console.log(`\n✅  Done — ${updated} updated, ${upserted} upserted`);
}

main()
  .catch((e) => { console.error('Script failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
