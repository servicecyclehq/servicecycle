/**
 * lib/awsSigV4.js
 *
 * Minimal AWS Signature Version 4 request signer.
 * Uses only Node.js built-in 'crypto' -- zero external dependencies.
 *
 * Usage:
 *   const { headers } = signAwsRequest({
 *     method, host, path, query, headers, body,
 *     credentials: { accessKeyId, secretAccessKey },
 *     service, region,
 *   });
 *   // Pass returned headers to axios (includes Authorization + x-amz-date etc.)
 */

const crypto = require('crypto');

function _hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function _sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function _getSigningKey(secret, dateStamp, region, service) {
  const kDate    = _hmac('AWS4' + secret, dateStamp);
  const kRegion  = _hmac(kDate, region);
  const kService = _hmac(kRegion, service);
  return _hmac(kService, 'aws4_request');
}

function _uriEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Signs an AWS API request and returns the headers needed to make it.
 *
 * @param {object} opts
 * @param {string}  opts.method       HTTP method ('GET', 'POST', ...)
 * @param {string}  opts.host         Hostname (e.g. 'sts.amazonaws.com')
 * @param {string}  [opts.path]       URL path (defaults to '/')
 * @param {object}  [opts.query]      Query string params as { key: value }
 * @param {object}  [opts.headers]    Extra headers to include in signature (lowercase keys)
 * @param {string}  [opts.body]       Request body string ('' for GET)
 * @param {object}  opts.credentials  { accessKeyId, secretAccessKey }
 * @param {string}  opts.service      AWS service identifier (e.g. 'sts', 'ce', 'catalog.marketplace')
 * @param {string}  opts.region       AWS region (e.g. 'us-east-1')
 * @returns {{ headers: object }}
 */
function signAwsRequest({ method, host, path = '/', query = {}, headers = {}, body = '', credentials, service, region }: any = {}) {
  const now       = new Date();
  // Format: 20260514T120000Z
  const amzDate   = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const bodyHash = _sha256Hex(body);

  // Assemble all headers that will be signed (must include host + x-amz-date + x-amz-content-sha256)
  const allHeaders = {};
  allHeaders['host']                   = host;
  allHeaders['x-amz-date']             = amzDate;
  allHeaders['x-amz-content-sha256']   = bodyHash;
  // Merge caller-provided headers (lower-cased)
  for (const [k, v] of Object.entries(headers)) {
    allHeaders[k.toLowerCase()] = v;
  }

  const sortedKeys       = Object.keys(allHeaders).sort();
  const canonicalHeaders = sortedKeys.map(k => `${k}:${allHeaders[k]}\n`).join('');
  const signedHeaders    = sortedKeys.join(';');

  // Canonical query string
  const canonicalQuery = Object.keys(query)
    .sort()
    .map(k => `${_uriEncode(k)}=${_uriEncode(query[k])}`)
    .join('&');

  const canonicalRequest = [
    method.toUpperCase(),
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    _sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = _getSigningKey(credentials.secretAccessKey, dateStamp, region, service);
  const signature  = _hmac(signingKey, stringToSign).toString('hex');

  const authHeader = [
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ');

  return {
    headers: {
      ...allHeaders,
      Authorization: authHeader,
    },
  };
}

module.exports = { signAwsRequest };

export {};
