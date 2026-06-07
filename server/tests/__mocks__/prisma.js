// Minimal Prisma stub for unit tests that import modules which transitively
// require the real client. Returns chainable no-op async methods so importing
// (not exercising) DB code never needs a live database.
const handler = {
  get: () => new Proxy(function () { return Promise.resolve(null); }, handler),
};
const stub = new Proxy({}, handler);
module.exports = stub;
module.exports.default = stub;
