require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function main() {
  console.log('🌱 Seeding LapseIQ database...\n');

  // ── Account ────────────────────────────────────────────────────────────────
  const account = await prisma.account.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: { companyName: 'Acme Corporation' },
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      companyName: 'Acme Corporation',
      status: 'active',
      planType: 'saas',
      planTier: 'mid',
    },
  });
  console.log(`✓ Account: ${account.companyName}`);

  // ── Admin User ─────────────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash('Admin1234!', 12);
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@acme.com' },
    update: { passwordHash, accountId: account.id, name: 'Admin User', role: 'admin' },
    create: {
      id: '00000000-0000-0000-0000-000000000010',
      accountId: account.id,
      name: 'Admin User',
      email: 'admin@acme.com',
      passwordHash,
      role: 'admin',
    },
  });
  console.log(`✓ Admin user: ${adminUser.email}`);

  // ── Vendors ────────────────────────────────────────────────────────────────
  const microsoft = await prisma.vendor.upsert({
    where: { id: '00000000-0000-0000-0000-000000000020' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000020',
      accountId: account.id,
      name: 'Microsoft',
      cotermComplexity: 'complex',
      cotermNotes: 'Multiple product lines with different anniversary dates. Annual true-up required for EA. Azure and M365 co-term separately.',
    },
  });

  const salesforce = await prisma.vendor.upsert({
    where: { id: '00000000-0000-0000-0000-000000000021' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000021',
      accountId: account.id,
      name: 'Salesforce',
      cotermComplexity: 'moderate',
      cotermNotes: 'Q1 renewal cycle (Jan 31). 7% YoY price escalation clause on all products. 30-day cancel notice. Slack acquired — now on same AE.',
    },
  });

  const crowdstrike = await prisma.vendor.upsert({
    where: { id: '00000000-0000-0000-0000-000000000022' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000022',
      accountId: account.id,
      name: 'CrowdStrike',
      cotermComplexity: 'none',
      notes: 'Annual renewal by endpoint count. Negotiate multi-year for 15–20% discount.',
    },
  });

  const okta = await prisma.vendor.upsert({
    where: { id: '00000000-0000-0000-0000-000000000023' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000023',
      accountId: account.id,
      name: 'Okta',
      cotermComplexity: 'moderate',
      cotermNotes: 'Workforce Identity and Customer Identity priced separately. Potential to bundle for discount.',
    },
  });

  const atlassian = await prisma.vendor.upsert({
    where: { id: '00000000-0000-0000-0000-000000000024' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000024',
      accountId: account.id,
      name: 'Atlassian',
      cotermComplexity: 'moderate',
      cotermNotes: 'Cloud migration incentive expired. Jira and Confluence can be co-termed on anniversary date.',
    },
  });

  const zoom = await prisma.vendor.upsert({
    where: { id: '00000000-0000-0000-0000-000000000025' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000025',
      accountId: account.id,
      name: 'Zoom',
      cotermComplexity: 'none',
      notes: 'Month-to-month risk post-expiry. Microsoft Teams overlap — evaluate consolidation.',
    },
  });

  const servicenow = await prisma.vendor.upsert({
    where: { id: '00000000-0000-0000-0000-000000000026' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000026',
      accountId: account.id,
      name: 'ServiceNow',
      cotermComplexity: 'complex',
      cotermNotes: 'ITSM and HRSD modules on separate SKUs. True-up model with ACV commit. Minimum 90-day notice to avoid auto-escalation.',
    },
  });

  console.log(`✓ Vendors: ${[microsoft, salesforce, crowdstrike, okta, atlassian, zoom, servicenow].map(v => v.name).join(', ')}`);

  // ── Contracts ──────────────────────────────────────────────────────────────
  const now = new Date();

  // 1. Microsoft 365 E3 — $126,000/yr — active, IN review window (60 days to expiry)
  // Cancel window passed — auto-renews in 30 days. URGENT.
  const m365End   = addDays(now, 62);
  const m365Cancel = addDays(m365End, -30);  // cancel by was 32 days ago — missed
  await prisma.contract.upsert({
    where: { id: '00000000-0000-0000-0000-000000000030' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000030',
      accountId: account.id,
      vendorId: microsoft.id,
      contractNumber: 'MS-EA-2024-00847',
      customerNumber: 'ACME-MS-001',
      product: 'Microsoft 365 E3',
      quantity: 350,
      costPerLicense: 360.00,
      startDate: addDays(now, -303),
      endDate: m365End,
      evaluationStartByDate: addDays(m365End, -180),
      autoRenewal: true,
      autoRenewalNoticeDays: 30,
      cancelByDate: m365Cancel,
      poNumber: 'PO-2024-1847',
      requestor: 'Sarah Chen',
      department: 'IT',
      deliveryMethod: 'user',
      status: 'under_review',
      evaluationStartedById: adminUser.id,
      evaluationStartedAt: addDays(now, -14),
      notes: 'Enterprise Agreement. Teams, SharePoint, Exchange Online, OneDrive. Annual true-up in Q4. Cancel window closes soon — evaluate Copilot add-on before auto-renew. License count may be reducible by 30 seats based on last active-user audit.',
      internalOwnerId: adminUser.id,
    },
  });

  // 2. Microsoft Azure EA — $312,000 committed/yr — active, 14 months out. Safe.
  const azureEnd = addDays(now, 425);
  await prisma.contract.upsert({
    where: { id: '00000000-0000-0000-0000-000000000031' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000031',
      accountId: account.id,
      vendorId: microsoft.id,
      contractNumber: 'MS-AZ-EA-2025-0192',
      customerNumber: 'ACME-MS-001',
      product: 'Azure Enterprise Agreement',
      quantity: 1,
      costPerLicense: 312000.00,
      startDate: addDays(now, -30),
      endDate: azureEnd,
      evaluationStartByDate: addDays(azureEnd, -90),
      autoRenewal: false,
      poNumber: 'PO-2025-0112',
      requestor: 'Sarah Chen',
      department: 'Engineering',
      deliveryMethod: 'shared_pool',
      status: 'active',
      notes: 'Annual monetary commitment. Includes Dev/Test pricing and Reserved Instance discounts. Engineering team forecasting 20% YoY growth in compute. Evaluate 3-year reserved instances at renewal for additional 15% savings.',
      internalOwnerId: adminUser.id,
    },
  });

  // 3. Salesforce Sales Cloud Enterprise — $67,500/yr — under review, 110 days out
  const sfSalesEnd = addDays(now, 110);
  await prisma.contract.upsert({
    where: { id: '00000000-0000-0000-0000-000000000032' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000032',
      accountId: account.id,
      vendorId: salesforce.id,
      contractNumber: 'SF-ENT-2024-1182',
      customerNumber: 'ACME-SF-002',
      product: 'Sales Cloud Enterprise',
      quantity: 45,
      costPerLicense: 1500.00,
      startDate: addDays(now, -255),
      endDate: sfSalesEnd,
      evaluationStartByDate: addDays(sfSalesEnd, -90),
      autoRenewal: false,
      poNumber: 'PO-2024-1182',
      requestor: 'Marcus Reid',
      department: 'Sales',
      deliveryMethod: 'user',
      status: 'under_review',
      evaluationStartedById: adminUser.id,
      evaluationStartedAt: addDays(now, -7),
      notes: '7% YoY escalation clause will push this to $72,225 at renewal. Evaluate Salesforce vs HubSpot — HubSpot Sales Hub Pro quoted at $48,000 for same seat count. Sales team wants 10 additional seats. Get competing quote before negotiation.',
      internalOwnerId: adminUser.id,
    },
  });

  // 4. Salesforce Service Cloud — $54,000/yr — active, 8 months out, in review window
  const sfServiceEnd = addDays(now, 245);
  await prisma.contract.upsert({
    where: { id: '00000000-0000-0000-0000-000000000033' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000033',
      accountId: account.id,
      vendorId: salesforce.id,
      contractNumber: 'SF-SVC-2024-1183',
      customerNumber: 'ACME-SF-002',
      product: 'Service Cloud Professional',
      quantity: 30,
      costPerLicense: 1800.00,
      startDate: addDays(now, -120),
      endDate: sfServiceEnd,
      evaluationStartByDate: addDays(sfServiceEnd, -120),
      autoRenewal: false,
      poNumber: 'PO-2024-1901',
      requestor: 'Dana Park',
      department: 'Customer Success',
      deliveryMethod: 'user',
      status: 'active',
      notes: 'Same AE as Sales Cloud — bundle negotiation opportunity. Consider upgrading to Enterprise tier for Einstein AI features. Review alongside Sales Cloud renewal for consolidated discount.',
      internalOwnerId: adminUser.id,
    },
  });

  // 5. CrowdStrike Falcon Pro — $20,997/yr — active, 28 days out. AUTO-RENEW IN 28 DAYS.
  const csEnd = addDays(now, 28);
  await prisma.contract.upsert({
    where: { id: '00000000-0000-0000-0000-000000000034' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000034',
      accountId: account.id,
      vendorId: crowdstrike.id,
      contractNumber: 'CS-2024-PRO-4421',
      product: 'Falcon Pro Endpoint Protection',
      quantity: 350,
      costPerLicense: 59.99,
      startDate: addDays(now, -337),
      endDate: csEnd,
      evaluationStartByDate: addDays(csEnd, -60),
      autoRenewal: true,
      autoRenewalNoticeDays: 30,
      cancelByDate: addDays(csEnd, -30),
      department: 'Security',
      deliveryMethod: 'device',
      status: 'active',
      notes: 'Auto-renews in 28 days. Cancel window already passed. Evaluate upgrade to Falcon Enterprise (adds Identity Protection + Spotlight) — quoted $89.99/endpoint. Endpoint count steady; no true-up expected.',
      internalOwnerId: adminUser.id,
    },
  });

  // 6. Okta Workforce Identity — $42,000/yr — active, 5 months out, approaching review
  const oktaEnd = addDays(now, 155);
  await prisma.contract.upsert({
    where: { id: '00000000-0000-0000-0000-000000000035' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000035',
      accountId: account.id,
      vendorId: okta.id,
      contractNumber: 'OKTA-WF-2024-8821',
      product: 'Workforce Identity Cloud',
      quantity: 700,
      costPerLicense: 60.00,
      startDate: addDays(now, -210),
      endDate: oktaEnd,
      evaluationStartByDate: addDays(oktaEnd, -90),
      autoRenewal: true,
      autoRenewalNoticeDays: 45,
      cancelByDate: addDays(oktaEnd, -45),
      poNumber: 'PO-2024-2241',
      requestor: 'Sarah Chen',
      department: 'IT',
      deliveryMethod: 'user',
      status: 'active',
      notes: 'SSO and MFA for all employees and contractors. Seat count includes 650 FTEs + 50 contractors. Evaluate Microsoft Entra ID as alternative — already paying for it under M365 E3. Could eliminate this contract entirely.',
      internalOwnerId: adminUser.id,
    },
  });

  // 7. Atlassian Jira + Confluence Cloud — $31,200/yr — active, 11 months out. Safe.
  const atlassianEnd = addDays(now, 335);
  await prisma.contract.upsert({
    where: { id: '00000000-0000-0000-0000-000000000036' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000036',
      accountId: account.id,
      vendorId: atlassian.id,
      contractNumber: 'ATL-CLOUD-2025-3301',
      product: 'Jira + Confluence Cloud Standard',
      quantity: 300,
      costPerLicense: 104.00,
      startDate: addDays(now, -30),
      endDate: atlassianEnd,
      evaluationStartByDate: addDays(atlassianEnd, -90),
      autoRenewal: true,
      autoRenewalNoticeDays: 30,
      cancelByDate: addDays(atlassianEnd, -30),
      poNumber: 'PO-2025-0088',
      requestor: 'James Liu',
      department: 'Engineering',
      deliveryMethod: 'user',
      status: 'active',
      notes: 'Recently renewed — migrated from Server to Cloud. 300 users across Engineering, Product, and IT. Evaluate Premium tier at next renewal for advanced roadmaps and admin insights.',
      internalOwnerId: adminUser.id,
    },
  });

  // 8. Zoom Phone + Video — $18,000/yr — EXPIRED 45 days ago. On month-to-month.
  const zoomEnd = addDays(now, -45);
  await prisma.contract.upsert({
    where: { id: '00000000-0000-0000-0000-000000000037' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000037',
      accountId: account.id,
      vendorId: zoom.id,
      contractNumber: 'ZM-BIZ-2024-0044',
      product: 'Zoom Phone + Meetings Business',
      quantity: 150,
      costPerLicense: 120.00,
      startDate: addDays(now, -410),
      endDate: zoomEnd,
      evaluationStartByDate: addDays(zoomEnd, -60),
      autoRenewal: false,
      poNumber: 'PO-2024-0301',
      requestor: 'Dana Park',
      department: 'Operations',
      deliveryMethod: 'user',
      status: 'expired',
      notes: 'Contract expired — currently on month-to-month at 20% premium. Microsoft Teams Phone available under M365 E3 — migration could eliminate this spend entirely. Migration project scoped at ~40 hours of IT time.',
      internalOwnerId: adminUser.id,
    },
  });

  // 9. ServiceNow ITSM + HRSD — $185,000/yr — active, 7 months out. Large contract.
  const snowEnd = addDays(now, 210);
  await prisma.contract.upsert({
    where: { id: '00000000-0000-0000-0000-000000000038' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000038',
      accountId: account.id,
      vendorId: servicenow.id,
      contractNumber: 'SN-ENT-2024-7701',
      product: 'ITSM Pro + HRSD Standard',
      quantity: 1,
      costPerLicense: 185000.00,
      startDate: addDays(now, -155),
      endDate: snowEnd,
      evaluationStartByDate: addDays(snowEnd, -90),
      autoRenewal: true,
      autoRenewalNoticeDays: 90,
      cancelByDate: addDays(snowEnd, -90),
      poNumber: 'PO-2024-1550',
      requestor: 'Sarah Chen',
      department: 'IT',
      deliveryMethod: 'shared_pool',
      status: 'active',
      notes: 'Largest single contract in portfolio. ITSM used by 12 IT staff; HRSD by HR team of 8. CSM module upsell pitched at last QBR — $45,000 add-on. 90-day cancel notice required to avoid ACV auto-escalation. Start renewal discussion no later than 90 days before expiry.',
      internalOwnerId: adminUser.id,
    },
  });

  // 10. Slack Business+ — $28,800/yr — active, 3 months out. Salesforce vendor.
  const slackEnd = addDays(now, 92);
  await prisma.contract.upsert({
    where: { id: '00000000-0000-0000-0000-000000000039' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000039',
      accountId: account.id,
      vendorId: salesforce.id,
      contractNumber: 'SLACK-BIZ-2024-0881',
      product: 'Slack Business+',
      quantity: 400,
      costPerLicense: 72.00,
      startDate: addDays(now, -273),
      endDate: slackEnd,
      evaluationStartByDate: addDays(slackEnd, -60),
      autoRenewal: false,
      poNumber: 'PO-2024-0441',
      requestor: 'Marcus Reid',
      department: 'Operations',
      deliveryMethod: 'user',
      status: 'active',
      notes: 'Owned by same Salesforce AE — bundle negotiation opportunity with Sales Cloud and Service Cloud renewals. Microsoft Teams included in M365 E3 — evaluate migration vs Slack renewal. Usage data shows 280 of 400 seats active in last 30 days.',
      internalOwnerId: adminUser.id,
    },
  });

  console.log('✓ Contracts: 10 contracts across 7 vendors seeded');

  console.log('\n─────────────────────────────────────────');
  console.log('  Seed complete. Login credentials:');
  console.log('  Email:    admin@acme.com');
  console.log('  Password: Admin1234!');
  console.log('─────────────────────────────────────────\n');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
