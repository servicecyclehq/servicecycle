// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// schemas/registry.js  (Item 2 â€” single lookup surface)
//
// getEntry("METHOD /api/path") ALWAYS returns a fully-populated entry:
//   { body, params, query, response, precise:{...}, summary, tags }
// Hand-authored shapes come from domains.js; everything else is filled from
// common.DEFAULTS (passthrough request, object|array|null response).
//
// The middleware calls getEntry() for every route it matches, so coverage is
// total by construction â€” an unlisted route still gets the safe defaults.
// preciseKeys() drives the coverage report + the OpenAPI builder.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

'use strict';

const { withDefaults, normalizeKey } = require('./common');
const { overrides } = require('./domains');

function getEntry(key) {
  return withDefaults(overrides[key]);
}

function hasPrecise(key) {
  return Object.prototype.hasOwnProperty.call(overrides, key);
}

function preciseKeys() {
  return Object.keys(overrides);
}

module.exports = { getEntry, hasPrecise, preciseKeys, overrides, normalizeKey };