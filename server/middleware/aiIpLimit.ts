// v0.69.1 -- shared aiIpLimiter middleware.
// Extracted from index.js so per-route handlers (routes/contracts.js
// brief, routes/reports.js narrate) can stack it alongside per-user
// limiters.
//
// v0.73.4 (T6-N2): _clientIpKey now validates that the socket IP is a
// Cloudflare CIDR before trusting CF-Connecting-IP. Previously the check
// only validated CF-Ray shape, which a direct-origin attacker can forge.
// Now an attacker connecting directly (non-CF socket IP) gets rate-limited
// on their real socket address instead of a forged CF-Connecting-IP value.
'use strict';

const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

// Cloudflare published IPv4 ranges (https://www.cloudflare.com/ips-v4).
// Updated 2026-05-23. Re-check quarterly or on CF announcements.
const _CF_CIDR_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15',
  '104.16.0.0/13',   '104.24.0.0/14',   '172.64.0.0/13',   '131.0.72.0/22',
].map(cidr => {
  const [base, bits] = cidr.split('/');
  const mask = ~((1 << (32 - Number(bits))) - 1) >>> 0;
  const net  = base.split('.').reduce((acc, o) => (acc << 8 | Number(o)) >>> 0, 0);
  return { net: (net & mask) >>> 0, mask };
});

function _isCloudflareIp(ip) {
  if (!ip) return false;
  const clean = ip.replace(/^::ffff:/, '');     // strip IPv4-mapped IPv6
  const parts = clean.split('.');
  if (parts.length !== 4) return false;          // IPv6 not in CF IPv4 ranges
  const n = parts.reduce((acc, o) => (acc << 8 | Number(o)) >>> 0, 0);
  return _CF_CIDR_V4.some(({ net, mask }) => (n & mask) >>> 0 === net);
}

const _CF_RAY_RE = /^[a-f0-9]{16}-[A-Z]{3}$/;
function _clientIpKey(req) {
  const cf     = req.headers['cf-connecting-ip'];
  const cfRay  = req.headers['cf-ray'];
  const socket = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  if (
    cf && cfRay &&
    typeof cf === 'string' && cf.length < 64 &&
    _CF_RAY_RE.test(String(cfRay)) &&
    _isCloudflareIp(socket)            // NEW: socket must be a real CF edge IP
  ) {
    return 'ip:' + ipKeyGenerator(cf);
  }
  return 'ip:' + ipKeyGenerator(req.ip);
}

const aiIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max:      100,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    _clientIpKey,
  message: { success: false, error: 'Too many AI requests from this network -- try again in an hour.' },
});

module.exports = { aiIpLimiter, _isCloudflareIp, _clientIpKey };

export {};
