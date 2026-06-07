/**
 * cloudConnectors/azure.js
 *
 * Microsoft Azure Marketplace connector -- credential schema, validation,
 * live connectivity test, and purchase data fetch.
 *
 * Data sources:
 *   - Azure Cost Management REST API  -- marketplace charges grouped by product
 *   - Azure Billing REST API          -- marketplace purchase history
 *
 * Auth: OAuth2 client credentials flow (App Registration + Client Secret).
 *
 * Required Azure AD permissions (App Registration):
 *   - Billing Reader role on the Subscription
 *   - Reader role is sufficient for Cost Management queries
 *
 * Setup: Create an App Registration in Azure AD, create a client secret,
 * and assign the Billing Reader role on the relevant subscription(s).
 */

const axios = require('axios');

const FIELDS = [
  {
    key:         'tenantId',
    label:       'Tenant ID (Directory ID)',
    type:        'text',
    placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    help:        'Found in Azure Active Directory -> Overview -> Directory (tenant) ID.',
    required:    true,
  },
  {
    key:         'clientId',
    label:       'Client ID (Application ID)',
    type:        'text',
    placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    help:        'Found in Azure AD -> App Registrations -> your app -> Application (client) ID.',
    required:    true,
  },
  {
    key:         'clientSecret',
    label:       'Client Secret',
    type:        'password',
    placeholder: 'Your application client secret value',
    help:        'Created under App Registrations -> your app -> Certificates & Secrets. Copy the Value, not the Secret ID.',
    required:    true,
  },
  {
    key:         'subscriptionId',
    label:       'Subscription ID',
    type:        'text',
    placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    help:        'Found in Azure Portal -> Subscriptions. The ID of the subscription whose Marketplace purchases you want to import.',
    required:    true,
  },
];

const SETUP_INSTRUCTIONS = `
To connect Azure Marketplace to LapseIQ:

1. In the Azure Portal, open Azure Active Directory -> App Registrations -> New Registration.
2. Name the app (e.g. "LapseIQ Connector"), choose "Accounts in this organizational directory only," and register.
3. Copy the Application (client) ID and Directory (tenant) ID from the Overview page.
4. Go to Certificates & Secrets -> New Client Secret. Set an expiry and copy the generated Value immediately.
5. Open Subscriptions, select your target subscription, and go to Access Control (IAM) -> Add role assignment.
6. Assign the "Billing Reader" role to the app registration you created.
7. Paste the Tenant ID, Client ID, Client Secret, and Subscription ID below.

Note: LapseIQ requests read-only access to billing data only. It does not purchase
or cancel any subscriptions on your behalf.
`.trim();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateCredentials(creds: any = {}) {
  if (!creds.tenantId?.trim())       return { ok: false, error: 'Tenant ID is required.' };
  if (!UUID_RE.test(creds.tenantId.trim())) return { ok: false, error: 'Tenant ID must be a valid UUID.' };
  if (!creds.clientId?.trim())       return { ok: false, error: 'Client ID is required.' };
  if (!UUID_RE.test(creds.clientId.trim())) return { ok: false, error: 'Client ID must be a valid UUID.' };
  if (!creds.clientSecret?.trim())   return { ok: false, error: 'Client Secret is required.' };
  if (creds.clientSecret.trim().length < 8) return { ok: false, error: 'Client Secret looks too short -- paste the full secret value.' };
  if (!creds.subscriptionId?.trim()) return { ok: false, error: 'Subscription ID is required.' };
  if (!UUID_RE.test(creds.subscriptionId.trim())) return { ok: false, error: 'Subscription ID must be a valid UUID.' };
  return { ok: true };
}

// ── OAuth2 token fetch ────────────────────────────────────────────────────────

