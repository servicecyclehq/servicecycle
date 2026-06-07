/**
 * vendorAliases.js
 *
 * Curated map of canonical vendor names and their known semantic aliases —
 * abbreviations, shortnames, acquired brand names, and common misspellings
 * that string normalization alone cannot resolve.
 *
 * Format: { canonical: string, aliases: string[] }
 *
 * "canonical" is the preferred display name stored in the DB.
 * "aliases" are alternative names that should resolve to the canonical.
 *
 * Normalization (strip spaces/punctuation/suffixes) handles variations like
 * "TechSmith, Inc." vs "Tech Smith" — this map handles cases where the
 * normalized forms genuinely don't match (AWS vs amazonwebservices).
 */

const VENDOR_ALIASES = [

  // ── Cloud Platforms ───────────────────────────────────────────────────────
  {
    canonical: 'Amazon Web Services',
    aliases: ['AWS', 'Amazon AWS', 'Amazon Cloud', 'Amazon', 'Amazon.com'],
  },
  {
    canonical: 'Google Cloud',
    aliases: ['GCP', 'Google Cloud Platform', 'Google Cloud Services'],
  },
  {
    canonical: 'Microsoft Azure',
    aliases: ['Azure', 'MS Azure', 'Windows Azure'],
  },
  {
    canonical: 'IBM Cloud',
    aliases: ['IBM', 'IBM Corp', 'International Business Machines', 'IBM Corporation'],
  },
  {
    canonical: 'Oracle Cloud',
    aliases: ['OCI', 'Oracle Cloud Infrastructure'],
  },

  // ── Microsoft Ecosystem ───────────────────────────────────────────────────
  {
    canonical: 'Microsoft',
    aliases: ['MSFT', 'MS', 'Microsoft Corp', 'Microsoft Corporation'],
  },
  {
    canonical: 'Microsoft 365',
    aliases: ['M365', 'O365', 'Office 365', 'Office365', 'Microsoft Office 365', 'MS 365'],
  },
  {
    canonical: 'GitHub',
    aliases: ['GitHub Inc', 'Github'],
  },
  {
    canonical: 'LinkedIn',
    aliases: ['LinkedIn Corporation', 'LinkedIn Corp'],
  },
  {
    canonical: 'Nuance',
    aliases: ['Nuance Communications', 'Nuance Communications Inc'],
  },

  // ── Google Ecosystem ──────────────────────────────────────────────────────
  {
    canonical: 'Google',
    aliases: ['Google LLC', 'Alphabet', 'Alphabet Inc', 'Google Inc'],
  },
  {
    canonical: 'Google Workspace',
    aliases: ['G Suite', 'GSuite', 'Google Apps', 'Google Apps for Work', 'Google Apps for Business'],
  },

  // ── Salesforce Ecosystem ──────────────────────────────────────────────────
  {
    canonical: 'Salesforce',
    aliases: ['SFDC', 'Salesforce.com', 'Salesforce Inc', 'Salesforce Corporation'],
  },
  {
    canonical: 'Slack',
    aliases: ['Slack Technologies', 'Slack Inc'],
  },
  {
    canonical: 'Tableau',
    aliases: ['Tableau Software', 'Tableau Inc'],
  },
  {
    canonical: 'MuleSoft',
    aliases: ['Mulesoft Inc', 'Mulesoft'],
  },

  // ── Hardware Vendors with Software ────────────────────────────────────────
  {
    canonical: 'HP Inc',
    aliases: ['HP', 'Hewlett-Packard', 'Hewlett Packard'],
  },
  {
    canonical: 'Hewlett Packard Enterprise',
    aliases: ['HPE', 'HP Enterprise'],
  },
  {
    canonical: 'Dell Technologies',
    aliases: ['Dell', 'Dell Inc', 'Dell EMC', 'EMC', 'EMC Corporation'],
  },
  {
    canonical: 'Lenovo',
    aliases: ['Lenovo Group', 'Lenovo Group Limited'],
  },

  // ── Major Enterprise Software ─────────────────────────────────────────────
  {
    canonical: 'SAP',
    aliases: ['SAP SE', 'SAP America', 'SAP AG'],
  },
  {
    canonical: 'Oracle',
    aliases: ['Oracle Corporation', 'Oracle Corp'],
  },
  {
    canonical: 'VMware',
    aliases: ['VMWare', 'VMware Inc', 'Broadcom VMware'],
  },
  {
    canonical: 'Broadcom',
    aliases: ['Broadcom Inc', 'Broadcom Corp', 'CA Technologies', 'CA Inc', 'CA'],
  },
  {
    canonical: 'OpenText',
    aliases: ['Open Text', 'Open Text Corporation', 'OpenText Corporation'],
  },
  {
    canonical: 'Micro Focus',
    aliases: ['MicroFocus', 'Micro Focus International'],
  },
  {
    canonical: 'Citrix',
    aliases: ['Citrix Systems', 'Citrix Systems Inc', 'Cloud Software Group'],
  },
  {
    canonical: 'Cisco',
    aliases: ['Cisco Systems', 'Cisco Systems Inc'],
  },
  {
    canonical: 'BMC Software',
    aliases: ['BMC', 'BMC Software Inc'],
  },
  {
    canonical: 'ServiceNow',
    aliases: ['Service Now', 'ServiceNow Inc'],
  },

  // ── Security ──────────────────────────────────────────────────────────────
  {
    canonical: 'Palo Alto Networks',
    aliases: ['Palo Alto', 'PANW', 'Palo Alto Networks Inc'],
  },
  {
    canonical: 'CrowdStrike',
    aliases: ['Crowdstrike', 'CrowdStrike Holdings', 'CrowdStrike Inc'],
  },
  {
    canonical: 'Proofpoint',
    aliases: ['Proofpoint Inc'],
  },
  {
    canonical: 'Fortinet',
    aliases: ['Fortinet Inc'],
  },
  {
    canonical: 'Trellix',
    aliases: ['McAfee Enterprise', 'FireEye', 'McAfee', 'Intel Security'],
  },
  {
    canonical: 'Symantec',
    aliases: ['Broadcom Symantec', 'NortonLifeLock', 'Norton'],
  },
  {
    canonical: 'Okta',
    aliases: ['Okta Inc'],
  },
  {
    canonical: 'SailPoint',
    aliases: ['SailPoint Technologies', 'SailPoint Technologies Inc'],
  },
  {
    canonical: 'CyberArk',
    aliases: ['CyberArk Software', 'CyberArk Software Inc'],
  },
  {
    canonical: 'Qualys',
    aliases: ['Qualys Inc'],
  },
  {
    canonical: 'Rapid7',
    aliases: ['Rapid7 Inc'],
  },
  {
    canonical: 'Tenable',
    aliases: ['Tenable Inc', 'Tenable Network Security'],
  },

  // ── Collaboration & Productivity ──────────────────────────────────────────
  {
    canonical: 'Zoom',
    aliases: ['Zoom Video Communications', 'Zoom Video', 'Zoom.us', 'Zoom Inc'],
  },
  {
    canonical: 'Webex',
    aliases: ['Cisco Webex', 'Cisco WebEx'],
  },
  {
    canonical: 'Atlassian',
    aliases: ['Atlassian Corp', 'Atlassian Pty', 'Atlassian Pty Ltd'],
  },
  {
    canonical: 'Jira',
    aliases: ['Atlassian Jira'],
  },
  {
    canonical: 'Confluence',
    aliases: ['Atlassian Confluence'],
  },
  {
    canonical: 'Monday.com',
    aliases: ['Monday', 'Monday com', 'monday.com Inc'],
  },
  {
    canonical: 'Asana',
    aliases: ['Asana Inc'],
  },

  // ── Developer Tools & DevOps ──────────────────────────────────────────────
  {
    canonical: 'GitLab',
    aliases: ['GitLab Inc'],
  },
  {
    canonical: 'JetBrains',
    aliases: ['Jetbrains', 'JetBrains s.r.o.'],
  },
  {
    canonical: 'HashiCorp',
    aliases: ['Hashicorp', 'HashiCorp Inc'],
  },
  {
    canonical: 'Postman',
    aliases: ['Postman Inc'],
  },

  // ── Data, Analytics & Monitoring ─────────────────────────────────────────
  {
    canonical: 'Splunk',
    aliases: ['Splunk Inc', 'Cisco Splunk'],
  },
  {
    canonical: 'Datadog',
    aliases: ['Datadog Inc'],
  },
  {
    canonical: 'New Relic',
    aliases: ['NewRelic', 'New Relic Inc'],
  },
  {
    canonical: 'Snowflake',
    aliases: ['Snowflake Inc', 'Snowflake Computing'],
  },
  {
    canonical: 'Databricks',
    aliases: ['Databricks Inc'],
  },
  {
    canonical: 'Tableau',
    aliases: ['Tableau Software'],
  },
  {
    canonical: 'Qlik',
    aliases: ['QlikTech', 'Qlik Technologies'],
  },
  {
    canonical: 'MicroStrategy',
    aliases: ['Micro Strategy', 'MicroStrategy Inc'],
  },

  // ── Storage & Backup ──────────────────────────────────────────────────────
  {
    canonical: 'Veeam',
    aliases: ['Veeam Software'],
  },
  {
    canonical: 'Commvault',
    aliases: ['CommVault', 'Commvault Systems'],
  },
  {
    canonical: 'Veritas',
    aliases: ['Veritas Technologies', 'Symantec Veritas'],
  },
  {
    canonical: 'Druva',
    aliases: ['Druva Inc'],
  },

  // ── Network & Infrastructure ──────────────────────────────────────────────
  {
    canonical: 'Juniper Networks',
    aliases: ['Juniper', 'Juniper Networks Inc'],
  },
  {
    canonical: 'F5',
    aliases: ['F5 Networks', 'F5 Inc', 'F5 Networks Inc'],
  },
  {
    canonical: 'Zscaler',
    aliases: ['Zscaler Inc'],
  },
  {
    canonical: 'Cloudflare',
    aliases: ['Cloudflare Inc'],
  },
  {
    canonical: 'Akamai',
    aliases: ['Akamai Technologies', 'Akamai Technologies Inc'],
  },

  // ── ITSM & Operations ────────────────────────────────────────────────────
  {
    canonical: 'PagerDuty',
    aliases: ['Pager Duty', 'PagerDuty Inc'],
  },
  {
    canonical: 'Zendesk',
    aliases: ['Zendesk Inc'],
  },
  {
    canonical: 'Freshworks',
    aliases: ['Freshworks Inc', 'Freshdesk'],
  },

  // ── HR & Finance ─────────────────────────────────────────────────────────
  {
    canonical: 'Workday',
    aliases: ['Workday Inc'],
  },
  {
    canonical: 'ADP',
    aliases: ['Automatic Data Processing', 'ADP Inc'],
  },
  {
    canonical: 'Ceridian',
    aliases: ['Ceridian HCM', 'Dayforce'],
  },
  {
    canonical: 'UKG',
    aliases: ['Ultimate Kronos Group', 'Kronos', 'Ultimate Software'],
  },

  // ── Document & Content ───────────────────────────────────────────────────
  {
    canonical: 'Adobe',
    aliases: ['Adobe Inc', 'Adobe Systems', 'Adobe Systems Inc'],
  },
  {
    canonical: 'DocuSign',
    aliases: ['DocuSign Inc'],
  },
  {
    canonical: 'Box',
    aliases: ['Box Inc', 'Box.com'],
  },
  {
    canonical: 'Dropbox',
    aliases: ['Dropbox Inc'],
  },

];

module.exports = VENDOR_ALIASES;

export {};
