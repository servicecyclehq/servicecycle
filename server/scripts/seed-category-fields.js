#!/usr/bin/env node
/**
 * server/scripts/seed-category-fields.js
 *
 * Idempotent seed of must-have CustomFieldDefinition records for all
 * per-category fields defined in category-fields-master.md.
 *
 * Usage:
 *   node server/scripts/seed-category-fields.js           # all accounts
 *   node server/scripts/seed-category-fields.js --account <id>  # one account
 *   node server/scripts/seed-category-fields.js --dry-run  # print without writing
 *
 * Idempotency: uses upsert keyed on (accountId, fieldKey, categoryId).
 * Because the unique constraint was changed to two partial indexes in
 * migration 20260525000000, the upsert looks up the existing record
 * by (accountId, fieldKey, categoryId) manually before deciding create/skip.
 *
 * Phase A: insurance, telecom, lease_rent
 * Phase B: hardware, services, saas
 * Phase C: cloud, staffing, marketing, maintenance (creates new slugs)
 * Cross-category: global fields (categoryId = null)
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ── Field definitions ─────────────────────────────────────────────────────────
// Each entry: { key, name, type, helpText, required, options (for select), displayOrder }
// options for select: array of strings (auto-converted to { value, label })

const FIELDS_BY_SLUG = {

  // ── 1. SaaS overlay (must-haves only — base schema already covers core fields)
  saas: [
    { key: 'price_uplift_cap_percent',           name: 'Price Uplift Cap %',              type: 'number',   helpText: 'Contractual cap on renewal price increase (%)' },
    { key: 'support_tier',                        name: 'Support Tier',                    type: 'select',   options: ['Standard','Premium','Enterprise','Mission-Critical'] },
    { key: 'p1_response_time_hours',              name: 'P1 Response Time (hrs)',           type: 'number',   helpText: 'SLA response time for critical (P1) incidents in hours' },
    { key: 'uptime_sla_percent',                  name: 'Uptime SLA %',                    type: 'number',   helpText: 'Contracted uptime commitment, e.g. 99.9' },
    { key: 'data_hosting_region',                 name: 'Data Hosting Region',             type: 'text',     helpText: 'Geographic region(s) where customer data is stored at rest' },
    { key: 'data_retention_days_post_termination',name: 'Data Retention Days (post-term)', type: 'number',   helpText: 'Days vendor retains data after termination before deletion' },
    { key: 'exit_data_format',                    name: 'Exit Data Format',                type: 'select',   options: ['CSV','SQL-backup','API','Native','None'] },
    { key: 'data_processing_agreement_signed',    name: 'DPA Signed',                      type: 'checkbox', helpText: 'Data Processing Agreement or privacy addendum executed' },
    { key: 'security_certifications',             name: 'Security Certifications',         type: 'text',     helpText: 'e.g. SOC2, ISO27001, FedRAMP, HIPAA, PCI-DSS' },
    { key: 'sso_integration_standard',            name: 'SSO Standard',                    type: 'select',   options: ['SAML','OIDC','LDAP','None'] },
    { key: 'mfa_supported',                       name: 'MFA Supported',                   type: 'checkbox', helpText: 'Native MFA included without extra architectural fees' },
  ],

  // ── 2. Hardware & Maintenance
  hardware: [
    { key: 'asset_type',                  name: 'Asset Type',                    type: 'select',   options: ['Server','Storage','Network','Endpoint','Copier-Printer','Vehicle','Industrial','Other'] },
    { key: 'asset_count',                 name: 'Asset Count',                   type: 'number',   helpText: 'Number of physical units covered' },
    { key: 'asset_tag_list',              name: 'Asset Tags',                    type: 'textarea', helpText: 'Comma-separated internal asset tag numbers' },
    { key: 'serial_numbers',              name: 'Serial Numbers',                type: 'textarea', helpText: 'Serial numbers of covered units (required for TPM)' },
    { key: 'manufacturer_model',          name: 'Manufacturer / Model',          type: 'text',     helpText: 'e.g. Cisco Catalyst 9300' },
    { key: 'oem_eosl_date',               name: 'OEM End-of-Service-Life Date',  type: 'date',     helpText: 'Paying maintenance past EOSL is wasted spend' },
    { key: 'maintenance_provider_type',   name: 'Maintenance Provider',          type: 'select',   options: ['OEM','TPM (Third-Party)','Hybrid'] },
    { key: 'sla_tier',                    name: 'SLA Tier',                      type: 'select',   options: ['24x7x4hr','8x5xNBD','24x7xNBD','Next-Business-Day','Custom'] },
    { key: 'coverage_hours',              name: 'Coverage Hours',                type: 'select',   options: ['24x7','Business-Hours','Custom'] },
    { key: 'p1_response_time_hours',      name: 'P1 Response Time (hrs)',        type: 'number',   helpText: 'Hours to respond to Priority 1 (critical) incidents' },
    { key: 'includes_firmware_updates',   name: 'Firmware Updates Included',     type: 'checkbox' },
    { key: 'includes_onsite_parts',       name: 'On-site Parts Included',        type: 'checkbox' },
    { key: 'oem_parts_required',          name: 'OEM Parts Required',            type: 'checkbox', helpText: 'Only OEM parts may be used (affects TPM eligibility)' },
    { key: 'lease_type',                  name: 'Lease Type',                    type: 'select',   options: ['Operating','Finance','Capital'] },
    { key: 'residual_value',              name: 'Residual / Buyout Value',       type: 'number' },
    { key: 'buyout_option',               name: 'Buyout Option',                 type: 'select',   options: ['None','FMV','$1-Buyout','Fixed-Amount'] },
    { key: 'equipment_refresh_date',      name: 'Equipment Refresh Date',        type: 'date',     helpText: 'Planned refresh/replacement date — drives renew vs. replace' },
    { key: 'data_destruction_certification', name: 'Data Destruction Cert Required', type: 'checkbox', helpText: 'Vendor must certify secure data erasure on return' },
    { key: 'annual_uplift_cap_percent',   name: 'Annual Uplift Cap %',           type: 'number',   helpText: 'Contractual cap on annual maintenance price increases (%)' },
    { key: 'includes_preventive_maintenance', name: 'Preventive Maintenance Included', type: 'checkbox' },
  ],

  // ── 3. Professional Services / Consulting
  services: [
    { key: 'engagement_type',                       name: 'Engagement Type',              type: 'select',   options: ['Fixed-Fee','Time-and-Materials','Retainer','Milestone-Based','Outcome-Based'] },
    { key: 'sow_title',                             name: 'SOW Title',                    type: 'text',     helpText: 'Statement of Work title and reference number' },
    { key: 'sow_version',                           name: 'SOW Version',                  type: 'text',     helpText: 'SOW version number — tracks amendments' },
    { key: 'primary_deliverable',                   name: 'Primary Deliverable',          type: 'textarea', helpText: 'Top-level deliverable or outcome description' },
    { key: 'billing_rate_type',                     name: 'Billing Rate Type',            type: 'select',   options: ['Hourly','Daily','Monthly-Retainer','Fixed-Fee'] },
    { key: 'hourly_rate',                           name: 'Hourly Rate',                  type: 'number' },
    { key: 'monthly_retainer_amount',               name: 'Monthly Retainer Amount',      type: 'number' },
    { key: 'included_hours_per_month',              name: 'Included Hours / Month',       type: 'number' },
    { key: 'total_estimated_hours',                 name: 'Total Estimated Hours',        type: 'number' },
    { key: 'not_to_exceed_amount',                  name: 'Not-to-Exceed (NTE) Amount',   type: 'number',   helpText: 'Hard cost ceiling for T&M engagements' },
    { key: 'payment_trigger',                       name: 'Payment Trigger',              type: 'select',   options: ['Invoice','Milestone-Completion','Monthly','Project-Completion'] },
    { key: 'expense_reimbursement_policy',          name: 'Expense Reimbursement Policy', type: 'select',   options: ['None','Actual','Capped-Percent','Per-Diem'] },
    { key: 'ip_ownership',                          name: 'IP Ownership',                 type: 'select',   options: ['Client','Vendor','Shared','Work-for-Hire'] },
    { key: 'non_solicitation_months',               name: 'Non-Solicitation (months)',    type: 'number',   helpText: 'Months client may not solicit vendor personnel after engagement' },
    { key: 'termination_for_convenience_notice_days', name: 'Termination for Convenience Notice (days)', type: 'number' },
    { key: 'named_personnel',                       name: 'Named Personnel Required',     type: 'checkbox', helpText: 'Contract names specific individuals who must perform the work' },
    { key: 'knowledge_transfer_required',           name: 'Knowledge Transfer Required',  type: 'checkbox' },
    { key: 'sla_uptime_percent',                    name: 'Uptime SLA % (managed svcs)',  type: 'number' },
    { key: 'sla_response_p1_hours',                 name: 'P1 Response Time (hrs)',        type: 'number' },
    { key: 'milestone_count',                       name: 'Milestone Count',              type: 'number' },
    { key: 'warranty_period_days',                  name: 'Warranty Period (days)',        type: 'number',   helpText: 'Days work product is warranted against defects after delivery' },
  ],

  // ── 4. Telecom / Connectivity
  telecom: [
    { key: 'service_type',               name: 'Service Type',                  type: 'select',   options: ['Mobile','Voice-POTS','Broadband','DIA','MPLS','SD-WAN','VoIP-UCaaS','Dark-Fiber','Conferencing','Other'] },
    { key: 'circuit_id',                 name: 'Circuit ID',                    type: 'text',     helpText: 'Carrier-assigned circuit ID — essential for billing reconciliation' },
    { key: 'circuit_ids_list',           name: 'All Circuit IDs',               type: 'textarea', helpText: 'Comma-separated if contract covers multiple circuits' },
    { key: 'service_location',           name: 'Service Location',              type: 'text',     helpText: 'Address or site name where circuit terminates' },
    { key: 'bandwidth_mbps_download',    name: 'Download Bandwidth (Mbps)',     type: 'number' },
    { key: 'bandwidth_mbps_upload',      name: 'Upload Bandwidth (Mbps)',       type: 'number' },
    { key: 'committed_information_rate_mbps', name: 'CIR (Mbps)',               type: 'number',   helpText: 'Committed Information Rate — guaranteed bandwidth floor' },
    { key: 'monthly_recurring_charge',   name: 'Monthly Recurring Charge (MRC)', type: 'number' },
    { key: 'nrc_installation',           name: 'NRC / Installation Charge',     type: 'number',   helpText: 'Non-recurring installation/provisioning charge' },
    { key: 'regulatory_surcharges_monthly', name: 'Regulatory Surcharges / Month', type: 'number', helpText: 'USF, regulatory recovery, access charges' },
    { key: 'line_count',                 name: 'Line / Circuit Count',          type: 'number' },
    { key: 'uptime_sla_percent',         name: 'Uptime SLA %',                  type: 'number',   helpText: 'Committed service availability, e.g. 99.99' },
    { key: 'latency_sla_ms',             name: 'Latency SLA (ms)',              type: 'number' },
    { key: 'mttr_sla_hours',             name: 'MTTR SLA (hrs)',                type: 'number',   helpText: 'Mean Time to Repair committed by carrier' },
    { key: 'etf_amount',                 name: 'Early Termination Fee (ETF)',    type: 'number',   helpText: 'Often exceeds remaining contract value — critical for exit planning' },
    { key: 'etf_calculation_method',     name: 'ETF Calculation Method',        type: 'text',     helpText: 'e.g. "remaining MRC x months remaining"' },
    { key: 'auto_renewal_uplift_percent',name: 'Auto-Renewal Uplift %',         type: 'number',   helpText: '% uplift if contract rolls month-to-month post-term' },
  ],

  // ── 5. Facilities / Real Estate Lease
  lease_rent: [
    { key: 'lease_type',                          name: 'Lease Type',                      type: 'select',   options: ['Gross (Full-Service)','Modified-Gross','NNN (Triple-Net)','Net','Double-Net'] },
    { key: 'property_address',                    name: 'Property Address',                type: 'text',     helpText: 'Full street address of the leased premises' },
    { key: 'suite_unit',                          name: 'Suite / Unit',                    type: 'text' },
    { key: 'rentable_square_footage',             name: 'Rentable Sq Ft',                  type: 'number' },
    { key: 'base_rent_monthly',                   name: 'Base Rent / Month',               type: 'number' },
    { key: 'base_rent_annual_escalation_percent', name: 'Annual Rent Escalation %',        type: 'number' },
    { key: 'cam_charges_monthly',                 name: 'CAM Charges / Month',             type: 'number',   helpText: 'Common Area Maintenance charge estimate' },
    { key: 'cam_reconciliation_date',             name: 'CAM Reconciliation Date',         type: 'date' },
    { key: 'cam_expense_cap_percent',             name: 'CAM Expense Cap %',               type: 'number' },
    { key: 'property_tax_passthrough',            name: 'Property Tax Passthrough',        type: 'checkbox' },
    { key: 'insurance_passthrough',               name: 'Insurance Passthrough',           type: 'checkbox' },
    { key: 'pro_rata_share_percent',              name: 'Pro Rata Share %',                type: 'number',   helpText: "Tenant's share of building operating expenses" },
    { key: 'free_rent_months',                    name: 'Free Rent (months)',              type: 'number',   helpText: 'Months of abated rent as landlord concession' },
    { key: 'tenant_improvement_allowance',        name: 'TI Allowance ($)',               type: 'number' },
    { key: 'option_to_renew',                     name: 'Renewal Option',                  type: 'checkbox' },
    { key: 'option_to_renew_terms',               name: 'Renewal Option Terms',            type: 'text',     helpText: 'e.g. "2×5yr at 95% FMV"' },
    { key: 'option_to_terminate_early',           name: 'Early Termination Option',        type: 'checkbox' },
    { key: 'early_termination_penalty',           name: 'Early Termination Penalty ($)',   type: 'number' },
    { key: 'holdover_rent_multiplier',            name: 'Holdover Rent Multiplier',        type: 'number',   helpText: 'e.g. 1.5 = 150% of base rent during holdover' },
    { key: 'landlord_name',                       name: 'Landlord Name',                   type: 'text' },
    { key: 'personal_guarantee_type',             name: 'Personal Guarantee Type',         type: 'select',   options: ['None','Full-Term','Good-Guy','Capped-Amount'] },
    { key: 'right_of_audit',                      name: 'Right to Audit CAM',              type: 'checkbox' },
  ],

  // ── 6. Insurance Policy
  insurance: [
    { key: 'policy_number',                    name: 'Policy Number',                    type: 'text' },
    { key: 'policy_type',                      name: 'Policy Type',                      type: 'select',   options: ['General-Liability','D&O','E&O','Cyber','Property','Workers-Comp','Group-Health','Professional-Liability','Umbrella','Auto','Other'] },
    { key: 'insurer_name',                     name: 'Insurer Name',                     type: 'text' },
    { key: 'broker_name',                      name: 'Broker Name',                      type: 'text' },
    { key: 'broker_contact_email',             name: 'Broker Contact Email',             type: 'text' },
    { key: 'premium_annual',                   name: 'Annual Premium ($)',               type: 'number' },
    { key: 'premium_payment_schedule',         name: 'Premium Payment Schedule',         type: 'select',   options: ['Annual','Semi-Annual','Quarterly','Monthly'] },
    { key: 'per_occurrence_limit',             name: 'Per-Occurrence Limit ($)',         type: 'number' },
    { key: 'aggregate_limit',                  name: 'Aggregate Limit ($)',              type: 'number' },
    { key: 'deductible_amount',                name: 'Deductible ($)',                   type: 'number' },
    { key: 'retention_amount',                 name: 'Self-Insured Retention ($)',        type: 'number',   helpText: 'Common in D&O / Cyber policies' },
    { key: 'claims_made_or_occurrence',        name: 'Claims-Made or Occurrence',        type: 'select',   options: ['Claims-Made','Occurrence'] },
    { key: 'retroactive_date',                 name: 'Retroactive Date',                 type: 'date',     helpText: 'For claims-made policies: earliest incident date covered' },
    { key: 'war_exclusion',                    name: 'War / Nation-State Exclusion',     type: 'checkbox', helpText: 'Critical for cyber policies post-2022' },
    { key: 'cancellation_notice_days',         name: 'Cancellation Notice (days)',       type: 'number' },
    { key: 'certificate_of_insurance_required',name: 'COI Required',                     type: 'checkbox' },
    { key: 'premium_audit_basis',              name: 'Premium Audit Basis',              type: 'select',   options: ['Payroll','Revenue','Headcount','Per-Occurrence','None'] },
    { key: 'insurer_am_best_rating',           name: 'Insurer AM Best Rating',           type: 'text',     helpText: 'e.g. A+, A-' },
  ],

  // ── 7. Cloud / IaaS / PaaS (new slug — Phase C; fields seed to saas for now)
  cloud: [
    { key: 'cloud_provider',                name: 'Cloud Provider',                 type: 'select',   options: ['AWS','Azure','GCP','Oracle-Cloud','Snowflake','Databricks','IBM-Cloud','Other'] },
    { key: 'agreement_type',                name: 'Agreement Type',                 type: 'select',   options: ['Enterprise-Agreement','EDP','MACC','CUD','Savings-Plan','Reserved-Instance','Pay-as-you-go','Other'] },
    { key: 'committed_spend_annual',        name: 'Committed Spend (Annual)',       type: 'number' },
    { key: 'committed_spend_total',         name: 'Committed Spend (Total Term)',   type: 'number' },
    { key: 'discount_percent',              name: 'Discount % vs List',             type: 'number' },
    { key: 'commitment_term_years',         name: 'Commitment Term (years)',        type: 'number' },
    { key: 'drawdown_to_date',              name: 'Drawdown to Date ($)',           type: 'number' },
    { key: 'drawdown_rate_monthly',         name: 'Monthly Burn Rate ($)',          type: 'number' },
    { key: 'overage_rate_percent',          name: 'Overage Rate %',                 type: 'number',   helpText: 'Premium % on consumption beyond committed amount' },
    { key: 'credits_included',              name: 'Credits Included ($)',           type: 'number' },
    { key: 'credits_expiration_date',       name: 'Credits Expiration Date',        type: 'date' },
    { key: 'primary_services_covered',      name: 'Primary Services in Scope',      type: 'text',     helpText: 'e.g. EC2, S3, RDS' },
    { key: 'ri_utilization_percent',        name: 'RI / CUD Utilization %',         type: 'number',   helpText: 'Low = wasted commitment spend' },
    { key: 'support_plan_tier',             name: 'Support Plan',                   type: 'select',   options: ['Basic','Developer','Business','Enterprise','Premier'] },
    { key: 'support_plan_cost_monthly',     name: 'Support Plan Cost / Month',      type: 'number' },
    { key: 'ea_enrollment_number',          name: 'EA / Enrollment Number',         type: 'text' },
    { key: 'reserved_instance_expiry_date', name: 'Reserved Instance Expiry Date',  type: 'date' },
  ],

  // ── 8. Staffing / Contingent Labor (new slug — Phase C; seeds to services for now)
  staffing: [
    { key: 'engagement_model',                      name: 'Engagement Model',                 type: 'select',   options: ['W2-Temp','1099-Independent','C2C-Corp-to-Corp','Direct-Hire','MSP-VMS','Staff-Aug'] },
    { key: 'worker_classification',                 name: 'Worker Classification',            type: 'select',   options: ['W2','1099','C2C'] },
    { key: 'position_title',                        name: 'Position Title',                   type: 'text' },
    { key: 'worker_count',                          name: 'Worker Count',                     type: 'number' },
    { key: 'bill_rate_hourly',                      name: 'Bill Rate ($/hr)',                 type: 'number' },
    { key: 'markup_percent',                        name: 'Markup %',                         type: 'number' },
    { key: 'overtime_bill_rate_multiplier',         name: 'OT Bill Rate Multiplier',          type: 'number',   helpText: 'e.g. 1.5' },
    { key: 'department_assigned',                   name: 'Department / Cost Center',         type: 'text' },
    { key: 'hiring_manager',                        name: 'Hiring Manager',                   type: 'text' },
    { key: 'work_location_type',                    name: 'Work Location',                    type: 'select',   options: ['On-Site','Remote','Hybrid'] },
    { key: 'placement_fee_percent',                 name: 'Placement Fee %',                  type: 'number',   helpText: 'Fee % for direct hire (% of first-year salary)' },
    { key: 'guaranteed_placement_period_days',      name: 'Placement Guarantee (days)',       type: 'number' },
    { key: 'non_solicitation_days',                 name: 'Non-Solicitation (days)',          type: 'number' },
    { key: 'conversion_fee',                        name: 'Conversion Fee ($)',               type: 'number' },
    { key: 'conversion_eligible_after_days',        name: 'Conversion-Free After (days)',     type: 'number' },
    { key: 'background_check_required',             name: 'Background Check Required',        type: 'checkbox' },
    { key: 'compliance_jurisdiction',               name: 'Compliance Jurisdiction',          type: 'text',     helpText: 'State/jurisdiction governing worker classification' },
    { key: 'intellectual_property_assignment_ack',  name: 'IP Assignment Signed',             type: 'checkbox' },
  ],

  // ── 9. Marketing / Advertising / Media (new slug — Phase C; seeds to services)
  marketing: [
    { key: 'mkt_engagement_type',          name: 'Engagement Type',                  type: 'select',   options: ['Agency-Retainer','Media-Buy','Programmatic','Search-SEM','Social-Paid','PR-Retainer','Creative-Services','Sponsorship','Affiliate','Event'] },
    { key: 'io_number',                    name: 'Insertion Order #',                type: 'text' },
    { key: 'campaign_name',                name: 'Campaign Name',                    type: 'text' },
    { key: 'flight_start_date',            name: 'Flight Start Date',                type: 'date' },
    { key: 'flight_end_date',              name: 'Flight End Date',                  type: 'date' },
    { key: 'total_budget',                 name: 'Total Budget ($)',                 type: 'number' },
    { key: 'media_spend_budget',           name: 'Media Spend Budget ($)',           type: 'number' },
    { key: 'agency_fee_type',              name: 'Agency Fee Type',                  type: 'select',   options: ['Fixed-Monthly','Percent-of-Spend','Project-Fee','Hourly'] },
    { key: 'agency_fee_percent_of_spend',  name: 'Agency Fee % of Spend',           type: 'number' },
    { key: 'pricing_model',                name: 'Pricing Model',                    type: 'select',   options: ['CPM','CPC','CPA','CPL','Fixed-Placement','Revenue-Share','Flat-Fee'] },
    { key: 'guaranteed_impressions',       name: 'Guaranteed Impressions',           type: 'number' },
    { key: 'placement_channels',           name: 'Placement Channels',               type: 'text',     helpText: 'e.g. Google, Meta, LinkedIn, CTV, Programmatic DSP' },
    { key: 'kpi_primary',                  name: 'Primary KPI',                      type: 'text',     helpText: 'e.g. ROAS, CPA, impressions, reach' },
    { key: 'reporting_frequency',          name: 'Reporting Frequency',              type: 'select',   options: ['Weekly','Bi-Weekly','Monthly','Campaign-End'] },
    { key: 'creative_ownership',           name: 'Creative Ownership',               type: 'select',   options: ['Client','Agency','Shared'] },
    { key: 'cancellation_notice_days',     name: 'Cancellation Notice (days)',       type: 'number' },
    { key: 'audience_data_ownership',      name: 'Audience Data Ownership',          type: 'select',   options: ['Client','Vendor','Shared'] },
    { key: 'ccpa_gdpr_data_processor_terms', name: 'CCPA/GDPR Data Processor Terms', type: 'checkbox', helpText: 'Data protection addendum attached (required for programmatic/retargeting)' },
    { key: 'rebate_disclosure',            name: 'Rebate Disclosure Required',       type: 'checkbox', helpText: 'Agency must disclose volume rebates received from media owners' },
  ],

  // ── 10. Maintenance & Support Contracts (new slug — Phase C; seeds to hardware)
  maintenance: [
    { key: 'supported_product_name',        name: 'Supported Product Name',          type: 'text' },
    { key: 'supported_product_version',     name: 'Supported Product Version',       type: 'text' },
    { key: 'support_tier',                  name: 'Support Tier',                    type: 'select',   options: ['Basic','Standard','Business','Premium','Enterprise','Mission-Critical'] },
    { key: 'coverage_hours',                name: 'Coverage Hours',                  type: 'select',   options: ['24x7','8x5','Business-Hours','Custom'] },
    { key: 'p1_response_time_hours',        name: 'P1 Response Time (hrs)',          type: 'number' },
    { key: 'p2_response_time_hours',        name: 'P2 Response Time (hrs)',          type: 'number' },
    { key: 'resolution_time_p1_hours',      name: 'P1 Resolution Time (hrs)',        type: 'number' },
    { key: 'uptime_sla_percent',            name: 'Uptime SLA %',                    type: 'number' },
    { key: 'includes_patches',              name: 'Security Patches Included',       type: 'checkbox' },
    { key: 'includes_minor_updates',        name: 'Minor Updates Included',          type: 'checkbox' },
    { key: 'includes_major_upgrades',       name: 'Major Upgrades Included',         type: 'checkbox', helpText: 'Major version upgrades (often requires separate license)' },
    { key: 'patch_sla_security_hours',      name: 'Security Patch SLA (hrs)',        type: 'number' },
    { key: 'eol_support_date',              name: 'End-of-Life Support Date',        type: 'date',     helpText: 'Date vendor ends support — renewal urgency driver' },
    { key: 'named_support_contacts',        name: 'Named Support Contacts',          type: 'number',   helpText: 'Number of named contacts allowed to open tickets' },
    { key: 'onsite_support_included',       name: 'On-site Support Included',        type: 'checkbox' },
    { key: 'parts_included',                name: 'Parts Included',                  type: 'checkbox' },
    { key: 'sla_credit_mechanism',          name: 'SLA Credits Mechanism',           type: 'checkbox', helpText: 'SLA breaches trigger service credits' },
    { key: 'oem_parts_required',            name: 'OEM Parts Required',              type: 'checkbox' },
    { key: 'certified_engineer_requirement',name: 'Certified Engineer Required',     type: 'checkbox' },
    { key: 'annual_uplift_cap_percent',     name: 'Annual Uplift Cap %',             type: 'number' },
    { key: 'third_party_support_eligible',  name: 'TPM Support Permitted',           type: 'checkbox', helpText: 'Third-party support contractually allowed as alternative' },
  ],
};

// Phase C slug mapping: until new categories exist, seed to the parent slug
const PHASE_C_FALLBACK = {
  cloud:       'saas',
  staffing:    'services',
  marketing:   'services',
  maintenance: 'hardware',
};

// Cross-category global fields (categoryId = null)
const GLOBAL_FIELDS = [
  { key: 'governing_law',                 name: 'Governing Law',                      type: 'text',     helpText: 'State/jurisdiction governing the contract' },
  { key: 'limitation_of_liability_amount',name: 'Limitation of Liability ($)',        type: 'number' },
  { key: 'vendor_risk_tier',              name: 'Vendor Risk Tier',                   type: 'select',   options: ['Low','Medium','High','Critical'] },
  { key: 'business_criticality',          name: 'Business Criticality',               type: 'select',   options: ['Low','Medium','High','Critical'] },
  { key: 'confidentiality_expiration_date',name: 'Confidentiality / NDA Expiry',      type: 'date' },
  { key: 'approved_by_legal',             name: 'Approved by Legal',                  type: 'checkbox' },
  { key: 'approved_by_procurement',       name: 'Approved by Procurement',            type: 'checkbox' },
  { key: 'approved_by_security',          name: 'Approved by Security',               type: 'checkbox' },
  { key: 'indemnification_present',       name: 'Indemnification Clause',             type: 'checkbox' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function cleanOptions(arr) {
  return arr.map(o => typeof o === 'string' ? { value: o, label: o } : o);
}

async function seedFieldsForAccount(accountId, dryRun) {
  // Build a lookup of all categories by slug for this account
  const cats = await prisma.category.findMany({ where: { accountId, archivedAt: null } });
  const bySlug = Object.fromEntries(cats.map(c => [c.slug, c]));

  let created = 0, skipped = 0;

  // Count existing fields for the 50-field cap check
  const existingCount = await prisma.customFieldDefinition.count({
    where: { accountId, archivedAt: null },
  });

  // ── Category-scoped fields
  for (const [slug, fields] of Object.entries(FIELDS_BY_SLUG)) {
    // Resolve category: try exact slug, then Phase C fallback
    const targetSlug = PHASE_C_FALLBACK[slug] || slug;
    const cat = bySlug[targetSlug];
    if (!cat) {
      console.log(`  [skip] No category with slug "${targetSlug}" for account ${accountId}`);
      continue;
    }

    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      // Idempotency: check by (accountId, fieldKey, categoryId)
      const existing = await prisma.customFieldDefinition.findFirst({
        where: { accountId, fieldKey: f.key, categoryId: cat.id },
      });
      if (existing) { skipped++; continue; }

      if (dryRun) {
        console.log(`  [dry-run] Would create: ${cat.slug}.${f.key} (${f.type})`);
        created++;
        continue;
      }
      await prisma.customFieldDefinition.create({
        data: {
          accountId,
          createdById: (await prisma.user.findFirst({ where: { accountId, role: 'admin' } }))?.id
                        || (await prisma.user.findFirst({ where: { accountId } }))?.id,
          name:         f.name,
          fieldKey:     f.key,
          type:         f.type,
          helpText:     f.helpText || null,
          required:     f.required || false,
          options:      f.options ? cleanOptions(f.options) : null,
          displayOrder: i,
          categoryId:   cat.id,
        },
      });
      console.log(`  [created] ${cat.slug}.${f.key}`);
      created++;
    }
  }

  // ── Global fields (categoryId = null)
  for (let i = 0; i < GLOBAL_FIELDS.length; i++) {
    const f = GLOBAL_FIELDS[i];
    const existing = await prisma.customFieldDefinition.findFirst({
      where: { accountId, fieldKey: f.key, categoryId: null },
    });
    if (existing) { skipped++; continue; }

    if (dryRun) {
      console.log(`  [dry-run] Would create: global.${f.key} (${f.type})`);
      created++;
      continue;
    }
    await prisma.customFieldDefinition.create({
      data: {
        accountId,
        createdById: (await prisma.user.findFirst({ where: { accountId, role: 'admin' } }))?.id
                      || (await prisma.user.findFirst({ where: { accountId } }))?.id,
        name:         f.name,
        fieldKey:     f.key,
        type:         f.type,
        helpText:     f.helpText || null,
        required:     false,
        options:      f.options ? cleanOptions(f.options) : null,
        displayOrder: 900 + i,
        categoryId:   null,
      },
    });
    console.log(`  [created] global.${f.key}`);
    created++;
  }

  return { created, skipped };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args    = process.argv.slice(2);
  const dryRun  = args.includes('--dry-run');
  const accIdx  = args.indexOf('--account');
  const accId   = accIdx >= 0 ? args[accIdx + 1] : null;

  if (dryRun) console.log('[seed-category-fields] DRY RUN — no writes');

  let accounts;
  if (accId) {
    const a = await prisma.account.findUnique({ where: { id: accId } });
    if (!a) { console.error(`Account ${accId} not found`); process.exit(1); }
    accounts = [a];
  } else {
    accounts = await prisma.account.findMany({ where: { status: { not: 'inactive' } } });
  }

  let totalCreated = 0, totalSkipped = 0;
  for (const acc of accounts) {
    console.log(`\nAccount: ${acc.companyName} (${acc.id})`);
    const { created, skipped } = await seedFieldsForAccount(acc.id, dryRun);
    totalCreated += created;
    totalSkipped += skipped;
    console.log(`  -> created: ${created}, skipped (already exists): ${skipped}`);
  }

  console.log(`\nDone. Total created: ${totalCreated}, total skipped: ${totalSkipped}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
