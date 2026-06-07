/**
 * Shared email helper - thin wrapper around the Brevo (formerly Sendinblue)
 * transactional email HTTP API. Keeps email-sending logic out of route files.
 *
 * Why Brevo (not Resend)?
 *   The free Resend tier allows only one verified domain per account, which
 *   is consumed by forgerift.io's MCP product line. Brevo's free tier covers
 *   the ServiceCycle domain. Both DKIM (brevo1/2._domainkey CNAMEs) and SPF
 *   (include:spf.brevo.com) are published; mail passes DMARC alignment via
 *   either path.
 *
 * Why hand-rolled fetch (no SDK)?
 *   Brevo's official Node SDK has historically been heavy and infrequently
 *   updated. Native fetch (Node 18+) keeps the runtime dependency footprint
 *   at zero new packages and the failure modes obvious.
 */

const { redactEmail } = require('./redact'); // audit-7 item 3.1.3
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

function parseAddress(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
  if (m) return { name: m[1] || undefined, email: m[2] };
  return { email: raw.trim() };
}

let _resendDeprecationWarned = false;

// CR-6 (audit-2 2026-05-22): module-level runtime key set by the setup wizard
// (server/routes/setup.js) so the wizard does not need to write the plaintext
// key into process.env. Falls back to process.env.BREVO_API_KEY for operators
// who supply the key via .env / environment variables in the normal way.
// Cleared to null by default; set once per process lifetime during wizard flow.
let _runtimeBrevoKey = null;
function setRuntimeBrevoKey(key) { _runtimeBrevoKey = (typeof key === 'string' && key) ? key : null; }

// EMAIL_FROM must be set in .env to match your verified sender domain.
// Example: EMAIL_FROM="ServiceCycle <noreply@yourdomain.com>"
// If not set, email sending is skipped with a warning.
//
// Read at call time (not at module load) so tests can flip env vars between
// scenarios without re-requiring the module, and so a runtime env update via
// a process manager actually takes effect on the next send.
function getFrom() { return process.env.EMAIL_FROM || null; }

async function sendEmail({ to, subject, html }) {
  // L4: feedback bypass for EMAIL_MOCK.
  // Subjects starting with '[ServiceCycle Feedback]' bypass the mock so
  // operator feedback always reaches the inbox even on the demo box. The
  // bypass still requires BREVO_API_KEY + EMAIL_FROM; it just skips the
  // EMAIL_MOCK gate. NOTE: routes/feedback must emit this exact prefix.
  const isFeedback = typeof subject === 'string' && subject.startsWith('[ServiceCycle Feedback]');

  // 2026-05-11 (v0.3.2): early-access bypass for EMAIL_MOCK. The marketing
  // landing page 301s to the public demo, so every real prospect who fills
  // out the "Request early access" form on the demo box needs to receive
  // the install-instructions reply and the ops notification. Without this
  // carve-out the form silently records to the database but emails
  // nothing — prospects are left waiting indefinitely and the operator
  // never gets pinged.
  //
  // Matched via prefix on the canonical subjects emitted in
  // routes/earlyAccess.js. Same fail-safe shape as the feedback bypass:
  // still requires BREVO_API_KEY + EMAIL_FROM; just skips the EMAIL_MOCK gate.
  const isEarlyAccess = typeof subject === 'string' && (
    subject.startsWith('ServiceCycle — your early-access') ||
    subject.startsWith('[ServiceCycle Early Access]')
  );

  if (!isFeedback && !isEarlyAccess && process.env.EMAIL_MOCK === 'true') {
    console.log(`\nðŸ“§ [EMAIL MOCK]\n  To: ${to}\n  Subject: ${subject}\n`);
    return;
  }

  // Migration warning: an operator with the old RESEND_API_KEY env still set
  // gets a one-shot, clear-language deprecation message instead of silently
  // sending nothing.
  if (process.env.RESEND_API_KEY && !process.env.BREVO_API_KEY && !_resendDeprecationWarned) {
    _resendDeprecationWarned = true;
    console.warn('[email] RESEND_API_KEY is set but BREVO_API_KEY is not. ServiceCycle no longer uses Resend - rename to BREVO_API_KEY (and use a Brevo API key, not your old Resend key) to enable email sending. See docs/install.md.');
  }

  const brevoKey = _runtimeBrevoKey || process.env.BREVO_API_KEY;
  if (!brevoKey) {
    if (isFeedback) {
      console.warn(`[email][feedback] BREVO_API_KEY not set - feedback to ${redactEmail(to)} was DROPPED. Set it on the demo box.`);
    } else {
      console.warn('[email] BREVO_API_KEY not set - skipping send');
    }
    return;
  }

  const fromRaw = getFrom();
  if (!fromRaw) {
    console.warn('[email] EMAIL_FROM not set - skipping send. Set EMAIL_FROM in .env to enable transactional email.');
    return;
  }

  const sender = parseAddress(fromRaw);
  const recipient = parseAddress(to);
  if (!sender || !recipient) throw new Error('email: malformed EMAIL_FROM or recipient');

  const body = {
    sender,
    to: [recipient],
    subject,
    htmlContent: html,
  };

  // S3-FN-01 (v0.74.1): AbortController + 10s timeout so a hung Brevo
  // response cannot stall the Node process indefinitely.
  const _ac = new AbortController();
  const _brevoTimeout = setTimeout(() => _ac.abort(), 10_000);
  let resp;
  try {
    resp = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'api-key': brevoKey,
      },
      body: JSON.stringify(body),
      signal: _ac.signal,
    });
  } catch (fetchErr) {
    if (fetchErr.name === 'AbortError') throw new Error('Brevo request timed out after 10s');
    throw fetchErr;
  } finally {
    clearTimeout(_brevoTimeout);
  }

  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 500); } catch { /* ignore */ }
    throw new Error(`Brevo error: HTTP ${resp.status} ${resp.statusText} - ${detail}`);
  }
}

