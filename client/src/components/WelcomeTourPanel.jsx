import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFocusTrap } from '../hooks/useFocusTrap';
import {
  FileText, Briefcase, BarChart2, BarChart3, Sparkles, Bell, HelpCircle,
  Newspaper, ScrollText, Settings as SettingsIcon,
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
 * Reads the lapseiq_welcome_pending key the wizard sets in
 * dismiss({ celebrate: true }); the menu item sets the same key.
 * Clearing the key when the user dismisses makes this strict
 * one-shot per trigger.
 *
 * Cards are feature-gated against AuthContext.features so we don't
 * point users at /budget or /alerts if those flags are off in the
 * current self-host configuration. AI Upload card requires both the
 * ingest feature flag AND the runtime aiEnabled+aiConfigured signal.
 */

const WELCOME_PENDING_KEY = 'lapseiq_welcome_pending';

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
  const { features, aiEnabled, aiConfigured, onboardingDone, user, demoMode } = useAuth();
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
  // 'lapseiq:welcome-trigger' custom event. The localStorage write alone
  // isn't enough: if WelcomeTourPanel was already mounted (user already on
  // /dashboard) it would never re-read the key. The 'storage' event only
  // fires across tabs, not in-tab. The custom event closes that gap.
  useEffect(() => {
    function onTrigger() {
      try {
        if (localStorage.getItem(WELCOME_PENDING_KEY) === '1') setOpen(true);
      } catch (_) { /* ignore */ }
    }
    window.addEventListener('lapseiq:welcome-trigger', onTrigger);
    return () => window.removeEventListener('lapseiq:welcome-trigger', onTrigger);
  }, []);

  // #4 demo decoupling: a fresh demo sandbox has ONBOARDING_COMPLETE pre-set
  // (so the add-first-vendor wizard is skipped), which previously also meant
  // the wizard never fired the welcome-tour trigger, so the tour never showed.
  // Surface the tour once per fresh demo account. Account-keyed one-shot so a
  // stale localStorage flag from a prior sandbox can't suppress a new one.
  useEffect(() => {
    if (!demoMode || !onboardingDone) return;
    const acct = user?.accountId ?? user?.account?.id;
    if (!acct) return;
    try {
      if (localStorage.getItem(`lapseiq_welcome_seen_${acct}`) === '1') return;
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
      if (acct) localStorage.setItem(`lapseiq_welcome_seen_${acct}`, '1');
    } catch (_) { /* ignore */ }
    setOpen(false);
  }

  function go(path) {
    dismiss();
    navigate(path);
  }

  // Feature cards in sidebar order: Contracts, Reports, Vendors, Alerts,
  // Vendor News, Activity Log, Settings \u2014 plus feature-gated extras and Ask LapseIQ.
  const features_list = [];
  features_list.push({
    icon: FileText,
    title: 'Track every contract in one place',
    body: 'Browse, search, and filter your full portfolio. Vendor leads every all-up view, so "show me all VMware" is two clicks. Click any row to drill into renewal terms, savings, owner, and the AI renewal brief.',
    useFor: 'Daily reviews, cancel-by audits, vendor-by-vendor portfolio walks.',
    ctaLabel: 'Open Contracts',
    path: '/contracts',
  });
  features_list.push({
    icon: BarChart2,
    title: '30+ built-in reports, AI summary on each',
    body: 'The Reports hub covers Renewal Horizon, Auto-Renewal Exposure, Vendor Concentration, License Wastage, Savings Ledger, and 26 more. Every report has a one-click AI executive summary \u2014 click-to-generate so you only spend AI budget on things you actually look at.',
    useFor: 'Quarterly business reviews, board prep, contract audit evidence, budget justification.',
    ctaLabel: 'Open Reports',
    path: '/reports',
  });
  features_list.push({
    icon: Briefcase,
    title: 'Manage vendors as the anchor of your portfolio',
    body: 'Each vendor is the parent of every contract you have with them. Track support contacts, portal URLs, support phone, co-term complexity, and free-form notes. Use the Add-from-email-signature flow to populate contacts in one paste.',
    useFor: 'Storing the "who do I email at Microsoft for renewals?" answer once instead of in fifteen different places.',
    ctaLabel: 'Open Vendors',
    path: '/vendors',
  });
  if (features?.alerts) {
    features_list.push({
      icon: Bell,
      title: 'Email alerts before renewals fire',
      body: 'Tiered email reminders at 90, 60, and 30 days before each renewal/cancel-by date. Adjust the windows, add custom rules, or include team members on specific tiers \u2014 all in alerts settings.',
      useFor: 'Catching auto-renewal exposures; making sure the right person sees a renewal far enough out to actually negotiate.',
      ctaLabel: 'Open Alerts',
      path: '/alerts',
    });
  }
  features_list.push({
    icon: Newspaper,
    title: 'Vendor News \u2014 stay ahead of market moves',
    body: 'Real-time headlines from your vendor list, filtered by AI to surface acquisitions, price changes, security incidents, and executive moves that affect your contracts. Check it before a negotiation or renewal call.',
    useFor: 'Negotiation prep, staying ahead of vendor acquisitions, spotting security incidents before they become support calls.',
    ctaLabel: 'Open Vendor News',
    path: '/news',
  });
  features_list.push({
    icon: ScrollText,
    title: 'Activity Log \u2014 full audit trail',
    body: 'Every change in your account \u2014 contract edits, alert acknowledgements, AI calls, user logins \u2014 timestamped and attributable. Filter by user, entity type, or date range. Export for compliance or SOC 2 evidence.',
    useFor: 'Compliance audits, tracking down who changed a renewal date, verifying alert delivery.',
    ctaLabel: 'Open Activity Log',
    path: '/activity',
  });
  features_list.push({
    icon: SettingsIcon,
    title: 'Settings \u2014 configure and customize',
    body: 'Manage alert windows and thresholds, user accounts and roles, cloud marketplace sync (AWS / Azure / GCP), API keys, webhooks, and integrations. Admins can reset demo data and set the fiscal year anchor here.',
    useFor: 'Onboarding teammates, tuning alert timing, wiring up cloud spend sync, setting fiscal year.',
    ctaLabel: 'Open Settings',
    path: '/settings',
  });
  if (features?.budget) {
    features_list.push({
      icon: BarChart3,
      title: 'Forecast 12 months of renewal spend',
      body: 'Projects upcoming renewal cost across vendors, departments, and cost centers based on your actual contract data. Apply per-vendor uplift assumptions for budget conservatism. Export to Excel for finance review.',
      useFor: 'Building next-year IT budget; making the case for consolidation; defending unexpected renewal increases.',
      ctaLabel: 'Open Budget Forecast',
      path: '/budget',
    });
  }
  if (features?.ingest && aiEnabled && aiConfigured) {
    features_list.push({
      icon: Sparkles,
      title: 'Upload a PDF \u2014 AI fills in the contract',
      body: 'Drop in a contract PDF and Claude extracts vendor, product, dates, costs, auto-renewal clauses, notice periods, and more. You review every field with confidence-score dots, edit anything that looks off, and approve.',
      useFor: 'Onboarding old contracts you have stored as PDFs; processing freshly-signed renewals; bulk loading at the start of a year.',
      ctaLabel: 'Upload a contract',
      path: '/ingest',
    });
  }
  features_list.push({
    icon: HelpCircle,
    title: 'Ask LapseIQ \u2014 your in-product help',
    body: 'Click the Resources & Feedback menu in the sidebar and pick "Ask LapseIQ". Answers questions about the platform from the docs \u2014 ask how to find a feature, set up a workflow, or get renewal-management practice advice.',
    useFor: 'Skipping the Google search when you forget where a feature lives; getting a second opinion on a vendor approach.',
    ctaLabel: 'Got it',
    path: null,
  });
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to LapseIQ"
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
            Welcome to LapseIQ
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
            Tip: every all-up view leads with the vendor &mdash; that&rsquo;s the natural anchor for renewal work.
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
