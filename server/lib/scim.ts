'use strict';

/**
 * lib/scim.ts
 * -----------
 * Parsing + signature verification for inbound Ory Polis SCIM webhook events.
 *
 * Shapes here are LIVE-VERIFIED against ory/polis@v26.2.0 — see the captured
 * fixtures in server/__tests__/fixtures/polis/ (webhook_deliveries.json) and
 * docs/security/SSO_DESIGN.md §8. The SCIM tests replay those exact bytes.
 *
 * Key facts the parser relies on (confirmed from real deliveries):
 *  - Webhook signature header `BoxyHQ-Signature` (and `Ory-Polis-Signature`):
 *      value `t=<unixMs>,s=<hmacSHA256hex>`  over  `${t}.${rawBody}`.
 *      HMAC re-computation matches the captured deliveries.
 *  - Deactivation arrives as `user.updated` with `active:false` (NOT user.deleted).
 *  - `data.id` is Polis's stable per-directory resource id (identical across
 *    create/update/deactivate for one user) -> our SCIM upsert key.
 *    The IdP's own externalId is in `data.raw.externalId`.
 *  - The POST body may be a SINGLE event object OR an array (batch).
 */

const crypto = require('crypto');

export interface ScimUserEvent {
  kind: 'user';
  type: string;            // user.created | user.updated | user.deleted
  polisDirectoryId: string;
  tenant: string;
  product: string;
  scimUserId: string;      // data.id (stable upsert key)
  externalId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  active: boolean | null; // null = field absent from the payload (distinct from an explicit true/false)
  // present on group.user_added / group.user_removed
  group?: { id: string; name: string } | null;
  raw: any;
}

export interface ScimGroupEvent {
  kind: 'group';
  type: string;            // group.created | group.updated | group.deleted
  polisDirectoryId: string;
  tenant: string;
  product: string;
  groupId: string;
  groupName: string | null;
  raw: any;
}

export type ScimNormalizedEvent = ScimUserEvent | ScimGroupEvent;

/** Parse a `t=<ms>,s=<hex>` signature header. Returns null if malformed. */
function parseSignatureHeader(headerValue: any): { t: number; s: string } | null {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const parts = headerValue.split(',');
  let t: number | null = null;
  let s: string | null = null;
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx === -1) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (k === 't') t = Number(v);
    else if (k === 's') s = v;
  }
  if (t === null || !Number.isFinite(t) || !s || !/^[a-f0-9]+$/i.test(s)) return null;
  return { t, s };
}

/**
 * Verify a Polis SCIM webhook signature over the RAW request body.
 * Constant-time comparison. Returns { valid, t } so the caller can also apply a
 * freshness window if desired. Fails closed: no secret / no header / bad shape
 * => { valid: false }.
 */
function verifyScimSignature(rawBody: string, headerValue: any, secret: string): { valid: boolean; t: number | null } {
  if (!secret || typeof rawBody !== 'string') return { valid: false, t: null };
  const parsed = parseSignatureHeader(headerValue);
  if (!parsed) return { valid: false, t: null };
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parsed.t}.${rawBody}`)
    .digest('hex');
  // Constant-time compare; lengths must match for timingSafeEqual.
  const a = Buffer.from(parsed.s, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);
  return { valid, t: parsed.t };
}

/** True if `t` (unix ms) is within toleranceMs of now. toleranceMs<=0 disables. */
function isFreshTimestamp(t: number | null, toleranceMs: number): boolean {
  if (!toleranceMs || toleranceMs <= 0) return true;
  if (t === null || !Number.isFinite(t)) return false;
  return Math.abs(Date.now() - t) <= toleranceMs;
}

/** Idempotency/replay key for the dedupe ledger: sha256 of the raw event body. */
function computeEventKey(rawEventJson: string): string {
  return crypto.createHash('sha256').update(rawEventJson).digest('hex');
}

const USER_EVENTS = new Set(['user.created', 'user.updated', 'user.deleted', 'group.user_added', 'group.user_removed']);
const GROUP_EVENTS = new Set(['group.created', 'group.updated', 'group.deleted']);

/**
 * Normalize a single Polis DirectorySyncEvent into our internal shape.
 * Returns null for events we don't model. Defensive against missing fields.
 */
function normalizeScimEvent(event: any): ScimNormalizedEvent | null {
  if (!event || typeof event !== 'object' || typeof event.event !== 'string') return null;
  const type = event.event;
  const base = {
    type,
    polisDirectoryId: String(event.directory_id ?? ''),
    tenant: String(event.tenant ?? ''),
    product: String(event.product ?? ''),
  };
  const data = event.data || {};

  if (USER_EVENTS.has(type)) {
    return {
      kind: 'user',
      ...base,
      scimUserId: String(data.id ?? ''),
      externalId: data.raw && data.raw.externalId != null ? String(data.raw.externalId) : null,
      email: data.email != null ? String(data.email) : null,
      firstName: data.first_name != null ? String(data.first_name) : null,
      lastName: data.last_name != null ? String(data.last_name) : null,
      // [2026-07-06 fallback-masks-capture fix] Previously `data.active !== false`,
      // which collapsed "field explicitly true" and "field absent entirely"
      // into the same value. That made it impossible for the route handler to
      // tell a genuine reactivation signal apart from a partial update (e.g. a
      // name-only change) that simply doesn't mention `active` at all -- see
      // routes/ssoScim.ts's create/update branch for the consumer-side fix.
      // Preserve the tri-state; only an explicit boolean counts.
      active: typeof data.active === 'boolean' ? data.active : null,
      group: data.group && data.group.id ? { id: String(data.group.id), name: String(data.group.name ?? '') } : null,
      raw: data.raw ?? null,
    };
  }

  if (GROUP_EVENTS.has(type)) {
    return {
      kind: 'group',
      ...base,
      groupId: String(data.id ?? ''),
      groupName: data.name != null ? String(data.name) : null,
      raw: data.raw ?? null,
    };
  }

  return null;
}

/** Coerce a webhook body (single object OR array) into a list of raw events. */
function toEventList(body: any): any[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') return [body];
  return [];
}

module.exports = {
  parseSignatureHeader,
  verifyScimSignature,
  isFreshTimestamp,
  computeEventKey,
  normalizeScimEvent,
  toEventList,
};

export {};