// ── Display helpers ───────────────────────────────────────────────────────────

// Canonical human label for an asset in outbound notifications (email /
// Slack / Teams digests). Electrical equipment rarely has a friendly name,
// so the convention is manufacturer + model + serial when available,
// falling back to the equipment type ("SWITCHGEAR", "TRANSFORMER_DRY", ...).
// Exported so alertEngine's digest builder renders the same label the
// Slack/Teams builders do.
function assetDisplayName(asset) {
  if (!asset || typeof asset !== 'object') return 'Asset';
  const parts = [asset.manufacturer, asset.model].filter(Boolean);
  if (asset.serialNumber) parts.push(`S/N ${asset.serialNumber}`);
  if (parts.length > 0) return parts.join(' ');
  return asset.equipmentType ? String(asset.equipmentType).replace(/_/g, ' ') : 'Asset';
}

// ── Email templates ───────────────────────────────────────────────────────────

// Audit 6.1.1 — welcome email sent after register() succeeds. Demo runs
// EMAIL_MOCK=true so this lands in the server log rather than going out;
// self-hosted installs send it for real once the operator wires Brevo or
// equivalent. Keeps the brand visible in the user's inbox after signup +
// gives a single click back into the app.
function welcomeHtml({ name, companyName, appUrl }) {
  const safeName = name || 'there';
  const safeCompany = companyName || 'your team';
  const safeUrl = appUrl || 'https://demo.servicecycle.com';
  return `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0f1117;color:#e2e8f0;border-radius:8px;">
  <div style="margin-bottom:24px;">
    <span style="font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.3px;">ServiceCycle</span>
  </div>
  <h2 style="margin:0 0 12px;font-size:18px;font-weight:600;color:#fff;">Welcome to ServiceCycle, ${safeName}.</h2>
  <p style="margin:0 0 16px;color:#94a3b8;font-size:14px;line-height:1.6;">
    Your ${safeCompany} workspace is ready. Three things worth doing in your first 10 minutes:
  </p>
  <ol style="margin:0 0 24px;padding-left:22px;color:#94a3b8;font-size:14px;line-height:1.7;">
    <li>Add your first site and equipment assets (or import a CSV).</li>
    <li>Set up maintenance alerts so we ping you before anything goes overdue.</li>
    <li>Invite a teammate so you're not the only person who knows when the next test is due.</li>
  </ol>
  <a href="${safeUrl}/dashboard" style="display:inline-block;padding:11px 22px;background:#6366f1;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">
    Open my dashboard
  </a>
  <p style="margin:28px 0 0;font-size:12px;color:#475569;line-height:1.6;">
    Questions or stuck on something? Reply to this email — it routes to a human.
  </p>
</div>`;
}

