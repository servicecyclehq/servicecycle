'use strict';

/**
 * Shared helpers for the smoke-test suite.
 *
 * Tests run against the live dev server at PORT (default 3001). Start it
 * with `node index.js` in another terminal before running `npm test`.
 *
 * This is a deliberate scaffold choice — driving the express app object
 * via supertest directly would require splitting index.js (separate
 * `app` and `start-server` files), which is out of scope for the test
 * scaffolding pass. The dev-server-bound approach gets us regression
 * protection today; the refactor can come later.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const request = require('supertest');

const BASE_URL = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;

const api = () => request(BASE_URL);

async function login(email, password) {
  const res = await api()
    .post('/api/auth/login')
    .send({ email, password });
  if (res.status !== 200 || !res.body?.data?.token) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.token;
}

module.exports = { api, login, BASE_URL };
