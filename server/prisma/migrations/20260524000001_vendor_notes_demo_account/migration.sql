-- 20260524000001_vendor_notes_demo_account
-- Corrective migration: first migration targeted fixed IDs from seed.js
-- (account 000...001) which does not exist on the demo droplet.
-- This migration targets the dynamic demo account (111...111) by name.
--
-- Updates notes on the 12 VENDOR_SPECS vendors that exist in the demo DB,
-- then upserts 7 additional vendors (IBM, Oracle, VMware/Broadcom, Arctic Wolf,
-- Palo Alto Networks, AWS-if-missing, Splunk) into the demo account.
-- Safe to re-run: all operations are idempotent.

-- â”€â”€ Update existing VENDOR_SPECS vendors (by name + accountId) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

UPDATE "vendors" SET
  "notes" = 'FY ends June 30; Q4 (Apr-Jun) is highest-leverage window. 33% M365 price increase staged for Jul 2026 -- cumulative 15-23% uplift risk. Negotiate multi-year terms with pre-July price lock, right-size via usage data, and threaten Azure competitive migration for real concessions. Reject auto-renewal defaults and negotiate price caps for next cycle into the current ELA. Start engagement 6+ months out.',
  "updatedAt" = NOW()
WHERE "name" = 'Microsoft' AND "accountId" = '11111111-1111-4111-8111-111111111111';

UPDATE "vendors" SET
  "notes" = 'FY ends Jan 31; quarter-ends (Apr 30, Jul 31, Oct 31, Jan 31) are peak negotiation windows. Standard renewal uplift 7-10% annually; target 0% on first renewal using HubSpot or Microsoft Dynamics as competitive pressure. Push for 3-year fixed-price terms. Reject "then-current list price" language -- it resets all negotiated discounts at renewal. 60-day opt-out window for auto-renewal; missing it locks another year. Add-on modules offered free during onboarding routinely convert to paid at renewal.',
  "updatedAt" = NOW()
WHERE "name" = 'Salesforce' AND "accountId" = '11111111-1111-4111-8111-111111111111';

UPDATE "vendors" SET
  "notes" = 'FY ends Jan 31; quarter-ends are quota pressure points. Negotiated discount range 10-20% off list. SentinelOne quotes drive 35-50% cost reduction threat -- get one before every renewal. Volume breakpoints at 500, 1,000, and 2,500 endpoints unlock better pricing. Multi-year prepay adds additional savings. Expanding endpoints or adding modules mid-term can trigger full repricing -- negotiate expansion pricing explicitly. Annual prepayment often required for discounted pricing.',
  "updatedAt" = NOW()
WHERE "name" = 'CrowdStrike' AND "accountId" = '11111111-1111-4111-8111-111111111111';

UPDATE "vendors" SET
  "notes" = 'EDP discount tiers: 5-8% at \-\ annual commit; 8-12% at \-\; 12-18% at \-\. Annual commits cannot decrease YoY under standard terms -- negotiate ratchet-down provisions upfront. FY ends Jan 31; Q4 (Nov-Jan) is most urgent. Overcommitment triggers shortfall penalties at full list rate on unmet delta. Marketplace spend offsets up to 25% of EDP commit (eligibility tightened May 2025). Azure and GCP competitive proposals plus RI/Savings Plans utilization data are the strongest levers.',
  "updatedAt" = NOW()
WHERE "name" = 'AWS' AND "accountId" = '11111111-1111-4111-8111-111111111111';

UPDATE "vendors" SET
  "notes" = 'FY ends Jun 30; Q3 (Jan-Mar) is the best negotiation window under Microsoft ownership. Bundled in M365 E5 licenses -- model whether consolidation makes sense. Copilot Business adds ~25% to per-seat cost; negotiate as a bundle. 30-day cancel notice on annual plans.',
  "updatedAt" = NOW()
WHERE "name" = 'GitHub' AND "accountId" = '11111111-1111-4111-8111-111111111111';

UPDATE "vendors" SET
  "notes" = 'FY ends Jan 31; Q4 (Nov-Jan) is peak discount window. Reps authorized to offer 10-15% incremental concessions plus free months for Q4 close. Slowing growth (3-7% YoY since 2023) makes reps flexible on churn prevention. Microsoft Teams overlap (bundled in M365 E3/E5) is a credible displacement threat. Zoom Phone pricing tiers reset upward at renewal if not locked. 30-day written notice required to non-renew.',
  "updatedAt" = NOW()
WHERE "name" = 'Zoom' AND "accountId" = '11111111-1111-4111-8111-111111111111';

UPDATE "vendors" SET
  "notes" = 'Acquired by Salesforce (2021) -- negotiate jointly with SF AE for combined discount. FY ends Jan 31; same quarter-end pressure as Salesforce. Salesforce bundling at contract review can add 10-20% vs. standalone; demand line-item pricing. Enterprise Grid pricing is seat-tiered; audit active users before renewal.',
  "updatedAt" = NOW()
