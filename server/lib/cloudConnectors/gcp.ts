/**
 * cloudConnectors/gcp.js
 *
 * Google Cloud Marketplace connector -- credential schema, validation,
 * live connectivity test, and purchase data fetch.
 *
 * Data sources:
 *   - Cloud Commerce Consumer Procurement API -- marketplace orders/entitlements
 *   - Cloud Billing API                       -- billing account + service list
 *
 * Auth: Service Account JSON key -> JWT -> OAuth2 access token
 * (all using Node.js built-in crypto -- no googleapis SDK needed)
 *
 * Required IAM roles on the Service Account:
 *   - roles/billing.viewer
 *   - roles/cloudcommerceconsumer.consumerAdmin
 */

const crypto = require('crypto');
const axios  = require('axios');

const FIELDS = [
  {
    key:         'projectId',
    label:       'Project ID',
    type:        'text',
    placeholder: 'my-project-123456',
    help:        'Found in Google Cloud Console -> project selector at the top.',
    required:    true,
  },
  {
    key:         'billingAccountId',
    label:       'Billing Account ID',
    type:        'text',
    placeholder: 'XXXXXX-XXXXXX-XXXXXX',
    help:        'Found in Billing -> Manage Billing Accounts. Format: 6-6-6 alphanumeric groups.',
    required:    true,
  },
  {
    key:         'serviceAccountEmail',
    label:       'Service Account Email',
    type:        'text',
    placeholder: 'lapseiq-reader@my-project-123456.iam.gserviceaccount.com',
    help:        'Found in IAM & Admin -> Service Accounts. Full email ending in .iam.gserviceaccount.com.',
    required:    true,
  },
  {
    key:         'serviceAccountKey',
    label:       'Service Account Private Key (JSON)',
    type:        'textarea',
    // nosemgrep: generic.secrets.security.detected-google-gcm-service-account.detected-google-gcm-service-account
    placeholder: '{\n  "type": "service_account",\n  "project_id": "...",\n  ...\n}',
    help:        'Paste the full contents of the JSON key file from IAM -> Service Accounts -> Keys -> Add Key.',
    required:    true,
  },
];

const SETUP_INSTRUCTIONS = `
To connect Google Cloud Marketplace to LapseIQ:

1. In the Google Cloud Console, open IAM & Admin -> Service Accounts -> Create Service Account.
2. Name the account (e.g. "lapseiq-reader") and click Create.
3. Grant the following roles on the service account:
   - Billing Viewer (roles/billing.viewer)
   - Cloud Commerce Consumer Admin (roles/cloudcommerceconsumer.consumerAdmin)
4. Click Done, then open the service account and go to Keys -> Add Key -> Create new key -> JSON.
5. Download the JSON key file. Open it in a text editor and paste the contents into the field below.
6. Also enter your Project ID and Billing Account ID (found in Billing -> Manage Billing Accounts).

Note: LapseIQ requests read-only access to purchase data. It does not create
or cancel any subscriptions on your behalf.
`.trim();

function validateCredentials(creds: any = {}) {
  if (!creds.projectId?.trim()) return { ok: false, error: 'Project ID is required.' };
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(creds.projectId.trim())) {
    return { ok: false, error: 'Project ID format looks wrong -- lowercase letters, numbers, and hyphens, 6-30 characters.' };
  }
  if (!creds.billingAccountId?.trim()) return { ok: false, error: 'Billing Account ID is required.' };
  if (!/^[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$/.test(creds.billingAccountId.trim().toUpperCase())) {
    return { ok: false, error: 'Billing Account ID format looks wrong -- expected XXXXXX-XXXXXX-XXXXXX.' };
  }
  if (!creds.serviceAccountEmail?.trim()) return { ok: false, error: 'Service Account Email is required.' };
  if (!creds.serviceAccountEmail.trim().endsWith('.iam.gserviceaccount.com')) {
    return { ok: false, error: 'Service Account Email should end with .iam.gserviceaccount.com.' };
  }
  if (!creds.serviceAccountKey?.trim()) return { ok: false, error: 'Service Account Private Key (JSON) is required.' };
  try {
    const parsed = JSON.parse(creds.serviceAccountKey.trim());
    if (parsed.type !== 'service_account') {
      return { ok: false, error: 'The JSON key does not look like a service account key -- "type" should be "service_account".' };
    }
    if (!parsed.private_key || !parsed.client_email) {
      return { ok: false, error: 'The JSON key is missing required fields (private_key or client_email).' };
    }
  } catch {
    return { ok: false, error: 'Service Account Key must be valid JSON. Paste the complete contents of the .json key file.' };
  }
  return { ok: true };
}

