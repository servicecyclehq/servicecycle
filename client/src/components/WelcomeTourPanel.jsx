import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFocusTrap } from '../hooks/useFocusTrap';
import {
  Zap, MapPin, ClipboardList, Calendar, Briefcase, Bell,
  BarChart2, ScrollText, Settings as SettingsIcon,
  PartyPopper, X as XIcon,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

/**
 * WelcomeTourPanel
 * ----------------
 * Centered modal that appears the first time the user lands on the
 * dashboard after completing the OnboardingWizard, OR on demand when
 * they click "Show welcome tour" in the sidebar Resources & Feedback menu.
 *
 * Reads the servicecycle_welcome_pending key the wizard sets in
 * dismiss({ celebrate: true }); the menu item sets the same key.
 * Clearing the key when the user dismisses makes this strict
 * one-shot per trigger.
 *
 * Cards are feature-gated against AuthContext.features so we don't
 * point users at /alerts if that flag is off in the current self-host
 * configuration.
 */

const WELCOME_PENDING_KEY = 'servicecycle_welcome_pending';

function FeatureRow({ icon: Icon, title, body, useFor, ctaLabel, onClick }) {
  return (
    <div
      style={{
        display: 'flex', gap: 14, alignItems: 'flex-start',
        padding: '14px 16px',
        background: 'var(--color-bg)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
      }}
    >
      <div
        style={{
          flexShrink: 0,
          width: 40, height: 40,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--color-primary-light)',
          color: 'var(--color-primary)',
          borderRadius: 8,
        }}
        aria-hidden="true"
      >
        <Icon size={20} strokeWidth={1.75} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--color-text, #0a0d12)', marginBottom: 3 }}>
          {title}
        </div>
        <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary, #5b6373)', lineHeight: 1.55, marginBottom: 6 }}>
          {body}
        </div>
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary, #5b6373)', fontStyle: 'italic', marginBottom: 10 }}>
          <strong style={{ fontStyle: 'normal' }}>When to use it:</strong> {useFor}
        </div>
        <button
          type="button"
          onClick={onClick}
          style={{
            background: 'var(--color-primary, #0d4f6e)', color: 'var(--color-surface)',
            border: 'none', borderRadius: 6,
            padding: '5px 12px', fontSize: 12.5, fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {ctaLabel} →
        </button>
      </div>
    </div>
  );
}

export default function WelcomeTourPanel() {
  const navigate = useNavigate();
  const { features, onboardingDone, user, demoMode } = useAuth();
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(WELCOME_PENDING_KEY) === '1'; }
    catch (_) { return false; }
  });
  // Pass-3 audit MUST #3: trap focus + restore on close.
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, { onClose: () => setOpen(false) });

  // v0.7.0 bugfix: when the OnboardingWizard's final-step "Take the tour ->"
  // button (or the Sidebar's "Show welcome tour" menu item) is clicked, the
  // caller sets WELCOME_PENDING_KEY in localStorage and dispatches a
  // 'servicecycle:welcome-trigger' custom event. The localStorage write alone
  // isn't enough: if WelcomeTourPanel was already mounted (user already on
  // /dashboard) it would never re-read the key. The 'storage' event only
  // fires across tabs, not in-tab. The custom event closes that gap.
  useEffect(() => {
    function onTrigger() {
      try {
        if (localStorage.getItem(WELCOME_PENDING_KEY) === '1') setOpen(true);
      } catch (_) { /* ignore */ }
    }
    window.addEventListener('servicecycle:welcome-trigger', onTrigger);
    return () => window.removeEventListener('servicecycle:welcome-trigger', onTrigger);
  }, []);

  // #4 demo decoupling: a fresh demo sandbox has ONBOARDING_COMPLETE pre-set
  // (so the add-first-site wizard is skipped), which previously also meant
  // the wizard never fired the welcome-tour trigger, so the tour never showed.
  // Surface the tour once per fresh demo account. Account-keyed one-shot so a
  // stale localStorage flag from a prior sandbox can't suppress a new one.
  useEffect(() => {
    if (!demoMode || !onboardingDone) return;
    const acct = user?.accountId ?? user?.account?.id;
    if (!acct) return;
    try {
      if (localStorage.getItem(`servicecycle_welcome_seen_${acct}`) === '1') return;
      localStorage.setItem(WELCOME_PENDING_KEY, '1');
      setOpen(true);
    } catch (_) { /* ignore */ }
  }, [demoMode, onboardingDone, user]);

  // v0.7.2 bugfix: WELCOME_PENDING_KEY lives in localStorage, which persists
  // across the nightly demo reset (only server data resets). A stale key from
  // a previous sandbox session would surface the tour immediately on a brand-
  // new account BEFORE the OnboardingWizard could run. Gate on
  // onboardingDone — the wizard's dismiss() with celebrate=true is the only
  // legitimate "show me the tour now" path during a new-user flow, and it
  // sets onboardingDone=true before dispatching the trigger event. Sidebar's
  // "Show welcome tour" menu item is post-onboarding by definition (the
  // menu only renders for logged-in users with a populated sidebar), so it
  // also passes this gate.
  if (!open || !onboardingDone) return null;

  function dismiss() {
    try {
      localStorage.removeItem(WELCOME_PENDING_KEY);
      const acct = user?.accountId ?? user?.account?.id;
      if (acct) localStorage.setItem(`servicecycle_welcome_seen_${acct}`, '1');
    } catch (_) { /* ignore */ }
    setOpen(false);
  }

  function go(path) {
    dismiss();
    navigate(path);
  }

  // Feature cards in sidebar order: Assets, Sites, Work Orders, Compliance
  // Calendar, Contractors, Alerts (gated), Reports, Activity Log, Settings.
  const features_list = [];
  features_list.push({
    icon: Zap,
    title: 'Track every asset in one place',
    body: 'Browse, search, and filter your full equipment inventory — transformers, switchgear, generators, panels, and more. Click any row to drill into condition, maintenance history, applied schedules, and upcoming due dates.',
    useFor: 'Daily reviews, overdue-maintenance audits, site-by-site equipment walks.',
    ctaLabel: 'Open Assets',
    path: '/assets',
  });
  features_list.push({
    icon: MapPin,
    title: 'Sites — the anchor of your portfolio',
    body: 'Each site is the parent of every asset installed there. Track addresses, site contacts, and notes your contractors need before they roll a truck. Site detail shows compliance posture at a glance.',
    useFor: 'Answering "what equipment is at the Lakeside plant and what\'s overdue?" in one click.',
    ctaLabel: 'Open Sites',
    path: '/sites',
  });
  features_list.push({
    icon: ClipboardList,
    title: 'Work orders from creation to closeout',
    body: 'Create work orders for due maintenance, assign them to contractors, and track status through completion. Completed work feeds straight back into each asset\'s compliance record.',
    useFor: 'Dispatching maintenance, tracking open jobs, documenting completed service for audits.',
    ctaLabel: 'Open Work Orders',
    path: '/work-orders',
  });
  features_list.push({
    icon: Calendar,
    title: 'Compliance calendar — see what\'s due when',
    body: 'Every scheduled maintenance task across all sites and assets on one calendar, driven by the NFPA 70B intervals you applied. Overdue items surface in red so nothing slips quietly.',
    useFor: 'Monthly planning, budgeting contractor visits, spotting clusters of due work to batch into one dispatch.',
    ctaLabel: 'Open Calendar',
    path: '/calendar',
  });
  features_list.push({
    icon: Briefcase,
    title: 'Manage contractors and their work',
    body: 'Each contractor record tracks contacts, certifications, and the work orders you\'ve assigned them. Store the "who do I call for switchgear testing?" answer once instead of in fifteen places.',
    useFor: 'Picking the right shop for a job; reviewing a vendor\'s history before renewing their service agreement.',
    ctaLabel: 'Open Contractors',
    path: '/contractors',
  });
  if (features?.alerts) {
    features_list.push({
      icon: Bell,
      title: 'Alerts before maintenance lapses',
      body: 'ServiceCycle surfaces overdue maintenance, upcoming due dates, and compliance gaps on the Alerts page and by email. Tune the lead-time windows in Settings when you are ready.',
      useFor: 'Catching overdue tasks; making sure the right person sees due maintenance far enough out to schedule a contractor.',
      ctaLabel: 'Open Alerts',
      path: '/alerts',
    });
  }
  features_list.push({
    icon: BarChart2,
    title: 'Reports — compliance evidence on demand',
    body: 'The Reports hub turns your maintenance records into compliance summaries, overdue-work rollups, and audit-ready evidence. Export for insurers, AHJs, or management review.',
    useFor: 'Insurance audits, management reviews, demonstrating NFPA 70B program compliance.',
    ctaLabel: 'Open Reports',
    path: '/reports',
  });
  features_list.push({
    icon: ScrollText,
    title: 'Activity Log — full audit trail',
    body: 'Every change in your account — asset edits, work order updates, alert acknowledgements, user logins — timestamped and attributable. Filter by user, entity type, or date range. Export for compliance evidence.',
    useFor: 'Compliance audits, tracking down who changed a maintenance date, verifying alert delivery.',
    ctaLabel: 'Open Activity Log',
    path: '/activity',
  });
  features_list.push({
    icon: SettingsIcon,
    title: 'Settings — configure and customize',
    body: 'Manage alert windows and thresholds, user accounts and roles, equipment type defaults, API keys, webhooks, and integrations. Admins can reset demo data here.',
    useFor: 'Onboarding teammates, tuning alert timing, wiring up integrations.',
    ctaLabel: 'Open Settings',
    path: '/settings',
  });
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to ServiceCycle"
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000,
        padding: '2rem 1rem',
        overflowY: 'auto',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) dismiss(); }}
    >
      <div
        style={{
          background: 'var(--color-surface, #ffffff)',
          borderRadius: 14,
          padding: '28px 28px 22px',
          maxWidth: 720,
          width: '100%',
          boxShadow: '0 25px 70px rgba(0,0,0,0.25)',
          maxHeight: 'calc(100vh - 4rem)',
          overflowY: 'auto',
          position: 'relative',
        }}
      >
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss welcome tour"
          style={{
            position: 'absolute', top: 14, right: 16,
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--color-text-secondary)',
            lineHeight: 0, padding: 4,
          }}
          title="Dismiss"
        >
          <XIcon size={20} strokeWidth={2} />
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <PartyPopper size={28} strokeWidth={1.75} color="var(--color-primary)" aria-hidden="true" />
          <h2 style={{
            margin: 0,
            fontSize: 'var(--font-size-xl)', fontWeight: 700,
            color: 'var(--color-text, #0a0d12)',
          }}>
            Welcome to ServiceCycle
          </h2>
        </div>
        <p style={{
          margin: '0 0 18px',
          fontSize: 13.5, lineHeight: 1.6,
          color: 'var(--color-text-secondary, #5b6373)',
        }}>
          You&rsquo;re set up &mdash; here&rsquo;s a quick tour of the main features. Click any <strong style={{ color: 'var(--color-primary, #0d4f6e)' }}>Open</strong> button to jump straight in, or close this and explore on your own. Anytime you want this back, click <strong>Resources &amp; Feedback &rarr; Show welcome tour</strong> in the sidebar.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {features_list.map((f, i) => (
            <FeatureRow
              key={i}
              icon={f.icon}
              title={f.title}
              body={f.body}
              useFor={f.useFor}
              ctaLabel={f.ctaLabel}
              onClick={() => (f.path ? go(f.path) : dismiss())}
            />
          ))}
        </div>

        <div style={{ marginTop: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
          <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary, #5b6373)' }}>
            Tip: every all-up view leads with the site &mdash; that&rsquo;s the natural anchor for maintenance work.
          </span>
          <button
            type="button"
            onClick={dismiss}
            style={{
              background: 'transparent',
              border: '1px solid var(--color-border, #dde2eb)',
              color: 'var(--color-text, #0a0d12)',
              padding: '8px 16px', borderRadius: 8,
              fontSize: 'var(--font-size-ui)', fontWeight: 600, cursor: 'pointer',
            }}
          >
            Done &mdash; explore on my own
          </button>
        </div>
      </div>
    </div>
  );
}