WHERE "name" = 'Slack' AND "accountId" = '11111111-1111-4111-8111-111111111111';

UPDATE "vendors" SET
  "notes" = 'FY ends Jul 31; tier-based cloud pricing post-Server migration. Jira and Confluence can be co-termed on anniversary date for a unified negotiation. Premium tier adds advanced roadmaps and admin insights -- evaluate at renewal if product/engineering teams are scaling. Cloud migration incentive period has ended; negotiate on volume and multi-year terms. Standard 30-day cancel notice on annual plans.',
  "updatedAt" = NOW()
WHERE "name" = 'Atlassian' AND "accountId" = '11111111-1111-4111-8111-111111111111';

UPDATE "vendors" SET
  "notes" = 'Per-host plus per-feature pricing creates billing complexity; audit active hosts and disabled features before renewal. Commit tier pricing unlocks 20-35% savings vs. on-demand. Container and serverless pricing changes frequently -- lock rates in the MSA. Dynatrace and New Relic are credible competitive alternatives. Year-end (Dec) is best negotiation window.',
  "updatedAt" = NOW()
WHERE "name" = 'Datadog' AND "accountId" = '11111111-1111-4111-8111-111111111111';

UPDATE "vendors" SET
  "notes" = 'FY ends Jan 31; most leverage at initial Enterprise deal. Per-seat Business vs. Enterprise negotiated flat pricing. AI add-on often negotiated into Enterprise deals at discount. Audit active users before renewal -- Notion seat counts can creep. 30-day cancel notice; no strong multi-year discount incentive on small teams.',
  "updatedAt" = NOW()
WHERE "name" = 'Notion' AND "accountId" = '11111111-1111-4111-8111-111111111111';

UPDATE "vendors" SET
  "notes" = 'FY ends Dec 31; Q4 (Oct-Dec) best window. Enterprise plan pricing is negotiated; list price rarely applies at scale. Zero Trust bundle (ZTNA plus SWG plus CASB plus DLP) offers 30-40% vs. point products. DDoS, CDN, and Workers usage tracked separately -- negotiate unified commit with overage protection. 30-day notice for annual plan non-renewal.',
  "updatedAt" = NOW()
WHERE "name" = 'Cloudflare' AND "accountId" = '11111111-1111-4111-8111-111111111111';

UPDATE "vendors" SET
  "notes" = 'FY ends Jan 31; Nov-Jan window is highest-leverage. Average negotiated savings 14% off list; multi-year unlocks 15-30%. Audit inactive users before renewal -- typically reclaims 8-15% of seats. Microsoft Entra ID (included in M365 E3/E5) is a credible displacement threat driving 20-30% reductions. Customer Identity Cloud uses MAU-based pricing with overage billing -- negotiate MAU bands with rollover provisions. Cap annual escalation at 5% or CPI.',
  "updatedAt" = NOW()
WHERE "name" = 'Okta' AND "accountId" = '11111111-1111-4111-8111-111111111111';

-- â”€â”€ Upsert additional vendors into demo account â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

INSERT INTO "vendors" ("id", "accountId", "name", "cotermComplexity", "cotermNotes", "notes", "createdAt", "updatedAt")
VALUES (
  gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'IBM',
  'complex'::"CotermComplexity",
  'Multiple product lines (Watsonx, Cognos, S&S). ELA negotiation consolidates fragmented contracts. Watch for sub-capacity ILMT non-compliance triggering full-physical-capacity billing.',
  'FY ends Dec 31; Q4 (Oct-Dec) is peak quota pressure -- best window for concessions. Standard 10-20% off list; 25-40% on 3-5yr ELAs. IBM often drops initial discounts at renewal (the "price rollback trap") -- contractualize price holds at year 1 signing. S&S auto-renews by default with no opt-out reminder. LMS audit risk escalates when procurement challenges renewal terms aggressively -- IBM sales and audit teams are organizationally aligned. Engage SAM tooling and external IBM licensing counsel before any audit notice arrives.',
  NOW(), NOW()
)
ON CONFLICT ("accountId", name) DO UPDATE SET
  "notes" = EXCLUDED."notes", "updatedAt" = NOW();

INSERT INTO "vendors" ("id", "accountId", "name", "cotermComplexity", "cotermNotes", "notes", "createdAt", "updatedAt")
VALUES (
  gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'Oracle',
  'complex'::"CotermComplexity",
  'Database (UCE/NUP) and application licenses on separate schedules. 4% annual support escalator embedded contractually. 90+ day written notice required to cancel.',
  'FY ends May 31; Q4 (Mar-May) strongest window -- engage 6-12 months out, never wait for Oracle first offer. Standard 4% support increase embedded contractually; 2026 list price increases 12-18% on database and application licenses. LMS audit notices follow renewal pushback within 60-90 days. Third-party support (Rimini Street, Support Revolution) at 50% cost and documented migration to AWS RDS, Azure SQL, or PostgreSQL are the strongest leverage points. Auto-renewal defaults to invoice at increased price without new signature.',
  NOW(), NOW()
)
ON CONFLICT ("accountId", name) DO UPDATE SET
  "notes" = EXCLUDED."notes", "updatedAt" = NOW();