async function _getAccessToken(creds) {
  const url = `https://login.microsoftonline.com/${creds.tenantId.trim()}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     creds.clientId.trim(),
    client_secret: creds.clientSecret.trim(),
    scope:         'https://management.azure.com/.default',
  });

  try {
    const resp = await axios.post(url, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    if (!resp.data?.access_token) {
      throw new Error('Token response missing access_token');
    }
    return resp.data.access_token;
  } catch (err) {
    throw new Error(_azureErrorMessage(err, 'Token fetch failed'));
  }
}

// ── testConnection ────────────────────────────────────────────────────────────

/**
 * Validates credentials via OAuth2 token fetch + subscription access check.
 * @returns {{ ok: boolean, message?: string, error?: string }}
 */
async function testConnection(creds) {
  let token;
  try {
    token = await _getAccessToken(creds);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // Verify we can read the target subscription
  try {
    const subId = creds.subscriptionId.trim();
    const resp = await axios.get(
      `https://management.azure.com/subscriptions/${subId}?api-version=2020-01-01`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    const sub = resp.data;
    return {
      ok:      true,
      message: `Connected to subscription "${sub.displayName || subId}" (${sub.state || 'active'})`,
    };
  } catch (err) {
    if (err.response?.status === 404) {
      return { ok: false, error: `Subscription ${creds.subscriptionId} not found. Check the Subscription ID.` };
    }
    if (err.response?.status === 403) {
      return { ok: false, error: 'Access denied to the subscription. Assign the Billing Reader role to the App Registration.' };
    }
    return { ok: false, error: _azureErrorMessage(err, 'Subscription access check failed') };
  }
}

// ── fetchPurchases ────────────────────────────────────────────────────────────

/**
 * Fetch Azure Marketplace purchase data via Cost Management query API.
 * Groups charges by PublisherName + ProductName over the past 12 months.
 *
 * @returns {Promise<Array<NormalizedPurchase>>}
 */