function passwordResetHtml({ link }) {
  return `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0f1117;color:#e2e8f0;border-radius:8px;">
  <div style="margin-bottom:24px;">
    <span style="font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.3px;">ServiceCycle</span>
  </div>
  <h2 style="margin:0 0 12px;font-size:18px;font-weight:600;color:#fff;">Reset your password</h2>
  <p style="margin:0 0 24px;color:#94a3b8;font-size:14px;line-height:1.6;">
    We received a request to reset the password for your ServiceCycle account.
    Click the button below to choose a new password. This link expires in <strong style="color:#e2e8f0;">1 hour</strong>.
  </p>
  <a href="${link}" style="display:inline-block;padding:11px 22px;background:#6366f1;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">
    Reset Password
  </a>
  <p style="margin:28px 0 0;font-size:12px;color:#475569;line-height:1.6;">
    If you didn't request a password reset, you can safely ignore this email — your password won't change.<br>
    <span style="color:#334155;">Direct link: ${link}</span>
  </p>
</div>`;
}

function inviteHtml({ inviterName, companyName, role, link }) {
  const roleLabel = { admin: 'Admin', manager: 'Manager', viewer: 'Viewer' }[role] || role;
  return `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0f1117;color:#e2e8f0;border-radius:8px;">
  <div style="margin-bottom:24px;">
    <span style="font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.3px;">ServiceCycle</span>
  </div>
  <h2 style="margin:0 0 12px;font-size:18px;font-weight:600;color:#fff;">You've been invited to join ServiceCycle</h2>
  <p style="margin:0 0 8px;color:#94a3b8;font-size:14px;line-height:1.6;">
    <strong style="color:#e2e8f0;">${inviterName}</strong> has invited you to join
    <strong style="color:#e2e8f0;">${companyName}</strong> on ServiceCycle as a
    <strong style="color:#e2e8f0;">${roleLabel}</strong>.
  </p>
  <p style="margin:0 0 24px;color:#94a3b8;font-size:14px;line-height:1.6;">
    Click the button below to set up your account. This invite expires in <strong style="color:#e2e8f0;">48 hours</strong>.
  </p>
  <a href="${link}" style="display:inline-block;padding:11px 22px;background:#6366f1;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">
    Accept Invitation
  </a>
  <p style="margin:28px 0 0;font-size:12px;color:#475569;line-height:1.6;">
    If you weren't expecting this invitation, you can safely ignore this email.<br>
    <span style="color:#334155;">Direct link: ${link}</span>
  </p>
</div>`;
}

function feedbackHtml({ userName, userEmail, userRole, companyName, category, message, pageUrl, submittedAt }) {
  const safeMsg = message.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  return `
<div style="font-family:sans-serif;max-width:580px;margin:0 auto;padding:32px 24px;background:#0f1117;color:#e2e8f0;border-radius:8px;">
  <div style="margin-bottom:20px;">
    <span style="font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.3px;">ServiceCycle</span>
    <span style="margin-left:10px;font-size:12px;color:#475569;">User Feedback</span>
  </div>

  <div style="background:#1e2330;border-radius:6px;padding:16px 20px;margin-bottom:20px;border-left:3px solid #6366f1;">
    <div style="font-size:13px;font-weight:700;color:#a5b4fc;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Category</div>
    <div style="font-size:16px;font-weight:600;color:#fff;">${category}</div>
  </div>

  <div style="background:#1e2330;border-radius:6px;padding:16px 20px;margin-bottom:20px;">
    <div style="font-size:13px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">Message</div>
    <div style="font-size:14px;color:#e2e8f0;line-height:1.7;">${safeMsg}</div>
  </div>

  <div style="background:#1e2330;border-radius:6px;padding:16px 20px;margin-bottom:20px;">
    <div style="font-size:13px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px;">Submitted By</div>
    <table style="width:100%;border-collapse:collapse;">
      <tr><td style="padding:3px 0;font-size:12px;color:#64748b;width:110px;">Name</td><td style="padding:3px 0;font-size:13px;color:#e2e8f0;">${userName}</td></tr>
      <tr><td style="padding:3px 0;font-size:12px;color:#64748b;">Email</td><td style="padding:3px 0;font-size:13px;color:#e2e8f0;">${userEmail}</td></tr>
      <tr><td style="padding:3px 0;font-size:12px;color:#64748b;">Role</td><td style="padding:3px 0;font-size:13px;color:#e2e8f0;text-transform:capitalize;">${userRole}</td></tr>
      <tr><td style="padding:3px 0;font-size:12px;color:#64748b;">Account</td><td style="padding:3px 0;font-size:13px;color:#e2e8f0;">${companyName}</td></tr>
      <tr><td style="padding:3px 0;font-size:12px;color:#64748b;">Page</td><td style="padding:3px 0;font-size:13px;color:#a5b4fc;">${pageUrl}</td></tr>
      <tr><td style="padding:3px 0;font-size:12px;color:#64748b;">Time</td><td style="padding:3px 0;font-size:13px;color:#e2e8f0;">${submittedAt}</td></tr>
    </table>
  </div>

  <p style="margin:0;font-size:11px;color:#334155;">Sent from ServiceCycle in-app feedback — reply directly to respond to this user.</p>
</div>`;
}

