/**
 * cloudConnectors/aws.js
 *
 * AWS Marketplace connector — credential schema, validation, live connectivity
 * test, and purchase data fetch.
 *
 * Data sources:
 *   1. AWS Marketplace Catalog API  — agreement entities (subscriptions)
 *   2. AWS Cost Explorer API        — spend data per marketplace service (fallback)
 *   3. AWS STS                      — identity / connectivity check
 *
 * Required IAM permissions:
 *   - sts:GetCallerIdentity            (connectivity test)
 *   - aws-marketplace:ListEntities     (list agreements)
 *   - aws-marketplace:DescribeEntity   (agreement detail)
 *   - ce:GetCostAndUsage               (spend data / fallback)
 */

const axios = require('axios');
const { signAwsRequest } = require('../awsSigV4');

const VALID_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2',
  'ap-south-1', 'ca-central-1', 'sa-east-1',
];

const FIELDS = [
  {
    key:         'accessKeyId',
    label:       'Access Key ID',
    type:        'text',
    placeholder: 'AKIAIOSFODNN7EXAMPLE',
    help:        'Found in IAM -> Users -> Security credentials. Starts with AKIA.',
    required:    true,
  },
  {
    key:         'secretAccessKey',
    label:       'Secret Access Key',
    type:        'password',
    placeholder: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    help:        'The secret associated with the Access Key ID. Only shown once when created.',
    required:    true,
  },
  {
    key:         'accountId',
    label:       'AWS Account ID',
    type:        'text',
    placeholder: '123456789012',
    help:        '12-digit number shown in the top-right of the AWS console.',
    required:    true,
  },
  {
    key:         'region',
    label:       'Region',
    type:        'select',
    options:     VALID_REGIONS,
    default:     'us-east-1',
    help:        'The AWS region where your Marketplace subscriptions are managed.',
    required:    true,
  },
];

const SETUP_INSTRUCTIONS = `
To connect AWS Marketplace to LapseIQ:

1. Open the AWS Console and navigate to IAM -> Users -> Create user.
2. Name the user (e.g. "lapseiq-marketplace-reader") and select "Programmatic access."
3. Attach a custom policy with these permissions:
   {
     "Version": "2012-10-17",
     "Statement": [{ "Effect": "Allow", "Action": [
       "sts:GetCallerIdentity",
       "aws-marketplace:ListEntities",
       "aws-marketplace:DescribeEntity",
       "ce:GetCostAndUsage",
       "license-manager:ListReceivedLicenses"
     ], "Resource": "*" }]
   }
4. Complete the user creation and copy the Access Key ID and Secret Access Key.
5. Paste both values below along with your 12-digit AWS Account ID.

Note: LapseIQ only reads your purchase data. It does not modify or cancel any
subscriptions on your behalf.
`.trim();

function validateCredentials(creds: any = {}) {
  if (!creds.accessKeyId?.trim()) return { ok: false, error: 'Access Key ID is required.' };
  if (!/^AKIA[0-9A-Z]{16}$/.test(creds.accessKeyId.trim())) {
    return { ok: false, error: 'Access Key ID format looks wrong -- it should start with AKIA and be 20 characters.' };
  }
  if (!creds.secretAccessKey?.trim()) return { ok: false, error: 'Secret Access Key is required.' };
  if (creds.secretAccessKey.trim().length < 20) return { ok: false, error: 'Secret Access Key looks too short.' };
  if (!creds.accountId?.trim()) return { ok: false, error: 'AWS Account ID is required.' };
  if (!/^\d{12}$/.test(creds.accountId.replace(/[-\s]/g, ''))) {
    return { ok: false, error: 'AWS Account ID must be a 12-digit number.' };
  }
  if (creds.region && !VALID_REGIONS.includes(creds.region)) {
    return { ok: false, error: `"${creds.region}" is not a recognised AWS region.` };
  }
  return { ok: true };
}

// ── Internal HTTP helpers ─────────────────────────────────────────────────────

function _creds(c) {
  return { accessKeyId: c.accessKeyId.trim(), secretAccessKey: c.secretAccessKey.trim() };
}