// ── JWT / OAuth2 helpers ──────────────────────────────────────────────────────

/**
 * Create a signed JWT for Google OAuth2 token exchange.
 * Uses RS256 (RSA-SHA256) with the service account private key.
 */
function _createServiceAccountJwt(serviceAccountKey, scope) {
  const keyObj   = JSON.parse(serviceAccountKey);
  // JSON key files store the private key with literal \n sequences.
  // Whether Prisma/JSON round-trips preserve or double-escape them varies,
  // so normalise to real newlines before passing to crypto.createSign.
  keyObj.private_key = (keyObj.private_key || '').replace(/\\n/g, '\n');
  const now      = Math.floor(Date.now() / 1000);
  const expiry   = now + 3600; // 1 hour

  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss:   keyObj.client_email,
    sub:   keyObj.client_email,
    aud:   'https://oauth2.googleapis.com/token',
    scope,
    iat:   now,
    exp:   expiry,
  })).toString('base64url');

  const sigInput  = `${header}.${payload}`;
  // Parse the PEM private key and sign with RS256
  const sign      = crypto.createSign('SHA256');
  sign.update(sigInput);
  sign.end();
  const signature = sign.sign(keyObj.private_key, 'base64url');

  return `${sigInput}.${signature}`;
}

/**
 * Exchange a signed JWT for a Google OAuth2 access token.
 */
async function _getAccessToken(creds, scope = 'https://www.googleapis.com/auth/cloud-platform') {
  let jwt;
  try {
    jwt = _createServiceAccountJwt(creds.serviceAccountKey.trim(), scope);
  } catch (err) {
    throw new Error(`Failed to create service account JWT: ${err.message}`);
  }

  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion:  jwt,
  });

  try {
    const resp = await axios.post('https://oauth2.googleapis.com/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    if (!resp.data?.access_token) throw new Error('Response missing access_token');
    return resp.data.access_token;
  } catch (err) {
    throw new Error(_gcpErrorMessage(err, 'Token exchange failed'));
  }
}

// ── testConnection ────────────────────────────────────────────────────────────

/**
 * Validates GCP credentials: JWT creation + token exchange + billing account read.
 * @returns {{ ok: boolean, message?: string, error?: string }}
 */
