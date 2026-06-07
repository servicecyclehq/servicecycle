/**
 * lapseiq-feedback Worker
 *
 * Receives opt-in anonymous template-feedback submissions from self-hosted
 * LapseIQ instances and stores them in D1 for ForgeRift to query.
 *
 * Routes:
 *   POST /api/template-feedback   — public write endpoint (rate-limited by CF)
 *   GET  /api/admin/feedback      — gated by Cloudflare Access (admin only)
 *   GET  /health                  — unauthenticated liveness probe
 *
 * Payload (POST):
 *   {
 *     instanceId:       string (sha256-hex truncated to 16 chars — anonymous)
 *     categorySlug:     string (max 64 chars)
 *     templateVersion:  string (max 16 chars)
 *     section:          'situation'|'market'|'tactics'|'watchFor'
 *     rating:           boolean
 *     freeText:         string|null (max 1000 chars, PII-warning shown in UI)
 *     lapseiqVersion:   string (max 16 chars, e.g. '0.18.0')
 *   }
 *
 * Security:
 *   - Rate limited: 10 submissions per IP per minute (CF rate rules)
 *   - Input validation on every field before D1 write
 *   - No account name / user identity stored
 *   - Admin GET endpoint behind Cloudflare Access (OTP or service token)
 *   - CORS: only lapseiq.com + demo.lapseiq.com origins + local dev
 */

const VALID_SECTIONS = ['situation', 'market', 'tactics', 'watchFor'];
const MAX_FREE_TEXT  = 1000;
const MAX_SLUG_LEN   = 64;
const MAX_VER_LEN    = 16;

const ALLOWED_ORIGINS = [
  'https://demo.lapseiq.com',
  'https://lapseiq.com',
  'http://localhost:3000',
  'http://localhost:5173',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age':       '86400',
  };
}

function jsonOk(data, origin, status = 200) {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function jsonErr(msg, origin, status = 400) {
  return new Response(JSON.stringify({ success: false, error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// Nano-UUID: crypto.randomUUID() is available in Workers
function newId() {
  return crypto.randomUUID();
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url    = new URL(request.url);
    const path   = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ── Health probe ─────────────────────────────────────────────────────────
    if (path === '/health' && request.method === 'GET') {
      return jsonOk({ status: 'ok', ts: new Date().toISOString() }, origin);
    }

    // ── POST /api/template-feedback ──────────────────────────────────────────
    if (path === '/api/template-feedback' && request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonErr('Invalid JSON body', origin);
      }

      // Validate required fields
      const { instanceId, categorySlug, templateVersion, section, rating, freeText, lapseiqVersion } = body;

      if (!instanceId || typeof instanceId !== 'string' || instanceId.length > 64) {
        return jsonErr('Invalid instanceId', origin);
      }
      if (!categorySlug || typeof categorySlug !== 'string' || categorySlug.length > MAX_SLUG_LEN) {
        return jsonErr('Invalid categorySlug', origin);
      }
      if (!templateVersion || typeof templateVersion !== 'string' || templateVersion.length > MAX_VER_LEN) {
        return jsonErr('Invalid templateVersion', origin);
      }
      if (!VALID_SECTIONS.includes(section)) {
        return jsonErr('Invalid section', origin);
      }
      if (typeof rating !== 'boolean') {
        return jsonErr('rating must be boolean', origin);
      }
      if (freeText !== null && freeText !== undefined) {
        if (typeof freeText !== 'string' || freeText.length > MAX_FREE_TEXT) {
          return jsonErr('freeText too long or invalid', origin);
        }
      }

      const cleanFreeText = freeText
        ? freeText.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '').trim() || null
        : null;

      const id = newId();
      const versionStr = (typeof lapseiqVersion === 'string' ? lapseiqVersion : '').slice(0, MAX_VER_LEN);

      try {
        await env.DB.prepare(
          `INSERT INTO template_feedback (id, instance_id, category_slug, template_version, section, rating, free_text, lapseiq_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(id, instanceId, categorySlug, templateVersion, section, rating ? 1 : 0, cleanFreeText, versionStr || null).run();

        return jsonOk({ id }, origin, 201);
      } catch (err) {
        console.error('D1 insert failed:', err);
        return jsonErr('Failed to store feedback', origin, 500);
      }
    }

    // ── GET /api/admin/feedback ───────────────────────────────────────────────
    // Gated by Cloudflare Access — the Access policy validates the JWT before
    // the request reaches this handler, so no additional auth check needed here.
    if (path === '/api/admin/feedback' && request.method === 'GET') {
      const limit  = Math.min(parseInt(url.searchParams.get('limit')  || '50', 10), 200);
      const offset = Math.max(parseInt(url.searchParams.get('offset') || '0',  10), 0);
      const slug   = url.searchParams.get('categorySlug');
      const sect   = url.searchParams.get('section');

      let where  = '1=1';
      const args = [];
      if (slug && slug.length <= MAX_SLUG_LEN) { where += ' AND category_slug = ?'; args.push(slug); }
      if (sect && VALID_SECTIONS.includes(sect)) { where += ' AND section = ?'; args.push(sect); }

      try {
        const [rowsRes, countRes] = await Promise.all([
          env.DB.prepare(
            `SELECT id, instance_id, category_slug, template_version, section, rating, free_text, lapseiq_version, created_at
             FROM template_feedback WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
          ).bind(...args, limit, offset).all(),
          env.DB.prepare(
            `SELECT COUNT(*) as total FROM template_feedback WHERE ${where}`
          ).bind(...args).first(),
        ]);

        const rows = (rowsRes.results || []).map(r => ({ ...r, rating: r.rating === 1 }));
        return jsonOk({ rows, total: countRes?.total ?? 0, limit, offset }, origin);
      } catch (err) {
        console.error('D1 query failed:', err);
        return jsonErr('Query failed', origin, 500);
      }
    }

    return jsonErr('Not found', origin, 404);
  },
};
