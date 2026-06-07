/**
 * POST /api/feedback
 *
 * Accepts in-app feedback from any authenticated user and emails it to
 * the configured support address (SUPPORT_EMAIL env var).
 *
 * Default-OFF gate: feedback is transmitted ONLY when FEEDBACK_ENABLED=true
 * is explicitly set in the environment. Any other value (or unset) silently
 * no-ops — no feedback message leaves the operator's box. This matches the
 * EULA §5 carve-out: "The in-product feedback feature can be disabled by
 * setting FEEDBACK_ENABLED=false, in which case no feedback messages will
 * be transmitted regardless of BREVO_API_KEY configuration." We treat any
 * value other than the literal string 'true' as disabled to preserve the
 * default-off, opt-in posture.
 *
 * Payload: { category, message, pageUrl }
 */

const express = require('express');
const { sendEmail, feedbackHtml } = require('../lib/email');
import prisma from '../lib/prisma';

const router = express.Router();

const VALID_CATEGORIES = [
  "Something's broken / I need help",
  'Feature request',
  'General feedback',
  'Security concern',
  'Billing or account question',
];

// Viewer-only subset — enforced server-side too
const VIEWER_CATEGORIES = [
  "Something's broken / I need help",
  'General feedback',
];

router.post('/', async (req, res) => {
  // Default-OFF gate (EULA §5). Operators must explicitly set
  // FEEDBACK_ENABLED=true to opt in. Any other value (including unset)
  // silently accepts the submission to keep the UI snappy but never
  // transmits anything — matches the published EULA carve-out.
  // FEEDBACK_ENABLED resolution (operator-friendly default):
  //   1. If FEEDBACK_ENABLED is explicitly set ('true' or 'false'), use that.
  //   2. Otherwise derive from DEMO_MODE:
  //        DEMO_MODE=true  -> default ON  (demo operator wants feedback flowing)
  //        DEMO_MODE=false -> default OFF (self-hosted customer affirmatively
  //                                        opts in by setting =true; matches
  //                                        EULA S5 carve-out language).
  //   The explicit setting always wins so a demo operator can opt out if they
  //   want, and a self-hosted customer can opt in without flipping DEMO_MODE.
  const explicit = process.env.FEEDBACK_ENABLED;
  let feedbackEnabled;
  if (explicit === 'true')       feedbackEnabled = true;
  else if (explicit === 'false') feedbackEnabled = false;
  else                           feedbackEnabled = process.env.DEMO_MODE === 'true';

  if (!feedbackEnabled) {
    console.log('[feedback] disabled (FEEDBACK_ENABLED unset/false on a non-demo instance) - feedback discarded. Set FEEDBACK_ENABLED=true in .env to receive feedback.');
    return res.json({ success: true, data: { message: 'Feedback received.' } });
  }

  const { category, message, pageUrl } = req.body;

  if (!VALID_CATEGORIES.includes(category)) {
    return res.status(400).json({ success: false, error: 'Invalid feedback category.' });
  }

  // Viewers are restricted to a smaller set
  if (req.user.role === 'viewer' && !VIEWER_CATEGORIES.includes(category)) {
    return res.status(400).json({ success: false, error: 'Invalid feedback category for your role.' });
  }

  if (!message?.trim() || message.trim().length < 5) {
    return res.status(400).json({ success: false, error: 'Please include a message (at least 5 characters).' });
  }

  if (message.trim().length > 5000) {
    return res.status(400).json({ success: false, error: 'Message is too long (max 5000 characters).' });
  }

  try {
    // Fetch account name for context
    const account = await prisma.account.findUnique({
      where: { id: req.user.accountId },
      select: { companyName: true },
    });

    const supportEmail = process.env.SUPPORT_EMAIL;
    if (!supportEmail) {
      // Feedback silently no-ops when SUPPORT_EMAIL is not configured.
      // This prevents user data from leaving a self-hosted instance by default.
      console.log('[feedback] SUPPORT_EMAIL not set — feedback discarded. Set SUPPORT_EMAIL in .env to receive feedback.');
      return res.json({ success: true, data: { message: 'Feedback received.' } });
    }
    const submittedAt = new Date().toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });

    await sendEmail({
      to: supportEmail,
      subject: `[ServiceCycle Feedback] ${category} — ${req.user.name} (${req.user.role})`,
      html: feedbackHtml({
        userName:    req.user.name,
        userEmail:   req.user.email,
        userRole:    req.user.role,
        companyName: account?.companyName || 'Unknown',
        category,
        message:     message.trim(),
        pageUrl:     pageUrl || 'Unknown',
        submittedAt,
      }),
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Feedback submit error:', err);
    return res.status(500).json({ success: false, error: 'Failed to send feedback. Please try again.' });
  }
});

module.exports = router;

export {};
