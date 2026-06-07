/**
 * OnboardingWizard
 *
 * First-login guided flow for new accounts. Shows as a full-screen overlay
 * with three optional steps:
 *   1. Add your first vendor
 *   2. Add your first contract
 *   3. Configure renewal alerts
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

// New tour structure - v0.63.0 (2026-05-21)
//
// Refreshed from the v0.10-v0.20 era. The original 4-step flow (vendor ->
// contract -> fiscal year -> done) was missing every major surface shipped
// since: 14-report Reports hub with AI summaries (v0.58-v0.62), alerts page
// (v0.4), renewal brief generator (v0.4), Ask LapseIQ (v0.14). New 7-step
// flow folds those in as a mix of action steps (paths the user follows now)
// and info steps (descriptive; "Continue" advances without nav). Info steps
// are gated by isInfo=true and have primaryPath=null.

const STEPS = [
  {
    id: 'vendor',
    icon: (
      <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 48, height: 48, color: 'var(--accent)' }}>
        <rect x="4" y="20" width="40" height="22" rx="3"/>
        <path d="M12 20V14a12 12 0 0 1 24 0v6"/>
        <circle cx="24" cy="31" r="3" fill="currentColor" stroke="none"/>
      </svg>
    ),
    heading: 'Add your first vendor',
    body: 'Vendors are the companies you buy software, services, telecom, hardware, leases, insurance, or anything else from. LapseIQ ships with 9 categories out of the box and you can add more.',
    primaryLabel: 'Add a vendor',
    primaryPath: '/vendors?new=1',
    skipLabel: 'Skip this step',
  },
  {
    id: 'contract',
    icon: (
      <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 48, height: 48, color: 'var(--accent)' }}>
        <rect x="8" y="4" width="28" height="40" rx="3"/>
        <line x1="15" y1="15" x2="29" y2="15"/>
        <line x1="15" y1="22" x2="32" y2="22"/>
        <line x1="15" y1="29" x2="26" y2="29"/>
      </svg>
    ),
    heading: 'Add your first contract',
    body: 'Enter renewal dates, value, auto-renewal terms, and cancel-by windows. LapseIQ alerts you before anything lapses and (optionally) generates an AI-drafted renewal brief when negotiation time comes around.',
    primaryLabel: 'Add a contract',
    primaryPath: '/contracts/new',
    skipLabel: 'Skip this step',
  },
  {
    id: 'reports',
    icon: (
      <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 48, height: 48, color: 'var(--accent)' }}>
        <rect x="6" y="6" width="36" height="36" rx="3"/>
        <path d="M14 32V22M22 32V14M30 32V26M38 32V18"/>
      </svg>
    ),
    heading: '30+ built-in reports, AI summary on each',
    body: 'The Reports hub covers Renewal Horizon, Auto-Renewal Exposure, Vendor Concentration, License Wastage, Audit Evidence Pack, and 26 more. Every report has a one-click AI executive summary at the top -- click-to-generate so you only spend AI budget on things you actually look at.',
    primaryLabel: 'Open Reports',
    primaryPath: '/reports',
    skipLabel: 'Skip this step',
  },
  {
    id: 'alerts',
    icon: (
      <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 48, height: 48, color: 'var(--accent)' }}>
        <path d="M12 36V20a12 12 0 0 1 24 0v16"/>
        <path d="M8 36h32"/>
        <path d="M20 40a4 4 0 0 0 8 0"/>
      </svg>
    ),
    heading: 'Alerts catch what you would miss',
    body: 'Auto-renewal exposures, contracts past their cancel-by date, evaluations due -- LapseIQ surfaces them on the Alerts page with column filters and saved views. Defaults are 90 / 60 / 30 days; tune them in Settings -> Alerts when you are ready.',
    primaryLabel: 'Continue ->',
    primaryPath: null,
    skipLabel: 'Skip this step',
    isInfo: true,
  },
  {
    id: 'ai',
    icon: (
      <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 48, height: 48, color: 'var(--accent)' }}>
        <path d="M24 6 l4 10 l10 4 l-10 4 l-4 10 l-4 -10 l-10 -4 l10 -4 z"/>
        <circle cx="40" cy="14" r="2" fill="currentColor" stroke="none"/>
        <circle cx="8" cy="40" r="2" fill="currentColor" stroke="none"/>
      </svg>
    ),
    heading: 'AI does the heavy lifting (when you ask)',
    body: 'Renewal Briefs draft negotiation talking points. Ask LapseIQ answers questions about the platform from the corner of every page. PDF extraction reads scanned contracts. Every AI surface is click-to-generate and your budget is yours -- self-host installs use whichever provider you configure.',
    primaryLabel: 'Continue ->',
    primaryPath: null,
    skipLabel: 'Skip this step',
    isInfo: true,
  },
  {
    id: 'fiscal_year',
    icon: (
      <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 48, height: 48, color: 'var(--accent)' }}>
        <rect x="6" y="10" width="36" height="32" rx="3"/>
        <path d="M6 18h36"/>
        <path d="M16 6v8M32 6v8"/>
        <path d="M14 26h6M14 33h6M28 26h6M28 33h6"/>
      </svg>
    ),
    heading: 'Set your fiscal year',
    body: "When does your fiscal year start? This controls how contracts are grouped in calendar + budget views and the FY anchor on every executive report. Change it any time in Settings.",
    primaryLabel: null,
    primaryPath: null,
    skipLabel: 'Skip -- use January',
    isInline: true,
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
    body: 'Your renewal calendar is live. Press ? anywhere in the app to open the Help drawer, or click the AI assistant in the corner of any page if a question comes up.',
    primaryLabel: 'Take the tour ->',
    primaryPath: '/dashboard',
    skipLabel: 'Skip this step',
    isFinal: true,
  },
];

// ── Component ─────────────────────────────────────────────────────────────────

// localStorage key for resuming the wizard at the saved step when the user
// navigates away (e.g. clicks "Add a vendor" -> /vendors/new -> creates one
// -> comes back to /dashboard). Cleared whenever the wizard is dismissed
// for real (final-step "Get started" or "Skip setup entirely"), so the
// next user / next session starts fresh.
const ONBOARDING_STEP_KEY = 'lapseiq_onboarding_step';

// Set when the user successfully completes the wizard (final step's
// primary or "Get started" - NOT the explicit "Skip setup entirely" link
// which is the user telling us they want quiet). Read by Dashboard's
// WelcomeTourPanel on the user's next /dashboard visit; the panel
// clears the key when dismissed. Carries no user data.
const WELCOME_PENDING_KEY = 'lapseiq_welcome_pending';

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
  const [fyMonth, setFyMonth] = useState('1');
  const [savingFy, setSavingFy] = useState(false);
  const [fyError, setFyError] = useState('');

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
  // task each step asks them to do (Add a vendor, Add a contract, etc.).
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
      try { window.dispatchEvent(new Event('lapseiq:welcome-trigger')); }
      catch (_) { /* older browsers without Event constructor — skip */ }
    }
  }

  async function saveFyAndContinue() {
    if (savingFy) return;
    setFyError('');
    setSavingFy(true);
    try {
      await api.put('/api/settings', { FISCAL_YEAR_START_MONTH: fyMonth });
    } catch (_) {
      // non-fatal — setting can be updated in Settings page later
      setFyError('Could not save fiscal year start — you can update it later in Settings.');
    } finally {
      setSavingFy(false);
    }
    advanceTo(step + 1);
  }

  function handlePrimary() {
    // Advance to the next step BEFORE navigating away so when the user
    // comes back to /dashboard the wizard resumes at the next step rather
    // than re-asking them to do the one they just did. Previously this
    // function called dismiss() which permanently hid the wizard and
    // stranded the user without the rest of setup.
    if (!isLast) {
      advanceTo(step + 1);
    }
    // v0.63.0: info steps (isInfo=true) have primaryPath=null and just
    // advance the wizard in place -- no navigation. Guard accordingly so
    // we don't crash react-router by passing null to navigate().
    if (current.primaryPath) {
      navigate(current.primaryPath);
    }
    // On the final step, the primary action is "Go to alerts settings";
    // dismiss the wizard there since the user is heading off to finish
    // up and won't be back in this flow. celebrate=true so the next
    // time they hit /dashboard a welcome panel acknowledges they're set
    // up and points at the main features.
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

        {/* Inline fiscal year picker */}
        {current.isInline && (
          <div style={{ margin: '12px 0 4px', textAlign: 'left' }}>
            <label style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, color: 'var(--color-text)', display: 'block', marginBottom: 6 }}>
              Fiscal year starts in
            </label>
            <select
              aria-label="Fiscal year starts in"
              value={fyMonth}
              onChange={e => setFyMonth(e.target.value)}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--color-border)', fontSize: 'var(--font-size-data)', background: 'var(--color-surface)' }}
            >
              {['January','February','March','April','May','June',
                'July','August','September','October','November','December'].map((name, i) => (
                <option key={i + 1} value={String(i + 1)}>
                  {name}{i === 0 ? ' (calendar year — most common)' : ''}
                </option>
              ))}
            </select>
            {fyError && (
              <p role="alert" aria-live="polite" style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-danger)', marginTop: 6 }}>
                {fyError}
              </p>
            )}
          </div>
        )}

        {/* Actions */}
        <div style={styles.actions}>
          {current.isInline ? (
            <button style={styles.primary} onClick={saveFyAndContinue} disabled={savingFy}>
              {savingFy ? 'Saving…' : 'Save & Continue →'}
            </button>
          ) : (
            <button style={styles.primary} onClick={handlePrimary}>
              {current.primaryLabel}
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
    // Brand blue button. Was previously var(--accent) which evaluated to
    // empty so the button rendered as the browser-default gray with white
    // text invisible against it. --color-primary is the brand blue used
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