// Sent to all admins when a scoped viewer accepts their invite and activates.
function newViewerActivationHtml({ viewerName, viewerEmail, assetCount, settingsUrl }) {
  return `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0f1117;color:#e2e8f0;border-radius:8px;">
  <div style="margin-bottom:24px;">
    <span style="font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.3px;">ServiceCycle</span>
  </div>
  <h2 style="margin:0 0 12px;font-size:18px;font-weight:600;color:#fff;">New viewer activated</h2>
  <p style="margin:0 0 16px;color:#94a3b8;font-size:14px;line-height:1.6;">
    <strong style="color:#e2e8f0;">${viewerName}</strong> (${viewerEmail}) just activated their ServiceCycle account.
  </p>
  <div style="background:#1e2330;border-radius:6px;padding:14px 18px;margin-bottom:20px;border-left:3px solid #f59e0b;">
    <p style="margin:0;font-size:14px;color:#fcd34d;font-weight:600;">
      They can currently see <strong>${assetCount}</strong> asset${assetCount !== 1 ? 's' : ''} assigned to them.
    </p>
    <p style="margin:8px 0 0;font-size:13px;color:#94a3b8;">
      Their access is restricted to assets at the sites they are assigned to.
    </p>
  </div>
  <p style="margin:0 0 20px;color:#94a3b8;font-size:14px;line-height:1.6;">
    To expand their permissions or assign additional sites, visit the Users settings page.
  </p>
  <a href="${settingsUrl}" style="display:inline-block;padding:11px 22px;background:#6366f1;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">
    Go to Settings → Users
  </a>
  <p style="margin:28px 0 0;font-size:12px;color:#475569;line-height:1.6;">
    Direct link: ${settingsUrl}
  </p>
</div>`;
}