async function testConnection(creds) {
  let token;
  try {
    token = await _getAccessToken(creds);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // Verify billing account access
  const billingId = creds.billingAccountId.trim().toUpperCase();
  try {
    const resp = await axios.get(
      `https://cloudbilling.googleapis.com/v1/billingAccounts/${billingId}`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    const account = resp.data;
    return {
      ok:      true,
      message: `Connected to billing account "${account.displayName || billingId}" (${account.open ? 'open' : 'closed'})`,
    };
  } catch (err) {
    if (err.response?.status === 403) {
      return { ok: false, error: 'Access denied to the billing account. Ensure the service account has the Billing Viewer role.' };
    }
    if (err.response?.status === 404) {
      return { ok: false, error: `Billing account ${billingId} not found. Check the Billing Account ID.` };
    }
    return { ok: false, error: _gcpErrorMessage(err, 'Billing account check failed') };
  }
}

// ── fetchPurchases ────────────────────────────────────────────────────────────

/**
 * Fetch GCP Marketplace orders via Cloud Commerce Consumer Procurement API.
 * Falls back to Cloud Billing services list if procurement API is unavailable.
 *
 * @returns {Promise<Array<NormalizedPurchase>>}
 */
async function fetchPurchases(creds) {
  let token;
  try {
    token = await _getAccessToken(creds);
  } catch (err) {
    throw new Error(`GCP auth failed: ${err.message}`);
  }

  const billingId = creds.billingAccountId.trim().toUpperCase();

  // ── Try Cloud Commerce Consumer Procurement API ───────────────────────────
  try {
    const orders = await _fetchProcurementOrders(token, billingId);
    if (orders.length > 0) return orders;
  } catch (err) {
    console.warn('[gcp-connector] Procurement API failed, falling back to billing services:', err.message);
  }

  // ── Fallback: Billing API services ───────────────────────────────────────
  return _fetchBillingServices(token, billingId, creds.projectId?.trim());
}

/**
 * Fetch orders from Cloud Commerce Consumer Procurement API.
 */
async function _fetchProcurementOrders(token, billingId) {
  // The account name format for the procurement API
  const accountName = `billingAccounts/${billingId}`;
  const results = [];
  let pageToken = null;

  do {
    const url = new URL(`https://cloudcommerceprocurement.googleapis.com/v1/${accountName}/orders`);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    let resp;
    try {
      resp = await axios.get(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 20000,
      });
    } catch (err) {
      throw new Error(_gcpErrorMessage(err, 'Procurement API'));
    }

    const orders = resp.data?.orders ?? [];
    pageToken = resp.data?.nextPageToken ?? null;

    for (const order of orders) {
      const normalized = _normalizeProcurementOrder(order, billingId);
      if (normalized) results.push(normalized);
    }
  } while (pageToken);

  return results;
}

function _normalizeProcurementOrder(order, billingId) {
  if (!order?.name) return null;

  // name format: billingAccounts/{billing_id}/orders/{order_id}
  const orderId = order.name.split('/').pop();

  const lineItems = order.lineItems ?? [];
  const firstItem = lineItems[0] ?? {};

  // Product name: from lineItem productExternalName or displayName
  const productName = firstItem?.productExternalName?.split('/')?.pop()?.replace(/-/g, ' ')
    || order.displayName
    || orderId;

  // Subscription period from line item
  const period    = firstItem?.subscriptionPeriod ?? {};
  const startDate = _parseDate(period.startTime);
  const endDate   = _parseDate(period.endTime);

  // State mapping
  const state  = (order.state || '').toLowerCase();
  const status = _mapOrderState(state);

  // License info -- GCP entitlements may include license keys in params
  const licenseKeys = _extractGcpLicenseKeys(order);

  return {
    externalId:     `gcp-${billingId}-${orderId}`,
    vendorName:     'Google Cloud',
    productName:    _toTitleCase(productName),
    contractNumber: orderId,
    poNumber:       null,
    licenseKeys,
    quantity:       firstItem?.quantity ?? null,
    unitPrice:      null,
    totalValue:     null,  // pricing comes from billing export, not procurement API
    currency:       'USD',
    startDate,
    endDate,
    status,
    autoRenewal:    order.billingAccount != null, // if billed to an account, auto-renewal is typical
    notes:          `GCP Marketplace order ${orderId}. Account: billingAccounts/${billingId}. Products: ${lineItems.map(li => li.productExternalName || '').filter(Boolean).join(', ')}`,
    syncSource:     'gcp',
  };
}

/**
 * Fallback: list Cloud Billing services linked to the billing account.
 * Creates one record per service that has any usage.
 */
async function _fetchBillingServices(token, billingId, projectId) {
  const results = [];

  // Get project billing info first (simpler access model)
  if (projectId) {
    try {
      const resp = await axios.get(
        `https://cloudbilling.googleapis.com/v1/projects/${projectId}/billingInfo`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      );
      const info = resp.data;
      if (info.billingEnabled) {
        results.push({
          externalId:     `gcp-billing-${billingId}-${projectId}`,
          vendorName:     'Google Cloud',
          productName:    `GCP Project: ${info.projectId || projectId}`,
          contractNumber: billingId,
          poNumber:       null,
          licenseKeys:    null,
          quantity:       null,
          unitPrice:      null,
          totalValue:     null,
          currency:       'USD',
          startDate:      null,
          endDate:        null,
          status:         'active',
          autoRenewal:    true,
          notes:          `GCP project ${info.projectId} linked to billing account ${billingId}. Enable Procurement API (cloudcommerceprocurement.googleapis.com) for full order details.`,
          syncSource:     'gcp',
        });
      }
    } catch (err) {
      console.warn('[gcp-connector] Project billing info fetch failed:', err.message);
    }
  }

  // List enabled services on the billing account (gives marketplace subscriptions)
  try {
    const resp = await axios.get(
      `https://cloudbilling.googleapis.com/v1/billingAccounts/${billingId}/services`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params:  { pageSize: 50 },
        timeout: 20000,
      }
    );
    const services = (resp.data?.services ?? []).filter(s =>
      // Filter to only 3rd party / marketplace services (not core GCP infrastructure)
      s.displayName && !s.displayName.match(/^(Google Cloud|Compute Engine|Cloud Storage|BigQuery|Kubernetes|Cloud SQL|App Engine|Cloud Functions)/i)
    );

    for (const svc of services) {
      const svcId = svc.name?.split('/')?.pop() ?? svc.serviceId;
      if (!svcId) continue;
      results.push({
        externalId:     `gcp-svc-${billingId}-${svcId}`,
        vendorName:     'Google Cloud',
        productName:    svc.displayName || svcId,
        contractNumber: svcId,
        poNumber:       null,
        licenseKeys:    null,
        quantity:       null,
        unitPrice:      null,
        totalValue:     null,
        currency:       'USD',
        startDate:      null,
        endDate:        null,
        status:         'active',
        autoRenewal:    true,
        notes:          `GCP Marketplace service ${svcId} enabled on billing account ${billingId}.`,
        syncSource:     'gcp',
      });
    }
  } catch (err) {
    console.warn('[gcp-connector] Billing services list failed:', err.message);
  }

  return results;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _parseDate(str) {
  if (!str) return null;
  try {
    // GCP uses RFC3339 with nanoseconds -- truncate to milliseconds
    const cleaned = str.replace(/(\.\d{3})\d+/, '$1');
    const d = new Date(cleaned);
    return isNaN(d.getTime()) ? null : d;
  } catch { return null; }
}

function _mapOrderState(state) {
  return {
    order_state_active:    'active',
    active:                'active',
    order_state_cancelled: 'cancelled',
    cancelled:             'cancelled',
    order_state_complete:  'renewed',
    complete:              'renewed',
    order_state_pending:   'under_review',
    pending:               'under_review',
  }[state] ?? 'active';
}

function _extractGcpLicenseKeys(order) {
  const keys = [];

  // 1. Line item parameters — { paramName: { stringValue: "..." } }
  for (const item of (order.lineItems ?? [])) {
    const params: any = item?.parameters ?? {};
    for (const [k, v] of Object.entries<any>(params)) {
      if (/key|license|token/i.test(k) && v?.stringValue) {
        keys.push(`${k}: ${v.stringValue}`);
      }
    }

    // 2. Line item entitlementIds — simple string array
    for (const eid of (item?.entitlementIds ?? [])) {
      if (eid && typeof eid === 'string') keys.push(`Entitlement: ${eid}`);
    }

    // 3. Line item entitlements array (alternate schema)
    for (const ent of (item?.entitlements ?? [])) {
      const val = ent?.name || ent?.entitlementId || ent?.id;
      if (val) keys.push(`Entitlement: ${val}`);
    }
  }

  // 4. Top-level order.entitlements (some API versions surface it here)
  for (const ent of (order.entitlements ?? [])) {
    const val = ent?.name || ent?.entitlementId || ent?.id;
    if (val) keys.push(`Entitlement: ${val}`);
  }

  // De-duplicate and return
  const unique = [...new Set(keys)];
  return unique.length > 0 ? unique.join('\n') : null;
}

function _toTitleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

function _gcpErrorMessage(err, prefix = '') {
  const pre = prefix ? `${prefix}: ` : '';
  if (err.response?.data?.error) {
    const e = err.response.data.error;
    return `${pre}${e.message || e.status || 'GCP API error'}`;
  }
  if (err.response?.status === 401) return `${pre}Unauthorized -- check service account credentials.`;
  if (err.response?.status === 403) return `${pre}Permission denied -- ensure the service account has Billing Viewer and Cloud Commerce Consumer Admin roles.`;
  if (err.code === 'ENOTFOUND')     return `${pre}Could not reach Google Cloud. Check your network connection.`;
  return `${pre}${err.message || 'Unknown GCP error'}`;
}

module.exports = { FIELDS, SETUP_INSTRUCTIONS, validateCredentials, testConnection, fetchPurchases };

export {};