async function _awsPost({ host, path, service, region, body, target, creds }: any) {
  const bodyStr = JSON.stringify(body);
  const extra = target ? { 'x-amz-target': target } : {};
  const { headers } = signAwsRequest({
    method:      'POST',
    host,
    path,
    body:        bodyStr,
    headers:     { 'content-type': 'application/x-amz-json-1.1', ...extra },
    credentials: _creds(creds),
    service,
    region,
  });
  const resp = await axios.post(`https://${host}${path}`, bodyStr, { headers, timeout: 20000 });
  return resp.data;
}

async function _awsQuery({ host, service, region, params, creds }: any) {
  const body = Object.entries<any>(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const { headers } = signAwsRequest({
    method:      'POST',
    host,
    path:        '/',
    body,
    headers:     { 'content-type': 'application/x-www-form-urlencoded' },
    credentials: _creds(creds),
    service,
    region,
  });
  const resp = await axios.post(`https://${host}/`, body, { headers, timeout: 15000 });
  return resp.data;
}

// ── testConnection ────────────────────────────────────────────────────────────

async function testConnection(creds) {
  try {
    const data = await _awsQuery({
      host:    'sts.amazonaws.com',
      service: 'sts',
      region:  'us-east-1',
      params:  { Action: 'GetCallerIdentity', Version: '2011-06-15' },
      creds,
    });

    const xmlStr = typeof data === 'string' ? data : JSON.stringify(data);
    const accountMatch = xmlStr.match(/<Account>(\d{12})<\/Account>/);
    if (!accountMatch) {
      return { ok: false, error: 'AWS returned an unexpected response. Check credentials and try again.' };
    }

    const returnedAccountId = accountMatch[1];
    const storedAccountId   = creds.accountId.replace(/[-\s]/g, '');
    if (returnedAccountId !== storedAccountId) {
      return {
        ok:    false,
        error: `Credentials are valid but belong to AWS account ${returnedAccountId}, not ${storedAccountId}. Update the Account ID field.`,
      };
    }

    const arnMatch = xmlStr.match(/<Arn>(.*?)<\/Arn>/);
    const arn = arnMatch ? arnMatch[1] : returnedAccountId;
    return { ok: true, message: `Connected as ${arn}` };
  } catch (err) {
    return { ok: false, error: _awsErrorMessage(err) };
  }
}

// ── fetchPurchases ────────────────────────────────────────────────────────────

async function fetchPurchases(creds) {
  const region = creds.region || 'us-east-1';

  // Try Marketplace Catalog API first (returns real agreement contracts)
  let agreements = [];
  try {
    agreements = await _fetchMarketplaceAgreements(creds, region);
  } catch (err) {
    console.warn('[aws-connector] Marketplace Catalog API failed, falling back to Cost Explorer:', err.message);
  }

  if (agreements.length > 0) {
    // Enrich with License Manager entitlements (best-effort, non-fatal)
    try {
      const licKeyMap = await _fetchLicenseManagerKeys(creds, region);
      if (Object.keys(licKeyMap).length > 0) {
        for (const rec of agreements) {
          if (!rec.licenseKeys) {
            const matchedSku = Object.keys(licKeyMap).find(sku =>
              rec.productName?.toLowerCase().includes(sku.toLowerCase()) ||
              sku.toLowerCase().includes((rec.productName || '').toLowerCase())
            );
            if (matchedSku) rec.licenseKeys = licKeyMap[matchedSku];
          }
        }
      }
    } catch (err) {
      console.warn('[aws-connector] License Manager enrichment failed (non-fatal):', err.message);
    }
    return agreements;
  }

  // Fallback: Cost Explorer spend data
  console.info('[aws-connector] No marketplace agreements found; using Cost Explorer');
  return _fetchCostExplorerPurchases(creds);
}

async function _fetchMarketplaceAgreements(creds, region) {
  const results = [];
  let nextToken = null;

  do {
    const body: any = { Catalog: 'AWSMarketplace', EntityType: 'Agreement', MaxResults: 20 };
    if (nextToken) body.NextToken = nextToken;

    // Marketplace Catalog is always accessed from us-east-1 endpoint regardless of region
    let listResp;
    try {
      listResp = await _awsPost({
        host:    'catalog.marketplace.us-east-1.amazonaws.com',
        path:    '/v1/catalog/2018-08-01/ListEntities',
        service: 'aws-marketplace',
        region:  'us-east-1',
        body,
        creds,
      });
    } catch (err) {
      throw new Error(`ListEntities failed: ${_awsErrorMessage(err)}`);
    }

    const entities = listResp?.EntitySummaryList ?? [];
    nextToken = listResp?.NextToken ?? null;

    for (const entity of entities) {
      try {
        const detail = await _describeAgreement(creds, entity.EntityId);
        const record = _normalizeAgreement(entity, detail);
        if (record) results.push(record);
      } catch (descErr) {
        console.warn(`[aws-connector] DescribeEntity ${entity.EntityId} failed:`, descErr.message);
        results.push({
          externalId:     entity.EntityId,
          vendorName:     'Amazon Web Services',
          productName:    entity.Name || entity.EntityId,
          contractNumber: entity.EntityId,
          poNumber:       null,
          licenseKeys:    null,
          quantity:       null,
          unitPrice:      null,
          totalValue:     null,
          currency:       'USD',
          startDate:      null,
          endDate:        null,
          status:         'active',
          autoRenewal:    false,
          notes:          `AWS Marketplace agreement (detail unavailable). ARN: ${entity.EntityArn || ''}`,
          syncSource:     'aws',
        });
      }
    }
  } while (nextToken);

  return results;
}

async function _describeAgreement(creds, entityId) {
  return _awsPost({
    host:    'catalog.marketplace.us-east-1.amazonaws.com',
    path:    '/v1/catalog/2018-08-01/DescribeEntity',
    service: 'aws-marketplace',
    region:  'us-east-1',
    body:    { Catalog: 'AWSMarketplace', EntityId: entityId },
    creds,
  });
}

function _normalizeAgreement(summary, detail) {
  if (!summary?.EntityId) return null;

  let details: any = {};
  try { details = typeof detail?.Details === 'string' ? JSON.parse(detail.Details) : (detail?.Details ?? {}); } catch {}

  const proposal  = details?.ProposalSummary ?? {};
  const agreement = details?.Agreement ?? {};
  const financial = details?.FinancialDocument ?? {};
  const products  = proposal?.Products ?? [];

  const productName = products[0]?.ProductTitle || summary.Name || summary.EntityId;
  const licenseKeys = _extractLicenseKeys(details);

  return {
    externalId:     summary.EntityId,
    vendorName:     'Amazon Web Services',
    productName,
    contractNumber: summary.EntityId,
    poNumber:       null,
    licenseKeys,
    quantity:       null,
    unitPrice:      null,
    totalValue:     financial?.TotalAmount ? parseFloat(financial.TotalAmount) : null,
    currency:       financial?.CurrencyCode || 'USD',
    startDate:      _parseDate(agreement.StartDate || agreement.AcceptedDate),
    endDate:        _parseDate(agreement.EndDate),
    status:         _mapAgreementStatus((agreement.Status || '').toLowerCase()),
    autoRenewal:    false,
    notes:          `AWS Marketplace agreement. Products: ${products.map(p => p.ProductId).join(', ')}`,
    syncSource:     'aws',
  };
}

// ── License Manager entitlement keys ─────────────────────────────────────────

/**
 * Calls ListReceivedLicenses on the AWS License Manager API and returns a map
 * of { productSKU/productName -> licenseKey string }.  Non-fatal — callers
 * should catch errors and proceed without enrichment.
 */
async function _fetchLicenseManagerKeys(creds, region) {
  const keyMap = {};
  let nextToken = null;

  do {
    const body: any = { MaxResults: 100 };
    if (nextToken) body.NextToken = nextToken;

    let resp;
    try {
      resp = await _awsPost({
        host:    `license-manager.${region}.amazonaws.com`,
        path:    '/',
        service: 'license-manager',
        region,
        body,
        target:  'AWSLicenseManager.ListReceivedLicenses',
        creds,
      });
    } catch (err) {
      // License Manager may not be available in all regions — not fatal
      console.warn('[aws-connector] License Manager ListReceivedLicenses failed:', err.message);
      break;
    }

    nextToken = resp?.NextToken ?? null;

    for (const lic of (resp?.Licenses ?? [])) {
      const sku = lic.ProductSKU || lic.ProductName;
      if (!sku) continue;

      const entitlements = (lic.Entitlements ?? [])
        .map(e => {
          const parts = [e.Name, e.Value].filter(Boolean);
          return parts.join(': ');
        })
        .filter(Boolean);

      // Also surface the license ARN as a fallback key
      if (entitlements.length === 0 && lic.LicenseArn) {
        entitlements.push(`ARN: ${lic.LicenseArn}`);
      }

      if (entitlements.length > 0) {
        keyMap[sku] = entitlements.join('\n');
      }
    }
  } while (nextToken);

  return keyMap;
}

async function _fetchCostExplorerPurchases(creds) {
  const endDate   = new Date();
  const startDate = new Date(endDate);
  startDate.setMonth(startDate.getMonth() - 12);

  let data;
  try {
    data = await _awsPost({
      host:    'ce.us-east-1.amazonaws.com',
      path:    '/',
      service: 'ce',
      region:  'us-east-1',
      body: {
        TimePeriod:  { Start: _toYMD(startDate), End: _toYMD(endDate) },
        Granularity: 'MONTHLY',
        Filter:      { Dimensions: { Key: 'RECORD_TYPE', Values: ['Marketplace'] } },
        GroupBy:     [{ Type: 'DIMENSION', Key: 'SERVICE' }],
        Metrics:     ['BlendedCost'],
      },
      target: 'AWSInsightsIndexService.GetCostAndUsage',
      creds,
    });
  } catch (err) {
    throw new Error(`AWS Cost Explorer failed: ${_awsErrorMessage(err)}`);
  }

  const serviceTotals: any = {};
  for (const period of (data?.ResultsByTime ?? [])) {
    for (const group of (period?.Groups ?? [])) {
      const service = group.Keys?.[0] ?? 'Unknown';
      const amount  = parseFloat(group.Metrics?.BlendedCost?.Amount ?? 0);
      const unit    = group.Metrics?.BlendedCost?.Unit ?? 'USD';
      if (!serviceTotals[service]) serviceTotals[service] = { amount: 0, unit };
      serviceTotals[service].amount += amount;
    }
  }

  const results = [];
  for (const [service, { amount, unit }] of Object.entries<any>(serviceTotals)) {
    if (amount <= 0) continue;
    results.push({
      externalId:     `ce-${creds.accountId.replace(/[-\s]/g,'')}-${service.replace(/[^a-z0-9]/gi, '-')}`,
      vendorName:     'Amazon Web Services',
      productName:    service,
      contractNumber: null,
      poNumber:       null,
      licenseKeys:    null,
      quantity:       null,
      unitPrice:      null,
      totalValue:     Math.round(amount * 100) / 100,
      currency:       unit || 'USD',
      startDate,
      endDate,
      status:         'active',
      autoRenewal:    false,
      notes:          'Imported from AWS Cost Explorer. Total Marketplace spend over the past 12 months.',
      syncSource:     'aws',
    });
  }
  return results;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _parseDate(str) {
  if (!str) return null;
  try { const d = new Date(str); return isNaN(d.getTime()) ? null : d; } catch { return null; }
}

function _toYMD(date) {
  return date.toISOString().slice(0, 10);
}

function _mapAgreementStatus(s) {
  return { active: 'active', expired: 'expired', cancelled: 'cancelled', terminated: 'cancelled', superceded: 'cancelled' }[s] ?? 'active';
}

function _extractLicenseKeys(details) {
  const terms = details?.PricingTerms ?? details?.Terms ?? [];
  const keys = [];
  for (const term of (Array.isArray(terms) ? terms : [])) {
    const val = term?.ConfigurableUpfrontPricingTermConfiguration?.SelectorValue
      ?? term?.LicenseEntitlement?.Value
      ?? term?.SoftwareToken;
    if (val && typeof val === 'string') keys.push(val);
  }
  return keys.length > 0 ? keys.join('\n') : null;
}

function _awsErrorMessage(err) {
  if (err.response?.data) {
    const d = err.response.data;
    if (typeof d === 'string') {
      const m = d.match(/<Message>(.*?)<\/Message>/i) || d.match(/<message>(.*?)<\/message>/i);
      if (m) return m[1];
      const c = d.match(/<Code>(.*?)<\/Code>/i);
      if (c) return `AWS error: ${c[1]}`;
    }
    if (d.__type || d.code) return `AWS error: ${d.__type || d.code} -- ${d.message || d.Message || ''}`;
  }
  if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') return 'Could not reach AWS. Check your network connection.';
  if (err.response?.status === 403) return 'AWS returned 403 Forbidden -- check that the credentials are correct and the IAM policy is attached.';
  return err.message || 'Unknown AWS error';
}

module.exports = { FIELDS, SETUP_INSTRUCTIONS, validateCredentials, testConnection, fetchPurchases };

export {};