async function fetchPurchases(creds) {
  let token;
  try {
    token = await _getAccessToken(creds);
  } catch (err) {
    throw new Error(`Azure auth failed: ${err.message}`);
  }

  const subId = creds.subscriptionId.trim();

  // ── Try Cost Management API ───────────────────────────────────────────────
  const now       = new Date();
  const startDate = new Date(now);
  startDate.setMonth(startDate.getMonth() - 12);

  const queryBody = {
    type:      'Usage',
    timeframe: 'Custom',
    timePeriod: {
      from: startDate.toISOString().slice(0, 10) + 'T00:00:00+00:00',
      to:   now.toISOString().slice(0, 10)       + 'T23:59:59+00:00',
    },
    dataset: {
      granularity: 'None',
      filter: {
        dimensions: {
          name:     'PublisherType',
          operator: 'In',
          values:   ['Marketplace'],
        },
      },
      grouping: [
        { type: 'Dimension', name: 'ServiceName' },
        { type: 'Dimension', name: 'PublisherName' },
        { type: 'Dimension', name: 'MeterCategory' },
      ],
      aggregation: {
        totalCost: { name: 'PreTaxCost', function: 'Sum' },
      },
    },
  };

  let costData;
  try {
    const resp = await axios.post(
      `https://management.azure.com/subscriptions/${subId}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`,
      queryBody,
      {
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
    costData = resp.data;
  } catch (err) {
    // Fall back to marketplace orders API if Cost Management is unavailable
    console.warn('[azure-connector] Cost Management query failed, trying marketplace orders:', _azureErrorMessage(err));
    return _fetchMarketplaceOrders(token, subId, startDate, now);
  }

  return _normalizeCostManagementData(costData, subId, startDate, now);
}

/**
 * Parse Cost Management query response into normalized purchase records.
 */
function _normalizeCostManagementData(data, subId, startDate, endDate) {
  const rows    = data?.properties?.rows ?? [];
  const columns = data?.properties?.columns ?? [];

  // Map column names to indices
  const colIdx: any = {};
  columns.forEach((col, i) => { colIdx[col.name] = i; });

  const results = [];
  for (const row of rows) {
    const totalCost    = parseFloat(row[colIdx.PreTaxCost]   ?? row[0] ?? 0);
    const currency     = row[colIdx.Currency]                ?? 'USD';
    const serviceName  = row[colIdx.ServiceName]             ?? row[colIdx.MeterCategory] ?? 'Unknown Service';
    const publisherName= row[colIdx.PublisherName]           ?? 'Unknown Publisher';

    if (totalCost <= 0) continue;

    const extId = `azure-${subId}-${publisherName}-${serviceName}`
      .replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').slice(0, 128);

    results.push({
      externalId:     extId,
      vendorName:     publisherName,
      productName:    serviceName,
      contractNumber: null,
      poNumber:       null,
      licenseKeys:    null,
      quantity:       null,
      unitPrice:      null,
      totalValue:     Math.round(totalCost * 100) / 100,
      currency,
      startDate,
      endDate,
      status:         'active',
      autoRenewal:    false,
      notes:          `Imported from Azure Cost Management. Marketplace spend over the past 12 months on subscription ${subId}.`,
      syncSource:     'azure',
    });
  }
  return results;
}

/**
 * Fallback: fetch marketplace orders from Azure Billing (legacy API).
 */
async function _fetchMarketplaceOrders(token, subId, startDate, endDate) {
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr   = endDate.toISOString().slice(0, 10);

  let resp;
  try {
    resp = await axios.get(
      `https://management.azure.com/subscriptions/${subId}/providers/Microsoft.Billing/billingPeriods?api-version=2018-03-01-preview`,
      {
        headers:  { Authorization: `Bearer ${token}` },
        timeout:  20000,
      }
    );
  } catch (err) {
    throw new Error(`Azure Marketplace fetch failed: ${_azureErrorMessage(err)}`);
  }

  // Parse billing periods and build one record per period with marketplace spend
  const periods  = resp.data?.value ?? [];
  const results  = [];
  const seen     = new Set();

  for (const period of periods.slice(0, 12)) {
    const periodName  = period.name;
    const periodStart = _parseDate(period.properties?.billingPeriodStartDate);
    const periodEnd   = _parseDate(period.properties?.billingPeriodEndDate);
    if (!periodStart || periodStart < startDate) continue;

    const key = `azure-billing-${subId}-${periodName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      externalId:     key,
      vendorName:     'Microsoft Azure',
      productName:    `Azure Marketplace (${periodName})`,
      contractNumber: periodName,
      poNumber:       null,
      licenseKeys:    null,
      quantity:       null,
      unitPrice:      null,
      totalValue:     null,  // can't get amount without drilling into usage detail
      currency:       'USD',
      startDate:      periodStart,
      endDate:        periodEnd,
      status:         'active',
      autoRenewal:    false,
      notes:          `Azure billing period ${periodName}. Run a Cost Management export for itemized marketplace spend.`,
      syncSource:     'azure',
    });
  }
  return results;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _parseDate(str) {
  if (!str) return null;
  try { const d = new Date(str); return isNaN(d.getTime()) ? null : d; } catch { return null; }
}

function _azureErrorMessage(err, prefix = '') {
  const pre = prefix ? `${prefix}: ` : '';
  if (err.response?.data) {
    const d = err.response.data;
    const msg = d?.error?.message || d?.error_description || d?.message;
    if (msg) return `${pre}${msg}`;
    const code = d?.error?.code || d?.error;
    if (code) return `${pre}Azure error ${code}`;
  }
  if (err.response?.status === 401) return `${pre}Unauthorized -- check Tenant ID, Client ID, and Client Secret.`;
  if (err.response?.status === 403) return `${pre}Forbidden -- the App Registration may be missing the Billing Reader role.`;
  if (err.code === 'ENOTFOUND')     return `${pre}Could not reach Azure. Check your network connection.`;
  return `${pre}${err.message || 'Unknown Azure error'}`;
}

module.exports = { FIELDS, SETUP_INSTRUCTIONS, validateCredentials, testConnection, fetchPurchases };

export {};
