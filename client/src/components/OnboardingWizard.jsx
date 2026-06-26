/**
 * OnboardingWizard
 *
 * First-login guided flow for new accounts. Shows as a full-screen overlay
 * with optional steps:
 *   1. Add your first site
 *   2. Add your first asset
 *   3. Apply NFPA 70B maintenance schedules (bulk-apply)
 *   4. Invite your team
 *
 * Any step can be skipped. The wizard dismisses permanently once the user
 * clicks "Get started" on the final step or "Skip setup" at any point.
 * State is persisted to AccountSetting via AuthContext.dismissOnboarding().
 */

import { useState, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useFocusTrap } from '../hooks/useFocusTrap';
import api from '../api/client';

// ServiceCycle tour structure — sites -> assets -> schedules -> team.
// Mirrors the order the data model needs: assets belong to sites, schedules
// attach to assets, and team invites only matter once there's something
// to look at.

const STEPS = [
  {
    id: 'site',
    icon: (
      <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 48, height: 48, color: 'var(--accent)' }}>
        <path d="M8 42V16l16-10 16 10v26"/>
        <path d="M4 42h40"/>
        <path d="M19 42v-12h10v12"/>
      </svg>
    ),
    heading: 'Add your first site',
    body: 'Sites are the buildings, plants, or campuses where your electrical equipment lives. Every asset belongs to a site, so this is the natural starting point. Add the address and any site-level notes your contractors will need.',
    primaryLabel: 'Add a site',
    primaryPath: '/sites?new=1',
    skipLabel: 'Skip this step',
  },
  {
    id: 'asset',
    icon: (
      <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 48, height: 48, color: 'var(--accent)' }}>
        <path d="M26 4 L12 28 h10 L22 44 L36 20 h-10 z"/>
      </svg>
    ),
    heading: 'Add your first asset',
    body: 'Assets are the transformers, switchgear, generators, panels, and other electrical equipment you maintain. Record manufacturer, model, install date, and condition — ServiceCycle tracks the maintenance each one needs and when.',
    primaryLabel: 'Add an asset',
    primaryPath: '/assets/new',
    skipLabel: 'Skip this step',
  },
  {
    id: 'schedules',
    icon: (
      <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 48, height: 48, color: 'var(--accent)' }}>
        <rect x="6" y="10" width="36" height="32" rx="3"/>
        <path d="M6 18h36"/>
        <path d="M16 6v8M32 6v8"/>
        <path d="M15 27 l5 5 l9 -9" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    heading: 'Apply NFPA 70B schedules',
    body: 'ServiceCycle ships with NFPA 70B-based maintenance intervals for every equipment type. Bulk-apply them across your assets in one action — each asset gets its recommended schedule based on type and condition, and the compliance calendar fills itself in.',
    primaryLabel: 'Apply schedules',
    primaryPath: '/assets?bulkSchedules=1',
    skipLabel: 'Skip this step',
  },
  {
    id: 'team',
    icon: (
      <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 48, height: 48, color: 'var(--accent)' }}>
        <circle cx="17" cy="16" r="7"/>
        <path d="M4 42v-3a13 13 0 0 1 26 0v3"/>
        <circle cx="35" cy="18" r="5"/>
        <path d="M34 42v-2a10 10 0 0 0-5-8.7"/>
      </svg>
    ),
    heading: 'Invite your team',
    body: 'Bring in the people who do the work: managers who plan maintenance, viewers who need read-only visibility, and maintenance vendor account managers with consultant access. Everyone sees the same calendar and asset history.',
    primaryLabel: 'Invite teammates',
    primaryPath: '/users',
    skipLabel: 'Skip this step',
  },
  {
    id: 'done',
    icon: (
      <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 48, height: 48, color: 'var(--accent)' }}>
        <circle cx="24" cy="24" r="20"/>
        <path d="M16 25 l6 6 l12 -14" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    heading: 'You are all set',
    body: 'Your compliance calendar is live. Press ? anywhere in the app to open the Help drawer if a question comes up, and check the Alerts page for anything overdue.',
    primaryLabel: 'Take the tour ->',
    primaryPath: '/dashboard',
    skipLabel: 'Skip this step',
    isFinal: true,
  },
];

// ── Component ─────────────────────────────────────────────────────────────────

// localStorage key for resuming the wizard at the saved step when the user
// navigates away (e.g. clicks "Add a site" -> /sites -> creates one
// -> comes back to /dashboard). Cleared whenever the wizard is dismissed
// for real (final-step "Get started" or "Skip setup entirely"), so the
// next user / next session starts fresh.
const ONBOARDING_STEP_KEY = 'servicecycle_onboarding_step';