INSERT INTO "vendors" ("id", "accountId", "name", "cotermComplexity", "cotermNotes", "notes", "createdAt", "updatedAt")
VALUES (
  gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'VMware / Broadcom',
  'complex'::"CotermComplexity",
  'Post-Broadcom (Nov 2023): subscription-only, minimum 72 cores/product. All SKUs consolidated into VCF or VVF bundles. 20% late-renewal surcharge if anniversary date is missed.',
  'Post-Broadcom acquisition (Nov 2023): perpetual licensing eliminated, ~8,000 SKUs consolidated into VCF and VVF bundles. Price increases 150-1,500% vs. prior rates. Minimum 72 cores per product line enforced; 20% late-renewal surcharge if anniversary date is missed -- set calendar alerts 120 days out. Nutanix AHV migration promo (valid through Jul 2026) is the most credible displacement threat. Smaller customers have almost no reseller channel leverage post-acquisition.',
  NOW(), NOW()
)
ON CONFLICT ("accountId", name) DO UPDATE SET
  "notes" = EXCLUDED."notes", "updatedAt" = NOW();

INSERT INTO "vendors" ("id", "accountId", "name", "cotermComplexity", "cotermNotes", "notes", "createdAt", "updatedAt")
VALUES (
  gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'Arctic Wolf',
  'none'::"CotermComplexity",
  'Asset-based pricing; all services (MDR, Managed Risk, SAT) on same annual anniversary. 60-day non-renewal notice required -- double the industry standard.',
  'Asset-based pricing (\-25/endpoint/month); 1,000+ endpoint deployments negotiate \-14/endpoint/month. 60-day non-renewal notice window (vs. industry-standard 30 days) -- calendar alert is critical. Physical sensor hardware (\,250-\,000 per sensor) billed separately from subscription and often missed in TCO. Bundle MDR + Managed Risk + Security Awareness Training for 15-30% discount. CrowdStrike Falcon Complete and Huntress are credible competitive alternatives. Verify endpoint scope before renewal -- broad "protected assets" language can inflate billable count.',
  NOW(), NOW()
)
ON CONFLICT ("accountId", name) DO UPDATE SET
  "notes" = EXCLUDED."notes", "updatedAt" = NOW();

INSERT INTO "vendors" ("id", "accountId", "name", "cotermComplexity", "cotermNotes", "notes", "createdAt", "updatedAt")
VALUES (
  gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'Palo Alto Networks',
  'moderate'::"CotermComplexity",
  'NGFW, Prisma Cloud, and Cortex XDR on separate SKUs. Platformization bundle simplifies but deepens lock-in. 30-day cancellation window on annual subscriptions.',
  'FY ends Jul 31; June-July is the peak discount window. 3-year terms save ~32% vs. annual -- multi-year is the single strongest lever. Platformization push (NGFW + Prisma Cloud + Cortex XDR bundle) creates deep lock-in at renewal; model per-product cost before accepting bundle pricing. Enterprise buyers with competitive pressure (CrowdStrike, Fortinet, Check Point) can reach 35-50% off quote. Support contracts (Premium/Platinum) escalate 8-12% annually if uplift not capped -- negotiate support escalator limits in the MSA.',
  NOW(), NOW()
)
ON CONFLICT ("accountId", name) DO UPDATE SET
  "notes" = EXCLUDED."notes", "updatedAt" = NOW();

INSERT INTO "vendors" ("id", "accountId", "name", "cotermComplexity", "cotermNotes", "notes", "createdAt", "updatedAt")
VALUES (
  gen_random_uuid(), '11111111-1111-4111-8111-111111111111', 'Splunk',
  'moderate'::"CotermComplexity",
  'GB/day ingest-based pricing. 9% annual uplift is published policy. Cisco acquisition (Mar 2024) -- upsell to adjacent Cisco products expected at every renewal.',
  'Published 9% annual price increase on all licenses -- documented policy, not a negotiating tactic. Under Cisco ownership (acquired Mar 2024), upsell to Observability, ITSI, and adjacent Cisco products is baked into every renewal. FY aligns with Cisco Jul 31; Oct/Jan/Apr/Jul quarter-ends are best windows. Engage 90-120 days out with Microsoft Sentinel or Elastic Security alternatives to achieve 20-35% reduction vs. the 9% path. Lock in GB/day ingest rates now before Cisco transitions to outcome-based billing. GB/day overage charges can spike if log sources grow mid-term.',
  NOW(), NOW()
)
ON CONFLICT ("accountId", name) DO UPDATE SET
  "notes" = EXCLUDED."notes", "updatedAt" = NOW();