// L7: auto-reply for landing-page early-access submissions.
// Confirms receipt + ships the install command + a quickstart excerpt so
// the lead can self-serve immediately if they want.
function earlyAccessReplyHtml({ name, installScriptUrl, demoUrl }) {
  const safeName = (name || '').replace(/</g, '&lt;').replace(/>/g, '&gt;') || 'there';
  return `
<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#0f1117;color:#e2e8f0;border-radius:8px;">
  <div style="margin-bottom:24px;">
    <span style="font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.3px;">ServiceCycle</span>
  </div>
  <h2 style="margin:0 0 12px;font-size:18px;font-weight:600;color:#fff;">Thanks for the interest, ${safeName}.</h2>
  <p style="margin:0 0 18px;color:#94a3b8;font-size:14px;line-height:1.6;">
    ServiceCycle is self-hosted — every install runs on your own
    infrastructure and your equipment and maintenance records never leave
    your network. You can stand up an instance
    yourself with the one-line installer below; the demo at
    <a href="${demoUrl}" style="color:#a5b4fc;">${demoUrl}</a> shows the same
    UI populated with sample data if you'd rather try before installing.
  </p>

  <div style="background:#1e2330;border-radius:6px;padding:16px 20px;margin:0 0 20px;border-left:3px solid #6366f1;">
    <div style="font-size:12px;font-weight:700;color:#a5b4fc;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">One-line install</div>
    <pre style="margin:0;font-family:Menlo,Consolas,monospace;font-size:13px;color:#e2e8f0;white-space:pre-wrap;line-height:1.5;">curl -fsSLO ${installScriptUrl}
less install.sh
bash install.sh</pre>
    <div style="margin-top:10px;font-size:12px;color:#94a3b8;line-height:1.5;">
      Runs on Ubuntu 22+ / Debian 12 / macOS with Docker Desktop. ~5 minutes
      from clean host to setup wizard. Reads the script before running it
      is the recommended step in the middle.
    </div>
  </div>

  <p style="margin:0 0 8px;color:#94a3b8;font-size:14px;line-height:1.6;">
    Quickstart: the script prompts you for a domain, an admin email, and an
    optional Resend API key. It generates the database password, JWT secret,
    and document-encryption key for you, writes the .env, pulls the published
    Docker images from GitHub Container Registry, brings the stack up, and
    polls /api/health until it's green.
  </p>

  <p style="margin:18px 0 0;color:#94a3b8;font-size:14px;line-height:1.6;">
    Hit reply if you have any questions, want a walkthrough, or want to talk
    pilot scope — Dustin reads every one of these.
  </p>

  <p style="margin:28px 0 0;font-size:11px;color:#475569;line-height:1.6;">
    You're receiving this because you submitted the early-access form at
    servicecycle.com. We don't add anyone to a marketing list — this is a
    one-shot transactional reply.
  </p>
</div>`;
}

// L7: notification email to the operator when a new lead lands.
function earlyAccessNotificationHtml({ name, email, company, timing, ipAddress, submittedAt }) {
  const esc = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `
<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#0f1117;color:#e2e8f0;border-radius:8px;">
  <div style="margin-bottom:20px;">
    <span style="font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.3px;">ServiceCycle</span>
    <span style="margin-left:10px;font-size:12px;color:#475569;">New early-access request</span>
  </div>
  <table style="width:100%;border-collapse:collapse;background:#1e2330;border-radius:6px;padding:8px;">
    <tr><td style="padding:8px 14px;font-size:12px;color:#64748b;width:120px;">Name</td><td style="padding:8px 14px;font-size:14px;color:#e2e8f0;">${esc(name)}</td></tr>
    <tr><td style="padding:8px 14px;font-size:12px;color:#64748b;">Email</td><td style="padding:8px 14px;font-size:14px;color:#a5b4fc;"><a href="mailto:${esc(email)}" style="color:#a5b4fc;">${esc(email)}</a></td></tr>
    <tr><td style="padding:8px 14px;font-size:12px;color:#64748b;">Company</td><td style="padding:8px 14px;font-size:14px;color:#e2e8f0;">${esc(company) || '—'}</td></tr>
    <tr><td style="padding:8px 14px;font-size:12px;color:#64748b;">Timing</td><td style="padding:8px 14px;font-size:14px;color:#e2e8f0;">${esc(timing) || '—'}</td></tr>
    <tr><td style="padding:8px 14px;font-size:12px;color:#64748b;">IP</td><td style="padding:8px 14px;font-size:13px;color:#64748b;">${esc(ipAddress) || '—'}</td></tr>
    <tr><td style="padding:8px 14px;font-size:12px;color:#64748b;">Submitted</td><td style="padding:8px 14px;font-size:13px;color:#94a3b8;">${esc(submittedAt)}</td></tr>
  </table>
  <p style="margin:24px 0 0;font-size:11px;color:#334155;">Auto-reply with install instructions has already been sent to the requester. Just hit reply to start a real conversation.</p>
</div>`;
}

module.exports = { setRuntimeBrevoKey,
  sendEmail,
  assetDisplayName,
  welcomeHtml,
  passwordResetHtml,
  inviteHtml,
  feedbackHtml,
  newViewerActivationHtml,
  earlyAccessReplyHtml,
  earlyAccessNotificationHtml,
};

export {};