// Set when the user successfully completes the wizard (final step's
// primary or "Get started" - NOT the explicit "Skip setup entirely" link
// which is the user telling us they want quiet). Read by Dashboard's
// WelcomeTourPanel on the user's next /dashboard visit; the panel
// clears the key when dismissed. Carries no user data.
const WELCOME_PENDING_KEY = 'servicecycle_welcome_pending';

export default function OnboardingWizard() {
  const { dismissOnboarding, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Resume at the step the user was last on, if any. Clamp into bounds in
  // case STEPS shrinks across deploys.
  const [step, setStep] = useState(() => {
    // T8-N1: prefer server-synced step (cross-device); fall back to localStorage.
    const serverStep = user?.onboardingStep ?? null;
    const saved = parseInt(localStorage.getItem(ONBOARDING_STEP_KEY) ?? '0', 10);
    const localStep = Number.isNaN(saved) || saved < 0 ? 0 : saved;
    const initial = serverStep !== null ? serverStep : localStep;
    return Math.min(initial, STEPS.length - 1);
  });
  const [dismissing, setDismissing] = useState(false);

  // Pass-3 audit MUST #3 + LOW #5: trap focus + announce as dialog. Pre-fix
  // the wizard was a styled overlay with no role/aria-modal so SR users
  // had no way to know they'd been interrupted by an overlay, and Tab
  // would escape to the dashboard underneath.
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, { onClose: () => dismiss({ celebrate: false }) });

  const current = STEPS[step];
  const isLast  = step === STEPS.length - 1;

  // The wizard is mounted at App-level (App.jsx renders it for every
  // authenticated route until dismissed). That means it would overlay
  // every page in the app and block the user from completing the very
  // task each step asks them to do (Add a site, Add an asset, etc.).
  // Scope it to /dashboard only - clicking a primary action navigates
  // away to the task page, the wizard stops rendering, the user does
  // the task, and when they navigate back to /dashboard the wizard
  // re-renders at the saved step (via localStorage in advanceTo).
  if (location.pathname !== '/dashboard') {
    return null;
  }

  // Helper that persists the step BEFORE we navigate away. Without this,
  // the wizard's local component state is destroyed on navigation and the
  // user would resume at step 0 every time they come back to /dashboard.
  function advanceTo(nextStep) {
    setStep(nextStep);
    try { localStorage.setItem(ONBOARDING_STEP_KEY, String(nextStep)); } catch (_) { /* ignore */ }
    // v0.71.3 (audit Quick Win): also persist to user.onboardingStep so the
    // wizard resumes across devices. Fail-open -- localStorage already saved.
    api.put('/api/users/me', { onboardingStep: nextStep }).catch(() => { /* fail open */ });
  }

  async function dismiss({ celebrate = false } = {}) {
    if (dismissing) return;
    setDismissing(true);
    try {
      localStorage.removeItem(ONBOARDING_STEP_KEY);
      if (celebrate) localStorage.setItem(WELCOME_PENDING_KEY, '1');
    } catch (_) { /* ignore */ }
    await dismissOnboarding();
    // v0.7.0 bugfix: WelcomeTourPanel reads the key only at mount time. If
    // it was already mounted (user already on /dashboard, which is the only
    // place this wizard renders), the panel would never open. Dispatch a
    // synchronous custom event after dismissOnboarding() resolves so the
    // panel can flip itself open in-place.
    if (celebrate) {
      try { window.dispatchEvent(new Event('servicecycle:welcome-trigger')); }
      catch (_) { /* older browsers without Event constructor — skip */ }
    }
  }

  function handlePrimary() {
    // Advance to the next step BEFORE navigating away so when the user
    // comes back to /dashboard the wizard resumes at the next step rather
    // than re-asking them to do the one they just did.
    if (!isLast) {
      advanceTo(step + 1);
    }
    if (current.primaryPath) {
      navigate(current.primaryPath);
    }
    // On the final step, dismiss the wizard with celebrate=true so the
    // next time they hit /dashboard the welcome panel acknowledges
    // they're set up and points at the main features.
    if (isLast) {
      dismiss({ celebrate: true });
    }
  }

  function handleSkip() {
    if (isLast) {
      // "Get started ->" on the final step. They reached the end of the
      // wizard without bailing - same celebration as the primary path.
      dismiss({ celebrate: true });
    } else {
      advanceTo(step + 1);
    }
  }

  return (
    <div style={styles.overlay}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-step-title"
        style={styles.card}
      >

        {/* Progress dots */}
        <div role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={step + 1} aria-label={`Onboarding step ${step + 1} of ${STEPS.length}`} style={styles.dots}>
          {STEPS.map((s, i) => (
            <div
              key={s.id}
              style={{
                ...styles.dot,
                background: i === step
                  ? 'var(--accent)'
                  : i < step
                    ? 'var(--accent-muted, #c7d2fe)'
                    : 'var(--border)',
              }}
            />
          ))}
        </div>

        {/* Icon */}
        <div style={styles.iconWrap}>{current.icon}</div>

        {/* Step label */}
        <div style={styles.stepLabel}>Step {step + 1} of {STEPS.length}</div>

        {/* Heading */}
        <h2 id="onboarding-step-title" style={styles.heading}>{current.heading}</h2>

        {/* Body */}
        <p style={styles.body}>{current.body}</p>

        {/* Actions */}
        <div style={styles.actions}>
          <button style={styles.primary} onClick={handlePrimary}>
            {current.primaryLabel}
          </button>
          {current.id === 'asset' && (
            <button
              onClick={() => { advanceTo(step + 1); navigate('/import'); }}
              style={{
                background: 'none', border: 'none', color: 'var(--color-primary)',
                textDecoration: 'underline', cursor: 'pointer', fontSize: '0.875rem',
                marginTop: '8px'
              }}
            >
              Have a spreadsheet? Import multiple assets at once →
            </button>
          )}
          <button style={styles.skip} onClick={handleSkip}>
            {isLast ? 'Get started →' : current.skipLabel}
          </button>
        </div>

        {/* Dismiss link - explicit "leave me alone" outlet. No
            celebration; user is opting out, not finishing. */}
        <button style={styles.dismiss} onClick={() => dismiss({ celebrate: false })}>
          Skip setup entirely
        </button>
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: '1rem',
  },
  card: {
    // Solid white card. Was previously var(--bg) which is not a defined
    // CSS variable in this theme (the convention is --color-* prefix), so
    // the card rendered transparent and the dashboard bled through.
    // Using --color-surface with explicit #ffffff fallback so the card
    // renders correctly even before stylesheets load.
    background: 'var(--color-surface, #ffffff)',
    borderRadius: 16,
    padding: '2.5rem 2rem',
    maxWidth: 460,
    width: '100%',
    textAlign: 'center',
    boxShadow: '0 24px 60px rgba(0,0,0,0.2)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.75rem',
  },
  dots: {
    display: 'flex',
    gap: 6,
    marginBottom: '0.5rem',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    transition: 'background 0.2s',
  },
  iconWrap: {
    marginBottom: '0.25rem',
  },
  stepLabel: {
    fontSize: '0.75rem',
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--color-text-secondary, #5b6373)',
  },
  heading: {
    fontSize: '1.35rem',
    fontWeight: 700,
    color: 'var(--color-text, #0a0d12)',
    margin: '0.25rem 0 0',
  },
  body: {
    fontSize: '0.9rem',
    color: 'var(--color-text-secondary, #5b6373)',
    lineHeight: 1.6,
    margin: '0.25rem 0 0.75rem',
  },
  actions: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    width: '100%',
  },
  primary: {
    // Brand blue button. --color-primary is the brand blue used
    // throughout the rest of the app.
    background: 'var(--color-primary, #0d4f6e)',
    color: 'var(--color-surface)',
    border: 'none',
    borderRadius: 8,
    padding: '0.65rem 1.5rem',
    fontSize: '0.9rem',
    fontWeight: 600,
    cursor: 'pointer',
    width: '100%',
  },
  skip: {
    background: 'var(--color-bg, #fafbfd)',
    color: 'var(--color-text-secondary, #5b6373)',
    border: '1px solid var(--color-border, #dde2eb)',
    borderRadius: 8,
    padding: '0.6rem 1.5rem',
    fontSize: '0.9rem',
    fontWeight: 500,
    cursor: 'pointer',
    width: '100%',
  },
  dismiss: {
    // 2026-05-10 review L1: lift the "Skip setup entirely" link out of the
    // 0.7-opacity / 0.8rem near-disappear treatment. It IS a real choice
    // (especially for demo visitors who just want to look around) and the
    // previous styling buried it. Slightly larger, slightly more saturated
    // colour, still clearly tertiary so it doesn't compete with the primary
    // CTA.
    background: 'none',
    border: 'none',
    color: 'var(--color-text-secondary, #5b6373)',
    fontSize: '0.875rem',
    cursor: 'pointer',
    marginTop: '0.5rem',
    textDecoration: 'underline',
    opacity: 1,
  },
};
