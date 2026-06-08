'use strict';

/**
 * Shared setup for the new-route suites (loto / quoteRequests / outagePlan /
 * field). Live-server style like idor.test.js — drives the running dev server
 * (TEST_BASE_URL, else :3001) so the full route → DB round trip is exercised.
 *
 * NOT a test file (no `.test.` in the name) so jest's testMatch skips it.
 *
 * Account A is the seeded demo tenant (admin / viewer @demo.local). Account B is
 * a self-registered hostile tenant used for the cross-tenant isolation checks.
 *
 * Rate-limit isolation: every request carries a per-suite client IP via
 * X-Forwarded-For (apiLimiter, when the instance runs TRUST_PROXY=true) AND the
 * CF-Connecting-IP/CF-Ray pair (credential + registration limiters). Each suite
 * therefore gets its own rate-limit buckets and is immune to cross-suite
 * contention, run ordering, and re-runs.
 */

const { api } = require('./helpers');

// Module state is per-suite: jest re-instantiates this module for every test
// file, so each file's beforeAll stamps its own _suiteIp.
let _suiteIp = '203.0.113.1';
const CF_RAY = '0123456789abcdef-SJC';

function ipHeaders() {
  return { 'X-Forwarded-For': _suiteIp, 'CF-Connecting-IP': _suiteIp, 'CF-Ray': CF_RAY };
}

// Headers for an authenticated request: per-suite client IP + bearer token.
function bearer(token) {
  return { ...ipHeaders(), Authorization: `Bearer ${token}` };
}

// Headers for a deliberately-unauthenticated request (401 checks) that still
// land in the suite's rate-limit bucket rather than the shared localhost one.
function anon() {
  return ipHeaders();
}

const A_USERS = {
  admin:  { email: 'admin@demo.local',  password: 'Admin1234!' },
  viewer: { email: 'viewer@demo.local', password: 'Viewer1234!' },
};

async function login(email, password) {
  const res = await api().post('/api/auth/login').set(ipHeaders()).send({ email, password });
  if (res.status !== 200 || !res.body?.data?.token) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.token;
}

async function registerB() {
  const email = `route-b-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const reg = await api().post('/api/auth/register').set(ipHeaders()).send({
    name: 'Hostile Tenant',
    email,
    password: 'HostileTenant1234!',
    companyName: 'Account B Industrial',
    acceptedTerms: true,
    acceptedUsScope: true, // DEMO_MODE register gate (routes/auth.ts)
  });
  if (![200, 201].includes(reg.status)) {
    throw new Error(`register B failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  }
  return reg.body?.data?.token || login(email, 'HostileTenant1234!');
}

/**
 * Log in A's admin + viewer, register a hostile B on a suite-unique IP, then
 * grab a seeded asset / schedule / site from A. `asset` is guaranteed to be the
 * one carrying `schedule` (the outage planner needs an asset with schedules).
 *
 * @param {string} prefix  TEST-NET /24 prefix, e.g. '203.0.113'
 * @param {number} offset  disjoint octet band per suite (re-run-varied within)
 */
async function setupTenants(prefix, offset) {
  _suiteIp = `${prefix}.${(Date.now() % 40) + offset}`;

  const tokenAdminA  = await login(A_USERS.admin.email,  A_USERS.admin.password);
  const tokenViewerA = await login(A_USERS.viewer.email, A_USERS.viewer.password);
  const tokenB       = await registerB();

  const schedRes = await api().get('/api/schedules?limit=5').set(bearer(tokenAdminA));
  const schedule = schedRes.body?.data?.schedules?.[0] || null;

  const assetsRes = await api().get('/api/assets?limit=10').set(bearer(tokenAdminA));
  const assets = assetsRes.body?.data?.assets || [];
  const asset = (schedule && assets.find((a) => a.id === schedule.assetId)) || assets[0] || null;

  const sitesRes = await api().get('/api/sites').set(bearer(tokenAdminA));
  const site = sitesRes.body?.data?.sites?.[0] || null;

  return { bearer, anon, tokenAdminA, tokenViewerA, tokenB, asset, schedule, site };
}

// A syntactically-valid UUID that belongs to no account — used to prove
// ownership checks actually run (a missing ownership check would 201/200).
const ALIEN_UUID = '00000000-0000-4000-8000-0000000000aa';

module.exports = { api, bearer, anon, login, registerB, setupTenants, A_USERS, ALIEN_UUID };
