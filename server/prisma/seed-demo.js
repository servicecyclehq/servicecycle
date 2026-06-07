/**
 * LapseIQ Demo Enrichment Seed
 * Enriches existing contracts with savings/utilization/signature data and
 * adds scenario contracts: expired, archived, auto-renewal traps, multi-year EA.
 *
 * Run: node prisma/seed-demo.js
 * Safe to re-run (upserts throughout).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_ID   = '00000000-0000-0000-0000-000000000010';
const MGR_ID     = '8458c9fd-be2c-469f-912d-7db2f20826e7';
const MIKE_ID    = '0059ec63-345e-4765-bf33-bf5f1aeb8e12';

const V = {
  microsoft:  '00000000-0000-0000-0000-000000000020',
  salesforce: '00000000-0000-0000-0000-000000000021',
  crowdstrike:'00000000-0000-0000-0000-000000000022',
  ibm:        '00000000-0000-0000-0000-000000000040',
  oracle:     '00000000-0000-0000-0000-000000000041',
  vmware:     '00000000-0000-0000-0000-000000000042',
  arcticwolf: '00000000-0000-0000-0000-000000000043',
  okta:       '00000000-0000-0000-0000-000000000044',
  zoom:       '00000000-0000-0000-0000-000000000045',
  servicenow: '00000000-0000-0000-0000-000000000046',
  paloalto:   '00000000-0000-0000-0000-000000000047',
  aws:        '00000000-0000-0000-0000-000000000048',
  splunk:     '00000000-0000-0000-0000-000000000049',
};

const C = {
  m365:           '00000000-0000-0000-0000-000000000030',
  sfdc:           '00000000-0000-0000-0000-000000000031',
  crowdstrike:    '00000000-0000-0000-0000-000000000032',
  oracleDb:       '00000000-0000-0000-0000-000000000050',
  vmwareSphere:   '00000000-0000-0000-0000-000000000051',
  arcticMdr:      '00000000-0000-0000-0000-000000000052',
  servicenowItsm: '00000000-0000-0000-0000-000000000053',
  ibmWatsonx:     '00000000-0000-0000-0000-000000000054',
  okta:           '00000000-0000-0000-0000-000000000055',
  zoom:           '00000000-0000-0000-0000-000000000056',
  oracleNetsuite: '00000000-0000-0000-0000-000000000057',
  paloaltoPrisma: '00000000-0000-0000-0000-000000000058',
  awsEdp:         '00000000-0000-0000-0000-000000000059',
  splunk:         '00000000-0000-0000-0000-000000000060',
  ibmCognos:      '00000000-0000-0000-0000-000000000061',
  vmwareHorizon:  '00000000-0000-0000-0000-000000000062',
  arcticRisk:     '00000000-0000-0000-0000-000000000063',
  paloaltoGp:     '00000000-0000-0000-0000-000000000064',
  zoomPhone:      '00000000-0000-0000-0000-000000000065',
  servicenowHr:   '00000000-0000-0000-0000-000000000066',
};

function d(ymd)   { return new Date(ymd); }
function past(n)  { const dt = new Date(); dt.setDate(dt.getDate() - n); return dt; }
function future(n){ const dt = new Date(); dt.setDate(dt.getDate() + n); return dt; }
function fmtDate(dt) {
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

async function addContact(vendorId, data) {
  const where = data.email
    ? { vendorId, email: data.email }
    : { vendorId, name: data.name };
  const existing = await prisma.vendorContact.findFirst({ where });
  if (!existing) {
    await prisma.vendorContact.create({ data: { ...data, vendorId } });
    return true;
  }
  return false;
}

async function main() {
  console.log('🌱  LapseIQ demo enrichment seed\n');

  // ── 1. ENRICH EXISTING CONTRACTS ────────────────────────────────────────────
  console.log('📝  Enriching existing contracts…');

  const enrichments = [
    {
      id: C.m365,
      data: {
        contractNumber: 'MSFT-2024-E3-001',
        startDate: d('2024-06-01'),
        endDate: future(62),
        evaluationStartByDate: future(30),
        autoRenewal: true,
        autoRenewalNoticeDays: 60,
        cancelByDate: future(32),
        quantity: 250,
        costPerLicense: 36.00,
        seatsLicensed: 250,
        seatsActivelyInUse: 188,
        annualUpliftPercent: 5.00,
        originalAsk: 115200.00,
        finalNegotiatedPrice: 108000.00,
        signatureStatus: 'signed',
        signedAt: d('2024-05-28'),
        signerName: 'Dustin D.',
        department: 'IT',
        internalOwnerId: ADMIN_ID,
        negotiationLog: `- MSFT opened at $38.40/seat (list). Pushed back citing renewal volume.\n- Agreed to $36.00/seat after 2 rounds. No additional discounts.\n- Auto-renewal window is 60 days. Must act before the cancel-by date.`,
        notes: 'Auto-renewal active. 62 unused seats — evaluate downsizing to 190 at renewal.',
      },
    },
    {
      id: C.sfdc,
      data: {
        contractNumber: 'SFDC-2024-SC-044',
        startDate: d('2024-09-01'),
        endDate: future(45),
        evaluationStartByDate: future(15),
        quantity: 60,
        costPerLicense: 165.00,
        seatsLicensed: 60,
        seatsActivelyInUse: 52,
        annualUpliftPercent: 7.00,
        originalAsk: 142560.00,
        finalNegotiatedPrice: null,
        signatureStatus: 'pending',
        department: 'Sales',
        internalOwnerId: MGR_ID,
        status: 'under_review',
        negotiationLog: `- SFDC opened at $198/seat (+20% uplift demand).\n- Pushed back — 8 unused seats, flat headcount plan.\n- Counter-proposed $165/seat (flat renewal). SFDC has not yet responded.\n- Escalating to Enterprise team if no response within 7 days.`,
        notes: 'HIGH PRIORITY — renewal in 45 days, no agreement yet.',
      },
    },
    {
      id: C.crowdstrike,
      data: {
        contractNumber: 'CS-2025-FPE-789',
        startDate: d('2025-01-15'),
        endDate: future(258),
        quantity: 500,
        costPerLicense: 8.50,
        seatsLicensed: 500,
        seatsActivelyInUse: 493,
        annualUpliftPercent: 4.00,
        originalAsk: 54000.00,
        finalNegotiatedPrice: 51000.00,
        signatureStatus: 'signed',
        signedAt: d('2025-01-10'),
        signerName: 'Dustin D.',
        department: 'IT Security',
        internalOwnerId: ADMIN_ID,
        negotiationLog: `- Requested 3% price protection. CrowdStrike countered at 4% discount on list.\n- Accepted — strong utilization (493/500) removes seat reduction leverage.\n- Saved $3,000 vs. original ask.`,
      },
    },
    {
      id: C.oracleDb,
      data: {
        contractNumber: 'ORA-DB-2023-UCE-002',
        startDate: d('2020-01-01'),
        endDate: future(15),
        evaluationStartByDate: future(5),
        quantity: 4,
        costPerLicense: 47500.00,
        seatsLicensed: 4,
        seatsActivelyInUse: 3,
        annualUpliftPercent: 8.00,
        originalAsk: 220000.00,
        finalNegotiatedPrice: null,
        signatureStatus: 'pending',
        department: 'Engineering',
        internalOwnerId: MIKE_ID,
        status: 'under_review',
        negotiationLog: `- Oracle opened at $55,000/processor core (+16% uplift).\n- Confirmed 4 cores needed. 1 underutilized — no reduction leverage with Oracle.\n- Proposed OCI migration — Oracle declined parity pricing.\n- Engaging Palisade Compliance for negotiation support.\n- CRITICAL: 15 days to renewal. Escalate immediately.`,
        notes: 'CRITICAL — 15 days to renewal. Oracle support is unresponsive. Consider Postgres migration before next cycle.',
      },
    },
    {
      id: C.servicenowItsm,
      data: {
        contractNumber: 'SNW-2025-ITSM-PRO',
        startDate: d('2025-03-01'),
        endDate: future(668),
        quantity: 120,
        costPerLicense: 110.00,
        seatsLicensed: 120,
        seatsActivelyInUse: 117,
        annualUpliftPercent: 5.00,
        originalAsk: 165600.00,
        finalNegotiatedPrice: 158400.00,
        signatureStatus: 'signed',
        signedAt: d('2025-02-20'),
        signerName: 'Dustin D.',
        department: 'IT',
        internalOwnerId: ADMIN_ID,
        negotiationLog: `- SNOW at $138/seat list. Negotiated $110/seat on 2-year commit.\n- Added free implementation hours ($12k value) in lieu of further price cut.\n- Saved $7,200 vs. original ask.`,
      },
    },
    {
      id: C.okta,
      data: {
        contractNumber: 'OKTA-2024-WIC-330',
        startDate: d('2024-11-01'),
        endDate: future(184),
        autoRenewal: true,
        autoRenewalNoticeDays: 45,
        cancelByDate: future(139),
        quantity: 300,
        costPerLicense: 15.00,
        seatsLicensed: 300,
        seatsActivelyInUse: 264,
        annualUpliftPercent: 6.00,
        originalAsk: 58500.00,
        finalNegotiatedPrice: 54000.00,
        signatureStatus: 'signed',
        signedAt: d('2024-10-25'),
        signerName: 'Dustin D.',
        department: 'IT',
        internalOwnerId: ADMIN_ID,
        negotiationLog: `- Okta proposed $19.50/seat at renewal. Cited flat headcount — pushed to $15.00.\n- 36 seats unused. Recommend reducing to 270 at next renewal (~$3,240/yr savings).`,
      },
    },
    {
      id: C.zoom,
      data: {
        contractNumber: 'ZM-2024-BIZ-PLUS',
        startDate: d('2024-08-01'),
        endDate: future(92),
        autoRenewal: true,
        autoRenewalNoticeDays: 30,
        cancelByDate: future(62),
        quantity: 200,
        costPerLicense: 20.00,
        seatsLicensed: 200,
        seatsActivelyInUse: 130,
        annualUpliftPercent: 3.00,
        originalAsk: 52800.00,
        finalNegotiatedPrice: 48000.00,
        signatureStatus: 'signed',
        signedAt: d('2024-07-29'),
        signerName: 'Dustin D.',
        department: 'Operations',
        internalOwnerId: MGR_ID,
        notes: '70 unused seats post-RTO. Must right-size to ~140 seats. Notify Zoom by cancel-by date.',
        negotiationLog: `- 70 seats unused since RTO policy change.\n- Target: reduce to 140 seats at $18.50/seat = ~$31k/yr (vs. $48k current).\n- Must notify Zoom before cancel-by date to avoid lock-in.`,
      },
    },
    {
      id: C.splunk,
      data: {
        contractNumber: 'SPLK-2022-ES-001',
        startDate: d('2022-10-01'),
        endDate: future(35),
        evaluationStartByDate: future(10),
        quantity: 1,
        costPerLicense: 95000.00,
        seatsLicensed: 1,
        seatsActivelyInUse: 1,
        annualUpliftPercent: 10.00,
        originalAsk: 119000.00,
        finalNegotiatedPrice: null,
        signatureStatus: 'pending',
        department: 'IT Security',
        internalOwnerId: MIKE_ID,
        status: 'under_review',
        negotiationLog: `- Cisco/Splunk opened at $119,000 (+25% uplift from prior year).\n- Running parallel POC with Microsoft Sentinel (included in M365 E5 — $0 incremental).\n- If Sentinel POC passes, will not renew Splunk.\n- Cisco rep escalated to VP Sales, offered 15% discount. Hold firm pending POC result.`,
        notes: 'Potential non-renewal pending Sentinel POC. Do not commit until POC complete.',
      },
    },
    {
      id: C.ibmWatsonx,
      data: {
        contractNumber: 'IBM-WX-2025-AI-07',
        startDate: d('2025-02-01'),
        endDate: future(275),
        quantity: 10,
        costPerLicense: 3200.00,
        seatsLicensed: 10,
        seatsActivelyInUse: 8,
        annualUpliftPercent: 5.00,
        originalAsk: 384000.00,
        finalNegotiatedPrice: 320000.00,
        signatureStatus: 'signed',
        signedAt: d('2025-01-27'),
        signerName: 'Dustin D.',
        department: 'Engineering',
        internalOwnerId: ADMIN_ID,
        negotiationLog: `- IBM opened at $38,400/unit. Negotiated to $32,000 citing Azure OpenAI competitive pressure.\n- 2 units unallocated — teams still onboarding. Evaluate at 6-month mark.`,
      },
    },
    {
      id: C.paloaltoPrisma,
      data: {
        contractNumber: 'PANW-PC-2025-0044',
        startDate: d('2025-04-01'),
        endDate: future(335),
        quantity: 1000,
        costPerLicense: 12.00,
        seatsLicensed: 1000,
        seatsActivelyInUse: 920,
        annualUpliftPercent: 6.00,
        originalAsk: 156000.00,
        finalNegotiatedPrice: 144000.00,
        signatureStatus: 'signed',
        signedAt: d('2025-03-25'),
        signerName: 'Dustin D.',
        department: 'Engineering',
        internalOwnerId: ADMIN_ID,
        negotiationLog: `- PANW list at $15.60/workload. Negotiated $12.00 (23% off) on 1,000-unit volume.\n- 80 workloads unused — dev env cleanup in progress. True-up at renewal.`,
      },
    },
    {
      id: C.arcticMdr,
      data: {
        contractNumber: 'AW-MDR-2024-ACC-077',
        startDate: d('2024-07-01'),
        endDate: future(427),
        quantity: 1,
        costPerLicense: 120000.00,
        seatsLicensed: 1,
        seatsActivelyInUse: 1,
        annualUpliftPercent: 5.00,
        originalAsk: 135000.00,
        finalNegotiatedPrice: 120000.00,
        signatureStatus: 'signed',
        signedAt: d('2024-06-20'),
        signerName: 'Dustin D.',
        department: 'IT Security',
        internalOwnerId: ADMIN_ID,
        negotiationLog: `- Arctic Wolf opened at $135k for MDR platform. Negotiated to $120k on 2-year commit.\n- Includes 24/7 SOC coverage, threat hunting, and quarterly business reviews.`,
      },
    },
    {
      id: C.awsEdp,
      data: {
        contractNumber: 'AWS-EDP-2024-ACE-0091',
        startDate: d('2024-03-01'),
        endDate: future(304),
        quantity: 1,
        costPerLicense: 600000.00,
        seatsLicensed: 1,
        seatsActivelyInUse: 1,
        annualUpliftPercent: 0,
        originalAsk: 720000.00,
        finalNegotiatedPrice: 600000.00,
        signatureStatus: 'signed',
        signedAt: d('2024-02-22'),
        signerName: 'Dustin D.',
        department: 'Engineering',
        internalOwnerId: ADMIN_ID,
        negotiationLog: `- Committed $600k/yr EDP to lock in 17% compute + data transfer discount.\n- Prior year non-committed spend was tracking $720k. Saving $120k/yr.\n- Includes reserved instance pricing on top of EDP discount.`,
        notes: '3-year EDP. Annual committed spend. Review utilization quarterly.',
      },
    },
    {
      id: C.vmwareSphere,
      data: {
        contractNumber: 'VMWARE-VS-2023-ENT-441',
        startDate: d('2023-11-01'),
        endDate: future(184),
        quantity: 48,
        costPerLicense: 2000.00,
        seatsLicensed: 48,
        seatsActivelyInUse: 38,
        annualUpliftPercent: 15.00,
        originalAsk: 132480.00,
        finalNegotiatedPrice: null,
        signatureStatus: 'pending',
        department: 'Infrastructure',
        internalOwnerId: MIKE_ID,
        notes: 'Broadcom pricing up ~15-25% at renewal. Evaluate Nutanix or other HCI. 10 unused licenses.',
        negotiationLog: `- Broadcom opened at $2,760/core (+38% from prior VMware pricing).\n- Unacceptable. Evaluating Nutanix Cloud Infrastructure as replacement.\n- Legal review: perpetual licenses may not require renewal — consulting outside counsel.\n- 10 unused cores are a consolidation opportunity before any renewal decision.`,
      },
    },
    {
      id: C.oracleNetsuite,
      data: {
        contractNumber: 'NS-2024-ERP-0188',
        startDate: d('2024-01-01'),
        endDate: future(245),
        quantity: 20,
        costPerLicense: 4500.00,
        seatsLicensed: 20,
        seatsActivelyInUse: 18,
        annualUpliftPercent: 7.00,
        originalAsk: 108000.00,
        finalNegotiatedPrice: 90000.00,
        signatureStatus: 'signed',
        signedAt: d('2023-12-15'),
        signerName: 'Dustin D.',
        department: 'Finance',
        internalOwnerId: MGR_ID,
        negotiationLog: `- NetSuite opened at $5,400/user. Negotiated to $4,500 citing Sage Intacct competitor quote.\n- Saved $18,000 vs. original ask. 2 licenses unused — headcount below plan.`,
      },
    },
    {
      id: C.ibmCognos,
      data: {
        contractNumber: 'IBM-COG-2024-AN-030',
        startDate: d('2024-04-01'),
        endDate: future(335),
        quantity: 15,
        costPerLicense: 1800.00,
        seatsLicensed: 15,
        seatsActivelyInUse: 10,
        annualUpliftPercent: 6.00,
        originalAsk: 40500.00,
        finalNegotiatedPrice: 27000.00,
        signatureStatus: 'signed',
        signedAt: d('2024-03-20'),
        signerName: 'Dustin D.',
        department: 'Finance',
        internalOwnerId: MGR_ID,
        negotiationLog: `- IBM opened at $2,700/seat. Used 5 unused seats as leverage.\n- Negotiated to $1,800/seat. Saved $13,500 vs. ask.\n- Should reduce to 10 seats at next renewal.`,
      },
    },
  ];

  let enriched = 0;
  for (const { id, data } of enrichments) {
    try {
      await prisma.contract.update({ where: { id }, data });
      enriched++;
    } catch (e) {
      console.warn(`  ⚠  Could not enrich ${id}: ${e.message}`);
    }
  }
  console.log(`✓  Enriched ${enriched} existing contracts\n`);

  // ── 2. NEW SCENARIO CONTRACTS ────────────────────────────────────────────────
  console.log('🆕  Adding scenario contracts…');

  // 2a. Archived — Cisco Webex replaced by Zoom
  const ciscoVendor = await prisma.vendor.upsert({
    where: { id: 'seed-vendor-cisco-001' },
    create: { id: 'seed-vendor-cisco-001', accountId: ACCOUNT_ID, name: 'Cisco', supportEmail: 'enterprisesupport@cisco.com', supportPhone: '1-800-553-2447', supportPortalUrl: 'https://mycase.cloudapps.cisco.com' },
    update: {},
  });
  await prisma.contract.upsert({
    where: { id: 'seed-webex-archived-001' },
    create: {
      id: 'seed-webex-archived-001', accountId: ACCOUNT_ID, vendorId: ciscoVendor.id,
      product: 'Cisco Webex Enterprise', contractNumber: 'CSCO-WX-2021-ENT-0088',
      status: 'cancelled', quantity: 200, costPerLicense: 17.50,
      startDate: d('2021-03-01'), endDate: d('2023-02-28'), autoRenewal: false,
      originalAsk: 42000.00, finalNegotiatedPrice: 42000.00,
      signatureStatus: 'signed', signedAt: d('2021-02-22'), signerName: 'Dustin D.',
      department: 'Operations',
      archivedAt: past(90), archivedById: ADMIN_ID,
      notes: 'Replaced by Zoom Business+ in 2023. Archived for historical cost reference.',
    },
    update: {},
  });
  console.log('  ✓  Archived Cisco Webex (replaced by Zoom)');

  // 2a-bis. Three more archived contracts so the Archive view has variety
  // and a "see what got archived" tour story. Each maps to an existing
  // vendor + a believable migration / consolidation reason. (added 2026-05-08)

  // Slack Pro -> consolidated into Microsoft Teams (Microsoft vendor reused)
  await prisma.contract.upsert({
    where: { id: 'seed-slack-archived-001' },
    create: {
      id: 'seed-slack-archived-001', accountId: ACCOUNT_ID, vendorId: V.microsoft,
      product: 'Slack Pro (consolidated)', contractNumber: 'SLACK-2022-PRO-0319',
      status: 'cancelled', quantity: 220, costPerLicense: 8.75,
      startDate: d('2022-03-15'), endDate: d('2024-03-14'), autoRenewal: false,
      seatsLicensed: 220, seatsActivelyInUse: 184,
      originalAsk: 23100.00, finalNegotiatedPrice: 23100.00,
      signatureStatus: 'signed', signedAt: d('2022-03-01'), signerName: 'Dustin D.',
      department: 'Engineering',
      archivedAt: past(60), archivedById: ADMIN_ID,
      notes: 'Consolidated into Microsoft Teams (E5 already includes Teams Premium). Net savings ~$23k/yr. Archived for historical reference and headcount-vs-spend reporting.',
    },
    update: {},
  });
  console.log('  ✓  Archived Slack Pro (consolidated into Microsoft Teams)');

  // Old Zoom Pro -> upgraded to current Zoom Business+ contract (V.zoom reused)
  await prisma.contract.upsert({
    where: { id: 'seed-zoom-pro-archived-001' },
    create: {
      id: 'seed-zoom-pro-archived-001', accountId: ACCOUNT_ID, vendorId: V.zoom,
      product: 'Zoom Pro (predecessor)', contractNumber: 'ZOOM-2023-PRO-0117',
      status: 'cancelled', quantity: 75, costPerLicense: 14.99,
      startDate: d('2023-04-01'), endDate: d('2024-03-31'), autoRenewal: false,
      seatsLicensed: 75, seatsActivelyInUse: 73,
      originalAsk: 13500.00, finalNegotiatedPrice: 13491.00,
      signatureStatus: 'signed', signedAt: d('2023-03-22'), signerName: 'Dustin D.',
      department: 'Operations',
      archivedAt: past(45), archivedById: MGR_ID,
      notes: 'Upgraded to Zoom Business+ for whiteboarding and breakout-room features. Predecessor archived so the renewal chain stays linked for cost-trend reporting.',
    },
    update: {},
  });
  console.log('  ✓  Archived Zoom Pro (upgraded to Business+)');

  // Old AWS Reserved Instance commitment -> migrated to AWS EDP (V.aws reused)
  await prisma.contract.upsert({
    where: { id: 'seed-aws-ri-archived-001' },
    create: {
      id: 'seed-aws-ri-archived-001', accountId: ACCOUNT_ID, vendorId: V.aws,
      product: 'AWS Reserved Instances (3yr no-upfront)', contractNumber: 'AWS-2021-RI3Y-0042',
      status: 'expired', quantity: 1, costPerLicense: 0,
      startDate: d('2021-09-01'), endDate: d('2024-08-31'), autoRenewal: false,
      originalAsk: 142000.00, finalNegotiatedPrice: 138400.00,
      signatureStatus: 'signed', signedAt: d('2021-08-19'), signerName: 'Dustin D.',
      department: 'Engineering',
      archivedAt: past(180), archivedById: ADMIN_ID,
      notes: 'Rolled into the new EDP commitment in Sep 2024 — better discount tier and includes Savings Plans flexibility. Kept archived for FinOps cost-comparison reporting.',
    },
    update: {},
  });
  console.log('  ✓  Archived AWS Reserved Instances (rolled into EDP)');

  // 2b. Expired predecessor — Salesforce Starter
  await prisma.contract.upsert({
    where: { id: 'seed-sfdc-starter-exp-001' },
    create: {
      id: 'seed-sfdc-starter-exp-001', accountId: ACCOUNT_ID, vendorId: V.salesforce,
      product: 'Salesforce Starter (Predecessor)', contractNumber: 'SFDC-2022-STR-011',
      status: 'expired', quantity: 20, costPerLicense: 75.00,
      startDate: d('2022-09-01'), endDate: d('2023-08-31'), autoRenewal: false,
      seatsLicensed: 20, seatsActivelyInUse: 20,
      originalAsk: 21600.00, finalNegotiatedPrice: 18000.00,
      signatureStatus: 'signed', signedAt: d('2022-08-15'), signerName: 'Dustin D.',
      parentContractId: C.sfdc,
      notes: 'Prior Salesforce contract — upgraded to Sales Cloud Enterprise Sep 2023.',
    },
    update: {},
  });
  console.log('  ✓  Expired Salesforce Starter (predecessor, renewal chain to Sales Cloud)');

  // 2c. Auto-renewal trap — DocuSign, notice window ALREADY PASSED
  const docusignVendor = await prisma.vendor.upsert({
    where: { id: 'seed-vendor-docusign-001' },
    create: { id: 'seed-vendor-docusign-001', accountId: ACCOUNT_ID, name: 'DocuSign', supportEmail: 'enterprise.support@docusign.com', supportPhone: '1-877-720-2040', supportPortalUrl: 'https://support.docusign.com' },
    update: {},
  });
  await prisma.contract.upsert({
    where: { id: 'seed-docusign-trap-001' },
    create: {
      id: 'seed-docusign-trap-001', accountId: ACCOUNT_ID, vendorId: docusignVendor.id,
      product: 'DocuSign Business Pro', contractNumber: 'DSIGN-2024-BP-0441',
      status: 'active', quantity: 25, costPerLicense: 45.00,
      startDate: d('2024-05-01'), endDate: future(21), evaluationStartByDate: future(5),
      autoRenewal: true, autoRenewalNoticeDays: 30, cancelByDate: past(9),
      seatsLicensed: 25, seatsActivelyInUse: 18, annualUpliftPercent: 4.00,
      originalAsk: 15600.00, finalNegotiatedPrice: null,
      signatureStatus: 'pending',
      department: 'Legal', internalOwnerId: MGR_ID,
      notes: 'AUTO-RENEWAL NOTICE WINDOW CLOSED 9 DAYS AGO. Will auto-renew unless DocuSign grants exception. 7 unused seats.',
      negotiationLog: `- Notice window closed. DocuSign will auto-renew at current rate.\n- Reached out to rep requesting exception — awaiting callback (4 days, no response).\n- Escalate to account executive immediately.\n- Target if exception granted: reduce to 20 seats at $43/seat.`,
    },
    update: {},
  });
  console.log('  ✓  DocuSign auto-renewal trap (notice window already passed)');

  // 2d. 3-year Azure EA with installment payment schedule
  await prisma.contract.upsert({
    where: { id: 'seed-azure-3yr-ea-001' },
    create: {
      id: 'seed-azure-3yr-ea-001', accountId: ACCOUNT_ID, vendorId: V.microsoft,
      product: 'Microsoft Azure Enterprise Agreement (3-Year)', contractNumber: 'MSFT-AZ-EA-2023-3YR',
      status: 'active', quantity: 1, costPerLicense: 1260000.00,
      startDate: d('2023-07-01'), endDate: d('2026-06-30'), evaluationStartByDate: future(425),
      autoRenewal: false,
      seatsLicensed: 1, seatsActivelyInUse: 1, annualUpliftPercent: 0,
      originalAsk: 1440000.00, finalNegotiatedPrice: 1260000.00,
      signatureStatus: 'signed', signedAt: d('2023-06-22'), signerName: 'Dustin D.',
      department: 'IT', internalOwnerId: ADMIN_ID,
      negotiationLog: `- 3-year EA. MSFT list $480k/yr ($1.44M TCV). Negotiated $420k/yr + 3-year price lock ($1.26M TCV).\n- Includes Azure Hybrid Benefit + Dev/Test pricing.\n- Saved $180,000 over 3-year term vs. PAYG list.\n- Billed annually: $420k due each July 1.\n- Begin renewal discussion Dec 2025 for Jul 2026 expiry.`,
      notes: '3-year EA. Annual installments. Up for renewal Jul 2026.',
    },
    update: {},
  });
  const existingSchedule = await prisma.paymentSchedule.findUnique({ where: { contractId: 'seed-azure-3yr-ea-001' } });
  if (!existingSchedule) {
    await prisma.paymentSchedule.create({
      data: {
        contractId: 'seed-azure-3yr-ea-001',
        scheduleType: 'installment',
        notes: 'Annual installment — invoiced each July 1',
        installments: { create: [
          { yearNumber: 1, amount: 420000.00, dueDate: d('2023-07-01'), notes: 'Year 1 — paid' },
          { yearNumber: 2, amount: 420000.00, dueDate: d('2024-07-01'), notes: 'Year 2 — paid' },
          { yearNumber: 3, amount: 420000.00, dueDate: d('2025-07-01'), notes: 'Year 3 — due Jul 2025' },
        ]},
      },
    });
  }
  console.log('  ✓  3-year Azure EA with installment payment schedule');

  // 2e. GitHub Enterprise — good utilization, dev-focused
  const githubVendor = await prisma.vendor.upsert({
    where: { id: 'seed-vendor-github-001' },
    create: { id: 'seed-vendor-github-001', accountId: ACCOUNT_ID, name: 'GitHub (Microsoft)', supportEmail: 'enterprise@github.com', supportPortalUrl: 'https://support.github.com/contact' },
    update: {},
  });
  await prisma.contract.upsert({
    where: { id: 'seed-github-ent-001' },
    create: {
      id: 'seed-github-ent-001', accountId: ACCOUNT_ID, vendorId: githubVendor.id,
      product: 'GitHub Enterprise Cloud', contractNumber: 'GH-ENT-2025-0072',
      status: 'active', quantity: 80, costPerLicense: 21.00,
      startDate: d('2025-01-01'), endDate: future(245), autoRenewal: false,
      seatsLicensed: 80, seatsActivelyInUse: 74, annualUpliftPercent: 4.00,
      originalAsk: 24192.00, finalNegotiatedPrice: 20160.00,
      signatureStatus: 'signed', signedAt: d('2024-12-18'), signerName: 'Dustin D.',
      department: 'Engineering', internalOwnerId: MIKE_ID,
      negotiationLog: `- GitHub opened at $25.20/seat. Negotiated $21.00 on 80-seat volume + MSFT EA leverage.\n- 6 unused seats from contractor offboarding. Reduce to 75 at next renewal.`,
    },
    update: {},
  });
  console.log('  ✓  GitHub Enterprise Cloud');

  // 2f. Expired legacy Zoom Phone
  await prisma.contract.upsert({
    where: { id: 'seed-zoomphone-exp-001' },
    create: {
      id: 'seed-zoomphone-exp-001', accountId: ACCOUNT_ID, vendorId: V.zoom,
      product: 'Zoom Phone (Legacy — Expired)', contractNumber: 'ZM-2022-PHONE-EXP',
      status: 'expired', quantity: 50, costPerLicense: 15.00,
      startDate: d('2022-08-01'), endDate: past(180), autoRenewal: false,
      seatsLicensed: 50, seatsActivelyInUse: 50,
      originalAsk: 9000.00, finalNegotiatedPrice: 9000.00,
      signatureStatus: 'signed', signedAt: d('2022-07-28'), signerName: 'Dustin D.',
      department: 'Operations',
      notes: 'Lapsed. Users migrated to Zoom Business+ bundle. Kept for cost history.',
    },
    update: {},
  });
  console.log('  ✓  Expired Zoom Phone legacy\n');

  // ── 3. VENDOR CONTACTS ───────────────────────────────────────────────────────
  console.log('👥  Seeding vendor contacts…');

  const contacts = [
    { vendorId: V.salesforce, name: 'Amanda Chen', title: 'Enterprise Account Executive', email: 'a.chen@salesforce.com', phone: '+1 (415) 901-7823', notes: 'Primary renewal contact. Best reached Tue–Thu. Aggressive on uplift clauses.', lastContactedAt: past(30) },
    { vendorId: V.salesforce, name: 'Marcus Webb', title: 'Customer Success Manager', email: 'm.webb@salesforce.com', phone: '+1 (415) 901-3341', notes: 'Handles QBRs and adoption reviews. Escalation path above AE.', lastContactedAt: past(60) },
    { vendorId: V.microsoft, name: 'Sandra Kowalski', title: 'Account Technology Strategist', email: 's.kowalski@microsoft.com', phone: '+1 (425) 882-9104', notes: 'ATS for M365 + Azure. Covers licensing and EA renewals.', lastContactedAt: past(14) },
    { vendorId: V.microsoft, name: 'Tom Hensley', title: 'Azure Specialist', email: 't.hensley@microsoft.com', notes: 'Azure EDP and Reserved Instance specialist.', lastContactedAt: past(90) },
    { vendorId: V.okta, name: 'Derek Park', title: 'Sr. Account Executive', email: 'd.park@okta.com', phone: '+1 (669) 234-5512', notes: 'Primary contact. Aggressive on uplift — hold firm at renewal.', lastContactedAt: past(45) },
    { vendorId: V.zoom, name: 'Tanya Ruiz', title: 'Account Manager', email: 't.ruiz@zoom.us', phone: '+1 (888) 799-9666 x4421', notes: 'Contact re: right-sizing at renewal. Aware of 70 unused seats.', lastContactedAt: past(20) },
    { vendorId: V.splunk, name: 'James Thornton', title: 'VP Enterprise Sales, Cisco Security', email: 'j.thornton@cisco.com', phone: '+1 (408) 527-3311', notes: 'Escalated when we signaled non-renewal. Offered 15% discount — hold pending Sentinel POC.', lastContactedAt: past(7) },
    { vendorId: V.crowdstrike, name: 'Nina Rodriguez', title: 'Account Executive', email: 'n.rodriguez@crowdstrike.com', phone: '+1 (669) 999-7777', notes: 'Good partner relationship. Proactive on renewal timing.', lastContactedAt: past(100) },
    { vendorId: V.oracle, name: 'Richard Holt', title: 'License Management Services', email: 'r.holt@oracle.com', phone: '+1 (650) 506-7000', notes: 'LMS contact. Unresponsive to negotiation — use Palisade Compliance as intermediary.', lastContactedAt: past(21) },
    { vendorId: V.servicenow, name: 'Cassie Huang', title: 'Enterprise Account Manager', email: 'c.huang@servicenow.com', phone: '+1 (408) 501-8550', notes: 'Manages ITSM + HRSD renewal. Will push CSM module upsell.', lastContactedAt: past(50) },
    { vendorId: V.aws, name: 'Kenji Yamamoto', title: 'AWS Enterprise Account Manager', email: 'k.yamamoto@amazon.com', phone: '+1 (206) 266-1000', notes: 'EDP renewal contact. Proactive on committed spend optimization.', lastContactedAt: past(30) },
    { vendorId: docusignVendor.id, name: 'Lauren Frost', title: 'Commercial Account Executive', email: 'l.frost@docusign.com', phone: '+1 (206) 219-0200', notes: 'Called re: auto-renewal exception. No response in 4 days — ESCALATE NOW.', lastContactedAt: past(4) },
    { vendorId: githubVendor.id, name: 'Priya Nair', title: 'GitHub Enterprise Account Executive', email: 'p.nair@github.com', notes: 'Best reached by email. Coordinate with Sandra Kowalski (MSFT) for bundling.', lastContactedAt: past(60) },
    { vendorId: ciscoVendor.id, name: 'Frank DiMaggio', title: 'Enterprise Account Executive', email: 'f.dimaggio@cisco.com', phone: '+1 (408) 526-4000', notes: 'Cisco contact if Webex ever resurfaces. Not an active relationship.', lastContactedAt: past(365) },
    { vendorId: V.vmware, name: 'Brian Sutton', title: 'Broadcom Licensing Specialist', email: 'b.sutton@broadcom.com', phone: '+1 (408) 433-8000', notes: 'Post-acquisition Broadcom rep. Very transactional — no negotiation flexibility observed.', lastContactedAt: past(30) },
  ];

  let added = 0;
  for (const c of contacts) {
    if (await addContact(c.vendorId, c)) added++;
  }
  console.log(`✓  Added ${added} new vendor contacts\n`);

  // ── 4. SUMMARY ────────────────────────────────────────────────────────────────
  const [total, archived, vendors, contactCount] = await Promise.all([
    prisma.contract.count({ where: { accountId: ACCOUNT_ID } }),
    prisma.contract.count({ where: { accountId: ACCOUNT_ID, NOT: { archivedAt: null } } }),
    prisma.vendor.count({ where: { accountId: ACCOUNT_ID } }),
    prisma.vendorContact.count(),
  ]);

  console.log('✅  Seed complete!');
  console.log(`   Contracts: ${total}  (${archived} archived)`);
  console.log(`   Vendors:   ${vendors}`);
  console.log(`   Contacts:  ${contactCount}`);
  console.log('');
  console.log('📋  Scenarios ready to test:');
  console.log('   🔴 Critical renewals   — Oracle DB (15d), DocuSign (21d), Splunk (35d)');
  console.log('   🟡 Mid-negotiation     — Salesforce Sales Cloud, VMware vSphere, Splunk');
  console.log('   ⚠️  Auto-renewal traps  — M365, Zoom, Okta, DocuSign (window CLOSED)');
  console.log('   📉 Over-licensed       — Zoom (70 unused), Okta (36), M365 (62), IBM Cognos (5)');
  console.log('   💰 Savings achieved    — IBM watsonx ($64k), AWS EDP ($120k), PANW ($12k)');
  console.log('   📅 Multi-year EA       — Azure 3-yr with installment payment schedule');
  console.log('   📁 Archived            — Cisco Webex (replaced by Zoom)');
  console.log('   ⌛ Expired             — Zoom Phone legacy, Salesforce Starter (predecessor)');
  console.log('   🔗 Renewal chain       — SFDC Starter → SFDC Sales Cloud Enterprise');
  console.log('   👥 Vendor contacts     — 15 contacts across 9 vendors');
}

main()
  .catch(e => { console.error('Seed failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
