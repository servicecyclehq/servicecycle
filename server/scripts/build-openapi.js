#!/usr/bin/env node
'use strict';
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// scripts/build-openapi.js  (Item 4 â€” full internal API spec from the registry)
//
// Walks every route file, joins each router.METHOD('path') against its mount
// prefix (the same MAP the validation middleware is wired with), looks the
// route up in schemas/registry, and emits an OpenAPI 3.1 document covering all
// ~288 internal endpoints to docs/openapi.json.
//
// The committed docs/openapi.json is the drift baseline for
// scripts/check-openapi-drift.js. Exports buildSpec() so the checker can
// regenerate in-process without writing a file.
//
// Run: node server/scripts/build-openapi.js   (npm run openapi:build)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const fs   = require('fs');
const path = require('path');
const { z } = require('zod');
const { getEntry, hasPrecise } = require('../schemas/registry');
const { normalizeKey } = require('../schemas/common');

const ROUTES_DIR = path.join(__dirname, '..', 'routes');
const OUT = path.join(__dirname, '..', '..', 'docs', 'openapi.json');

const MAP = {
  'auth.js': '/api/auth',
  'twoFactor.js': '/api/auth/2fa',
  'contracts.js': '/api/contracts',
  'contractsImport.js': '/api/contracts/import',
  'lineItems.js': '/api/contracts/:contractId/line-items',
  'vendors.js': '/api/vendors',
  'budget.js': '/api/budget',
  'dashboard.js': '/api/dashboard',
  'ingest.js': '/api/ingest',
  'signature.js': '/api/signature',
  'users.js': '/api/users',
  'accounts.js': '/api/accounts',
  'preferences.js': '/api/preferences',
  'bootstrap.js': '/api/bootstrap',
  'alerts.js': '/api/alerts',
  'export.js': '/api/export',
  'settings.js': '/api/settings',
  'consultant.js': '/api/consultant-access',
  'news.js': '/api/news',
  'feedback.js': '/api/feedback',
  'cloudConnectors.js': '/api/cloud-connectors',
  'activity.js': '/api/activity',
  'errors.js': '/api/errors',
  'backup.js': '/api/backup',
  'documents.js': '/api/documents',
  'setup.js': '/api/setup',
  'admin.js': '/api/admin',
  'adminAuditChain.js': '/api/admin/audit-chain',
  'reports.js': '/api/reports',
  'customFields.js': '/api/custom-fields',
  'categories.js': '/api/categories',
  'earlyAccess.js': '/api/early-access',
  'help.js': '/api/help',
  'aiUsage.js': '/api/ai/usage',
  'ask.js': '/api/ask',
  'templateFeedback.js': '/api/template-feedback',
  'apiKeys.js': '/api/settings/api-keys',
  'webhooks.js': '/api/webhooks',
  'v1/contracts.js': '/api/v1/contracts',
  'v1/vendors.js': '/api/v1/vendors',
  'v1/reports.js': '/api/v1/reports',
};

const ROUTE_RE = /router\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]*)\2/g;

function toJsonSchema(zodSchema) {
  try { return z.toJSONSchema(zodSchema, { unrepresentable: 'any', io: 'output' }); }
  catch (_) {
    try { return z.toJSONSchema(zodSchema, { unrepresentable: 'any' }); }
    catch (_2) { return {}; }
  }
}

function toOpenApiPath(p) {
  const params = [];
  const oaPath = p.replace(/:([A-Za-z0-9_]+)/g, (_, name) => { params.push(name); return '{' + name + '}'; });
  return { oaPath, params };
}

function buildSpec() {
  const paths = {};
  let total = 0, precise = 0;
  for (const [file, base] of Object.entries(MAP)) {
    let src;
    try { src = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf-8'); }
    catch (_) { continue; }
    let m; ROUTE_RE.lastIndex = 0;
    while ((m = ROUTE_RE.exec(src))) {
      const method = m[1].toLowerCase();
      const key = normalizeKey(method, base, m[3]);
      const rawPath = key.slice(key.indexOf(' ') + 1);
      const { oaPath, params } = toOpenApiPath(rawPath);
      const entry = getEntry(key);
      total++; if (hasPrecise(key)) precise++;
      paths[oaPath] = paths[oaPath] || {};
      const op = {
        summary: entry.summary || (method.toUpperCase() + ' ' + rawPath),
        tags: [base.replace(/^\/api\//, '').split('/')[0] || 'api'],
        responses: { '200': { description: 'Success', content: { 'application/json': { schema: toJsonSchema(entry.response) } } } },
      };
      if (params.length) op.parameters = params.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
      if (['post', 'put', 'patch'].includes(method)) {
        op.requestBody = { required: !!(hasPrecise(key) && entry.precise.body), content: { 'application/json': { schema: toJsonSchema(entry.body) } } };
      }
      paths[oaPath][method] = op;
    }
  }
  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'LapseIQ Internal API',
      version: require('../package.json').version,
      description: 'Auto-generated from server/schemas/registry.js. Covers all internal /api endpoints. Do not hand-edit â€” run `npm run openapi:build`.',
    },
    servers: [{ url: 'https://demo.lapseiq.com' }],
    paths,
  };
  return { spec, stats: { total, precise, paths: Object.keys(paths).length } };
}

function writeSpec() {
  const { spec, stats } = buildSpec();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(spec, null, 2) + '\n', 'utf-8');
  console.log('wrote', OUT);
  console.log('endpoints:', stats.total, '| precise:', stats.precise, '| unique paths:', stats.paths);
}

module.exports = { buildSpec, writeSpec, OUT };

if (require.main === module) writeSpec();