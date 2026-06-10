/**
 * Pre-framework env setup (jest setupFiles).
 * Sets NODE_ENV=test BEFORE index.ts is ever required, so app.listen() and crons are skipped.
 */

// Must be the very first line
process.env.NODE_ENV = 'test';

// Load .env so DATABASE_URL, JWT_SECRET, MASTER_KEY etc. are available
require('dotenv').config();

// Override with test-specific DB if provided
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// Minimum-viable JWT secret for test tokens
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-secret-minimum-32-chars-long-for-jest-!!';
}

// Valid 32-byte MASTER_KEY (all-zero — acceptable for tests only)
if (!process.env.MASTER_KEY) {
  process.env.MASTER_KEY = Buffer.alloc(32).toString('base64');
}

// Disable demo mode in tests — DEMO_MODE guard blocks DELETE/mutate routes
process.env.DEMO_MODE = '';

export {};
