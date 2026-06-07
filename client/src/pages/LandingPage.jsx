/**
 * LandingPage
 *
 * Public marketing page served at the root URL ("/") for unauthenticated visitors.
 * Authenticated users are redirected to /dashboard before this renders.
 *
 * Sections:
 *   - Nav bar with logo + login CTA
 *   - Hero: headline, sub-copy, primary CTA
 *   - Feature highlights (3-up cards)
 *   - How it works (3 steps)
 *   - Freemium hook placeholder
 *   - Footer
 */

import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';

// ── Feature card data ─────────────────────────────────────────────────────────

const FEATURES = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 28, height: 28 }}>
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      </svg>
    ),
    title: 'Catch overdue maintenance before the auditor does',
    body: 'Tiered alerts at 180, 120, 90, 60, 30, and 7 days before each task is due — then automatic overdue and escalation tiers if nothing gets completed. Nothing slips into a regulatory breach silently.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 28, height: 28 }}>
        <path d="M12 2 L2 7 L12 12 L22 7 Z"/>
        <path d="M2 17 L12 22 L22 17"/>
        <path d="M2 12 L12 17 L22 12"/>
      </svg>
    ),
    title: 'Condition-based intervals, straight from NFPA 70B',
    body: 'Every asset carries a governing condition (1, 2, or 3) and ServiceCycle derives the maintenance interval the standard prescribes — transformers, switchgear, breakers, panelboards, MCCs, UPS systems, and more. Change the condition after an assessment and every schedule recalculates.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 28, height: 28 }}>
        <path d="M4 11a9 9 0 0 1 9 9"/>
        <path d="M4 4a16 16 0 0 1 16 16"/>
        <circle cx="5" cy="19" r="1.5"/>
      </svg>
    ),
    title: 'NETA test records, attached to the asset',
    body: 'Store acceptance and maintenance test results — insulation resistance, contact resistance, trip timing — against the asset that produced them. The decal trail and measurement history are ready when the AHJ or your insurer asks.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 28, height: 28 }}>
        <line x1="12" y1="20" x2="12" y2="10"/>
        <line x1="18" y1="20" x2="18" y2="4"/>
        <line x1="6" y1="20" x2="6" y2="16"/>
      </svg>
    ),
    title: 'Work orders that close the loop',
    body: 'Generate work orders from due schedules, assign them to your contractor, and record completion with measurements and deficiencies. Completing the work order advances the schedule automatically.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 28, height: 28 }}>
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
        <circle cx="12" cy="7" r="4"/>
      </svg>
    ),
    title: 'Contractors and NETA accreditation, tracked',
    body: 'Keep your electrical testing contractors, their technicians, and their NETA accreditation status in one place — and know who performed every task on every asset.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 28, height: 28 }}>
        <circle cx="12" cy="12" r="10"/>
        <polyline points="12 6 12 12 16 14"/>
      </svg>
    ),
    title: 'AI extraction from nameplates and test reports',
    body: 'Drop in a nameplate photo or a test-report PDF and the AI pulls manufacturer, model, serial, ratings, and measurements. Review and confirm before anything lands in the database — extraction is a first draft, not a commit.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 28, height: 28 }}>
        <rect x="2" y="3" width="20" height="14" rx="2"/>
        <line x1="8" y1="21" x2="16" y2="21"/>
        <line x1="12" y1="17" x2="12" y2="21"/>
      </svg>
    ),
    title: 'Compliance calendar by site and month',
    body: 'See every scheduled task across all your sites on one calendar — what is due, what is overdue, and what requires an outage window to perform.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 28, height: 28 }}>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
    ),
    title: 'Roles, scoped viewers, and consultants',
    body: 'Admins, managers, and read-only viewers. Invite an outside consultant or testing contractor for a specific program review and revoke access in one click.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 28, height: 28 }}>
        <path d="M9 11l3 3L22 4"/>
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
      </svg>
    ),
    title: 'Built-in audit log',
    body: 'Every login, asset change, document access, and permission denial is recorded with the user, IP, and timestamp. Visible to admins, exportable on demand — evidence for OSHA, your insurer, or the AHJ.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 28, height: 28 }}>
        <circle cx="6" cy="6" r="3"/>
        <circle cx="18" cy="6" r="3"/>
        <circle cx="12" cy="18" r="3"/>
        <path d="M7.5 8 L11 15"/>
        <path d="M16.5 8 L13 15"/>
      </svg>
    ),
    title: 'Bring your own AI — your data, your provider',
    body: 'Choose Anthropic Claude, OpenAI, Azure OpenAI, or Google Gemini. Use your existing enterprise agreement, your existing data-residency region, your existing AI governance. No ServiceCycle-controlled data path, no markup on per-call cost, no new vendor relationship to onboard.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 28, height: 28 }}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="12" y1="18" x2="12" y2="12"/>
        <polyline points="9 15 12 18 15 15"/>
      </svg>
    ),
    title: 'Your data, your audit trail, your export',
    body: 'Every asset, test record, work order, and audit log line exports cleanly to CSV or XLSX — anytime, no enterprise-tier gating, no "request export" form. If you ever want to leave, you walk away with the complete maintenance record. We hold nothing of yours hostage.',
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ width: 28, height: 28 }}>
        <rect x="3" y="11" width="18" height="11" rx="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
    ),
    title: 'Self-hosted, telemetry-free',
    body: 'Runs on your own VM via Docker. Optional AES-256 document encryption, opt-in S3 backups, no phone-home. Your equipment data stays on your server.',
  },
];

const STEPS = [
  { num: '01', title: 'Add your sites & equipment', body: 'Add a site, then its electrical assets — drop in a nameplate photo and AI pulls the details, or import a CSV, or add manually. Set each asset’s governing condition.' },
  { num: '02', title: 'Let the schedules build themselves', body: 'ServiceCycle derives NFPA 70B task intervals from equipment type and condition. Tiered alerts fire at 180 down to 7 days before due — one daily digest per person.' },
  { num: '03', title: 'Complete work, capture evidence', body: 'Issue work orders to your contractor, record NETA test measurements and deficiencies, and build the audit-ready compliance record as a by-product of doing the work.' },
];

// ── Early-access form (L7) ────────────────────────────────────────────────────
// Replaces the pre-L7 mailto:hello@servicecycle.com CTAs with a real form that
// hits POST /api/early-access. Honeypot field "website" is hidden — humans
// don't fill it; bots do.

function EarlyAccessForm() {
  const [name,    setName]    = useState('');
  const [email,   setEmail]   = useState('');
  const [company, setCompany] = useState('');
  const [timing,  setTiming]  = useState('this_month');
  const [website, setWebsite] = useState(''); // honeypot
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone]   = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(e) {
    e.preventDefault();
    if (submitting || done) return;
    setSubmitting(true); setError('');
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/early-access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:    name.trim(),
          email:   email.trim(),
          company: company.trim() || undefined,
          timing,
          website, // honeypot — sent verbatim
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        const msg = data?.issues?.[0]?.msg
          || data?.error
          || `Submission failed (HTTP ${res.status}). Please email support@servicecycle.com directly.`;
        throw new Error(msg);
      }
      setDone(true);
    } catch (err) {
      setError(err.message || 'Something went wrong. Please try again or email support@servicecycle.com.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div style={s.formDone}>
        <div style={s.formDoneIcon}>✓</div>
        <h3 style={s.formDoneH3}>You're on the list.</h3>
        <p style={s.formDoneP}>
          Check your inbox in the next minute — there's a one-line install command
          waiting for you. If it doesn't arrive, ping <a href="mailto:support@servicecycle.com" style={{ color: '#0d4f6e' }}>support@servicecycle.com</a> directly.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} style={s.form} noValidate>
      <div style={s.formRow}>
        <label style={s.formLabel}>
          Your name
          <input
            type="text" required
            value={name} onChange={e => setName(e.target.value)}
            placeholder="Sarah Chen"
            style={s.formInput}
            autoComplete="name"
          />
        </label>
        <label style={s.formLabel}>
          Work email
          <input
            type="email" required
            value={email} onChange={e => setEmail(e.target.value)}
            placeholder="sarah@acme.com"
            style={s.formInput}
            autoComplete="email"
          />
        </label>
      </div>
      <div style={s.formRow}>
        <label style={s.formLabel}>
          Company
          <input
            type="text"
            value={company} onChange={e => setCompany(e.target.value)}
            placeholder="Acme Inc."
            style={s.formInput}
            autoComplete="organization"
          />
        </label>
        <label style={s.formLabel}>
          When do you want this?
          <select
            value={timing} onChange={e => setTiming(e.target.value)}
            style={s.formInput}
          >
            <option value="now">Now — set me up this week</option>
            <option value="this_week">This week</option>
            <option value="this_month">This month</option>
            <option value="browsing">Just browsing</option>
          </select>
        </label>
      </div>

      {/* Honeypot — hidden from humans, autofilled by bots. tabIndex / autoComplete
          set to discourage password managers from touching it. aria-hidden so
          screen readers skip past it. */}
      <div style={{ position: 'absolute', left: '-9999px', top: 'auto', width: 1, height: 1, overflow: 'hidden' }} aria-hidden="true">
        <label>
          Website (leave blank)
          <input
            type="text" tabIndex={-1} autoComplete="off"
            value={website} onChange={e => setWebsite(e.target.value)}
          />
        </label>
      </div>

      {error && <div style={s.formError}>{error}</div>}

      <button type="submit" disabled={submitting} style={{ ...s.formSubmit, opacity: submitting ? 0.7 : 1 }}>
        {submitting ? 'Sending…' : 'Request access →'}
      </button>
      <p style={s.formNote}>
        We'll email you a one-line installer + a quickstart. No marketing list,
        no follow-up sequences — just the install info and a real human reply
        if you want one.
      </p>
    </form>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function LandingPage() {
  const navigate = useNavigate();

  return (
    <div style={s.page}>

      {/* ── Navbar ─────────────────────────────────────────────────────────── */}
      <header style={s.nav}>
        <div style={s.navInner}>
          <div style={s.logo}>
            <svg width="44" height="24" viewBox="0 0 44 24" aria-hidden="true" style={{ flexShrink: 0 }}>
              <rect x="2" y="9" width="36" height="6" rx="3" fill="#0d4f6e"/>
              <rect x="26" y="3" width="3" height="18" rx="1.5" fill="#10b981" className="lapseiq-tick"/>
            </svg>
            <span style={s.logoText}>servicecycle</span>
          </div>
          <nav style={s.navLinks}>
            <a href="#features" style={s.navLink}>Features</a>
            <a href="#how-it-works" style={s.navLink}>How it works</a>
            <Link to="/login" style={s.navLinkLogin}>Sign in</Link>
            <button style={s.navCta} onClick={() => navigate('/register')}>Get started free</button>
          </nav>
        </div>
      </header>

      {/* ── Hero ───────────────────────────────────────────────────────────── */}
      <section style={s.hero}>
        <div style={s.heroInner}>
          <div style={s.badge}>NFPA 70B electrical maintenance compliance</div>
          <h1 style={s.heroH1}>
            NFPA 70B is mandatory.<br />
            <span style={{ color: '#0d4f6e' }}>Most facilities aren't compliant.</span>
          </h1>
          <p style={s.heroSub}>
            Electrical equipment maintenance became a requirement &mdash; not a recommendation &mdash;
            when NFPA 70B became a standard in 2023, and roughly 84% of facilities still aren't
            compliant. ServiceCycle tracks condition-based maintenance intervals, NETA test records,
            and work orders across every transformer, switchgear lineup, and panelboard you own
            &mdash; then alerts your team in time to act. Self-hosted, telemetry-free, and built
            for the people who actually own the maintenance program.
          </p>
          <div style={s.heroCtas}>
            {/* L7: above-the-fold CTA scrolls to the inline early-access
                form (was a mailto:hello@servicecycle.com pre-L7). */}
            <a href="#early-access" style={s.ctaPrimary}>
              Request access →
            </a>
            <a href="#how-it-works" style={s.ctaSecondary}>See how it works</a>
          </div>
          <p style={s.heroSmall}>Beta &nbsp;·&nbsp; Self-hosted &nbsp;·&nbsp; Built for facility managers, plant engineers, and testing contractors</p>
        </div>

        {/* Decorative dashboard preview — mixed equipment maintenance lineup.
            Shows transformer, switchgear, breaker, UPS to signal breadth.
            Days color-coded by urgency. */}
        <div style={s.heroArt}>
          <div style={s.artCard}>
            <div style={s.artHeader}>
              <div style={s.artHeaderTitle}>Upcoming maintenance</div>
              <div style={s.artHeaderMeta}>4 tasks &middot; <span style={s.artMono}>NFPA 70B</span> intervals</div>
            </div>
            <div style={s.artDivider} />
            {[
              { vendor: 'TX-01 · Eaton',        product: 'Infrared scan + oil sample',     cat: 'Transformer', days: 12, amount: 'Condition 2', urgency: 'urgent' },
              { vendor: 'SWGR-A · Square D',    product: 'Insulation resistance test',     cat: 'Switchgear',  days: 38, amount: 'Condition 1', urgency: 'warning' },
              { vendor: 'CB-12 · ABB',          product: 'Trip-unit timing test',          cat: 'Breaker',     days: 64, amount: 'Condition 2', urgency: 'ok' },
              { vendor: 'UPS-02 · Vertiv',      product: 'Battery impedance check',        cat: 'UPS',         days: 87, amount: 'Condition 1', urgency: 'ok' },
            ].map((row) => {
              const daysColor = row.urgency === 'urgent' ? '#b91c1c' : row.urgency === 'warning' ? '#b45309' : '#0d4f6e';
              return (
                <div key={row.vendor} style={s.artItem}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={s.artVendor}>{row.vendor}</div>
                    <div style={s.artProductRow}>
                      <span style={s.artCategoryPill}>{row.cat}</span>
                      <span style={s.artProduct}>{row.product}</span>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ ...s.artDays, color: daysColor }}>{row.days}d</div>
                    <div style={s.artAmount}>{row.amount}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── Features ───────────────────────────────────────────────────────── */}
      <section id="features" style={s.section}>
        <div style={s.sectionInner}>
          <div style={s.sectionLabel}>Everything you need</div>
          <h2 style={s.sectionH2}>Built for the team that owns the maintenance program</h2>
          <p style={s.sectionSub}>
            From facility management to plant engineering to your testing contractor — everyone
            gets the visibility they need without drowning in binders or shared spreadsheets.
          </p>
          <div style={s.featureGrid}>
            {FEATURES.map((f) => (
              <div key={f.title} style={s.featureCard}>
                <div style={s.featureIcon}>{f.icon}</div>
                <h3 style={s.featureTitle}>{f.title}</h3>
                <p style={s.featureBody}>{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ───────────────────────────────────────────────────── */}
      <section id="how-it-works" style={{ ...s.section, background: '#fafbfd' }}>
        <div style={s.sectionInner}>
          <div style={s.sectionLabel}>How it works</div>
          <h2 style={s.sectionH2}>Up and running in under 10 minutes</h2>
          <div style={s.stepsRow}>
            {STEPS.map((step, i) => (
              <div key={step.num} style={s.step}>
                <div style={s.stepNum}>{step.num}</div>
                {i < STEPS.length - 1 && <div style={s.stepLine} />}
                <h3 style={s.stepTitle}>{step.title}</h3>
                <p style={s.stepBody}>{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Beta pricing — single self-hosted card, no cloud-managed ─────────
          v0.5.1: dropped the Cloud managed card per 2026-05-12 review — self-
          hosted is the moat, listing a cloud option undermined the data-
          sovereignty story. Beta framing is honest about what comes next:
          unlimited use on your infrastructure during beta, 60-day runway
          when beta ends, your data exports cleanly either way. */}
      <section style={s.pricingSection}>
        <div style={s.pricingInner}>
          <div style={s.sectionLabel}>Pricing</div>
          <h2 style={s.sectionH2}>Free during beta. Honest about what comes next.</h2>
          <p style={s.sectionSub}>
            ServiceCycle is in beta &mdash; feature set still evolving, we're giving away unlimited
            use on your own infrastructure in exchange for honest feedback while we validate
            the product and land on a sustainable price point.
          </p>

          <div style={s.pricingSingleWrap}>
            <div style={s.pricingSingleCard}>
              <div style={s.planBadge}>Beta &middot; free</div>
              <div style={s.planName}>Self-hosted</div>
              <div style={s.planPrice}>$0</div>
              <div style={s.planNote}>Unlimited on your infrastructure</div>
              <ul style={s.planFeatures}>
                {[
                  'Unlimited sites, assets, users',
                  'Every feature unlocked — no ServiceCycle-imposed metering',
                  'Runs on your own VM via Docker',
                  'AI features use your own provider keys (Anthropic, OpenAI, Azure, Google)',
                  'Daily backups + AES-256 document encryption (optional)',
                  'Export everything to CSV anytime',
                ].map(f => (
                  <li key={f} style={s.planFeature}>✓ {f}</li>
                ))}
              </ul>
              <a href="#early-access" style={s.planCta}>
                Request access →
              </a>
            </div>

            <div style={s.pricingHonestyNote}>
              <h3 style={s.pricingHonestyTitle}>When beta ends</h3>
              <p style={s.pricingHonestyBody}>
                Beta ends when we've validated the product with enough customers and landed
                on a sustainable price point. When that happens, every beta customer gets at
                least <strong>60 days</strong> to either subscribe at the launch price or
                export their data and walk away clean. No silent paywalls, no surprises.
              </p>
              <p style={s.pricingHonestyBody}>
                <strong>Your data is yours &mdash; you can always take it with you.</strong>
                {' '}AI features run against your own provider keys, so your AI costs flow
                through your existing agreement with Anthropic / OpenAI / Azure / Google.
                No ServiceCycle markup on per-call costs.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Early-access form (L7) ─────────────────────────────────────────── */}
      {/* Anchor target for the "#early-access" deep links from the hero CTA,
          the pricing-card "Get the install command" CTA, and the sidebar's
          Help & Share menu in DEMO_MODE. Replaces the mailto-based CTA
          banner that lived here pre-L7. */}
      <section id="early-access" style={s.ctaBanner}>
        <h2 style={s.ctaBannerH2}>Ready to get ahead of NFPA 70B?</h2>
        <p style={s.ctaBannerSub}>
          Tell us where to send the install instructions. Self-host on your
          infrastructure, no ServiceCycle-managed cloud — your equipment data
          never leaves your network.
        </p>
        <div style={s.formWrap}>
          <EarlyAccessForm />
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer style={s.footer}>
        <div style={s.footerInner}>
          <div style={s.footerLogo}>
            <svg width="44" height="24" viewBox="0 0 44 24" aria-hidden="true" style={{ flexShrink: 0 }}>
              <rect x="2" y="9" width="36" height="6" rx="3" fill="#0d4f6e"/>
              <rect x="26" y="3" width="3" height="18" rx="1.5" fill="#10b981"/>
            </svg>
            <span style={{ ...s.logoText, color: '#9aa3b2' }}>servicecycle</span>
          </div>
          <div style={s.footerLinks}>
            <Link to="/login" style={s.footerLink}>Sign in</Link>
            <a href="#features" style={s.footerLink}>Features</a>
            <a href="#how-it-works" style={s.footerLink}>How it works</a>
            <Link to="/privacy"        style={s.footerLink}>Privacy</Link>
            <Link to="/terms"          style={s.footerLink}>Terms</Link>
            <Link to="/eula"           style={s.footerLink}>EULA</Link>
            <Link to="/sub-processors" style={s.footerLink}>Sub-processors</Link>
          </div>
          <div style={s.footerCopy}>
            © {new Date().getFullYear()} ServiceCycle. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  page: {
    minHeight: '100vh',
    background: '#fff',
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    color: '#0a0d12',
  },

  // Nav
  nav: {
    position: 'sticky',
    top: 0,
    background: 'rgba(255,255,255,0.95)',
    backdropFilter: 'blur(8px)',
    borderBottom: '1px solid #dde2eb',
    zIndex: 100,
  },
  navInner: {
    maxWidth: 1140,
    margin: '0 auto',
    padding: '0 1.5rem',
    height: 60,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  logo: { display: 'flex', alignItems: 'center', gap: 6 },
  logoText: {
    fontWeight: 500,
    fontSize: 19,
    letterSpacing: '-0.02em',
    color: '#0a0d12',
  },
  navLinks: { display: 'flex', alignItems: 'center', gap: '1.75rem' },
  navLink: {
    color: '#5b6373',
    textDecoration: 'none',
    fontSize: 'var(--font-size-data)',
    fontWeight: 500,
    transition: 'color 120ms ease',
  },
  navLinkLogin: {
    color: '#0d4f6e',
    textDecoration: 'none',
    fontSize: 'var(--font-size-data)',
    fontWeight: 500,
    transition: 'color 120ms ease',
  },
  navCta: {
    background: '#0d4f6e',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '0.5rem 1rem',
    fontSize: 'var(--font-size-ui)',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'background 120ms ease',
  },

  // Hero
  hero: {
    maxWidth: 1140,
    margin: '0 auto',
    padding: '5rem 1.5rem 4rem',
    display: 'flex',
    gap: '3rem',
    alignItems: 'center',
  },
  heroInner: { flex: '1 1 480px' },
  badge: {
    display: 'inline-block',
    background: '#e6f0f5',
    color: '#0d4f6e',
    fontSize: 'var(--font-size-sm)',
    fontWeight: 500,
    padding: '4px 10px',
    borderRadius: 20,
    marginBottom: '1.25rem',
    letterSpacing: '0.03em',
  },
  heroH1: {
    fontSize: 'clamp(2.25rem, 4.5vw, 3.25rem)',
    fontWeight: 500,
    lineHeight: 1.1,
    letterSpacing: '-0.025em',
    marginBottom: '1.25rem',
    color: '#0a0d12',
  },
  heroSub: {
    fontSize: 'var(--font-size-lg)',
    color: '#5b6373',
    lineHeight: 1.6,
    marginBottom: '2rem',
    maxWidth: 540,
  },
  heroCtas: { display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '1rem' },
  ctaPrimary: {
    background: '#0d4f6e',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '0.75rem 1.5rem',
    fontSize: 'var(--font-size-base)',
    fontWeight: 500,
    cursor: 'pointer',
    textDecoration: 'none',
    display: 'inline-block',
    transition: 'background 120ms ease',
  },
  ctaSecondary: {
    color: '#0d4f6e',
    fontSize: 'var(--font-size-base)',
    fontWeight: 500,
    textDecoration: 'none',
    transition: 'color 120ms ease',
  },
  heroSmall: { fontSize: 'var(--font-size-sm)', color: '#9aa3b2' },

  // Hero art
  heroArt: {
    flex: '0 1 420px',
    minWidth: 280,
  },
  artCard: {
    background: '#fff',
    border: '1px solid #dde2eb',
    borderRadius: 12,
    padding: '1.25rem',
    boxShadow: '0 20px 60px rgba(0,0,0,0.08)',
  },
  artHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem', gap: 12 },
  artHeaderTitle: { fontSize: 'var(--font-size-ui)', fontWeight: 500, color: '#0a0d12', letterSpacing: '-0.01em' },
  artHeaderMeta: { fontSize: 'var(--font-size-xs)', color: '#5b6373' },
  artMono: { fontFamily: '"JetBrains Mono", "IBM Plex Mono", Menlo, Consolas, monospace', color: '#0a0d12' },
  artDivider: { height: 1, background: '#eef1f6', margin: '0.25rem 0 0.5rem' },
  artItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.55rem 0',
    borderBottom: '1px solid #f4f6fa',
    gap: 12,
  },
  artVendor: { fontSize: 'var(--font-size-ui)', fontWeight: 500, color: '#0a0d12', letterSpacing: '-0.01em' },
  artProductRow: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 },
  artCategoryPill: {
    fontSize: 9.5,
    fontWeight: 500,
    color: '#0d4f6e',
    background: '#e6f0f5',
    padding: '1px 6px',
    borderRadius: 4,
    letterSpacing: '0.02em',
    flexShrink: 0,
  },
  artProduct: { fontSize: 'var(--font-size-xs)', color: '#9aa3b2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  artDays: { fontSize: 'var(--font-size-data)', fontWeight: 500, color: '#b91c1c', fontFamily: '"JetBrains Mono", "IBM Plex Mono", Menlo, Consolas, monospace' },
  artAmount: { fontSize: 'var(--font-size-xs)', color: '#5b6373', fontFamily: '"JetBrains Mono", "IBM Plex Mono", Menlo, Consolas, monospace', marginTop: 1 },

  // Sections
  section: { padding: '5rem 0' },
  sectionInner: { maxWidth: 1140, margin: '0 auto', padding: '0 1.5rem' },
  sectionLabel: {
    fontSize: 'var(--font-size-xs)',
    fontWeight: 500,
    color: '#0d4f6e',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: '0.75rem',
  },
  sectionH2: {
    fontSize: 'clamp(1.6rem, 3vw, 2.25rem)',
    fontWeight: 500,
    letterSpacing: '-0.02em',
    marginBottom: '0.75rem',
    lineHeight: 1.15,
    color: '#0a0d12',
  },
  sectionSub: {
    fontSize: 16,
    color: '#5b6373',
    lineHeight: 1.6,
    maxWidth: 580,
    marginBottom: '3rem',
  },

  // Feature grid
  featureGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: '1.5rem',
  },
  featureCard: {
    background: '#fafbfd',
    border: '1px solid #dde2eb',
    borderRadius: 10,
    padding: '1.5rem',
  },
  featureIcon: {
    color: '#0d4f6e',
    marginBottom: '0.75rem',
  },
  featureTitle: {
    fontSize: 'var(--font-size-base)',
    fontWeight: 500,
    color: '#0a0d12',
    marginBottom: '0.4rem',
  },
  featureBody: {
    fontSize: 13.5,
    color: '#5b6373',
    lineHeight: 1.6,
  },

  // Section-level informative callout (e.g. AI-extraction expectation note).
  // Amber palette so it reads as advisory/setup-note, distinct from the
  // slate feature cards above. Same border-radius and padding rhythm.
  featureNote: {
    marginTop: '1.5rem',
    padding: '1.25rem 1.5rem',
    background: '#fffbeb',
    border: '1px solid #fde68a',
    borderRadius: 10,
    display: 'flex',
    gap: '1rem',
    alignItems: 'flex-start',
  },
  featureNoteIcon: {
    color: '#b45309',
    flexShrink: 0,
    marginTop: 2,
  },
  featureNoteTitle: {
    fontSize: 14.5,
    fontWeight: 500,
    color: '#78350f',
    marginBottom: '0.35rem',
  },
  featureNoteBody: {
    fontSize: 13.5,
    color: '#92400e',
    lineHeight: 1.6,
  },

  // Steps
  stepsRow: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: '2rem',
  },
  step: { position: 'relative' },
  stepNum: {
    fontSize: '2rem',
    fontWeight: 500,
    color: '#dde2eb',
    lineHeight: 1,
    marginBottom: '0.75rem',
  },
  stepLine: {
    display: 'none', // decorative only on mobile; layout handles spacing
  },
  stepTitle: {
    fontSize: 16,
    fontWeight: 500,
    color: '#0a0d12',
    marginBottom: '0.4rem',
  },
  stepBody: {
    fontSize: 13.5,
    color: '#5b6373',
    lineHeight: 1.6,
  },

  // Pricing
  pricingSection: { padding: '5rem 0', background: '#fff' },
  pricingInner: { maxWidth: 1140, margin: '0 auto', padding: '0 1.5rem' },

  // v0.5.1: single-card layout with "what happens when beta ends" honesty note.
  // Card on the left, honesty note on the right at desktop; stacks at mobile.
  pricingSingleWrap: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: '1.5rem',
    marginTop: '2rem',
    alignItems: 'start',
  },
  pricingSingleCard: {
    background: '#fafbfd',
    border: '1px solid #dde2eb',
    borderRadius: 12,
    padding: '1.75rem',
  },
  pricingHonestyNote: {
    background: '#fafbfd',
    border: '1px solid #dde2eb',
    borderRadius: 12,
    padding: '1.75rem',
  },
  pricingHonestyTitle: {
    fontSize: 'var(--font-size-data)',
    fontWeight: 500,
    color: '#0a0d12',
    letterSpacing: '-0.01em',
    marginBottom: '0.5rem',
  },
  pricingHonestyBody: {
    fontSize: 13.5,
    color: '#5b6373',
    lineHeight: 1.65,
    marginBottom: '0.75rem',
  },

  // Legacy two-card pricing layout (kept for now in case we add a paid tier
  // back later; pricingCardHighlight is unused after v0.5.1).
  pricingCards: {
    display: 'flex',
    gap: '1.5rem',
    flexWrap: 'wrap',
    marginTop: '2rem',
  },
  pricingCard: {
    flex: '1 1 260px',
    background: '#fafbfd',
    border: '1px solid #dde2eb',
    borderRadius: 12,
    padding: '1.75rem',
  },
  pricingCardHighlight: {
    background: '#0a3d56',
    border: '1px solid #0a3d56',
  },
  planBadge: {
    display: 'inline-block',
    background: '#e6f0f5',
    color: '#0d4f6e',
    fontSize: 'var(--font-size-xs)',
    fontWeight: 500,
    padding: '2px 8px',
    borderRadius: 10,
    marginBottom: '0.5rem',
    letterSpacing: '0.04em',
  },
  planName: { fontSize: 'var(--font-size-base)', fontWeight: 500, marginBottom: '0.25rem' },
  planPrice: { fontSize: 36, fontWeight: 500, letterSpacing: '-0.03em', lineHeight: 1.1, margin: '0.25rem 0' },
  planNote: { fontSize: 'var(--font-size-sm)', color: '#5b6373', marginBottom: '1.25rem' },
  planFeatures: { listStyle: 'none', padding: 0, marginBottom: '1.5rem', display: 'flex', flexDirection: 'column', gap: 6 },
  planFeature: { fontSize: 13.5, color: '#5b6373' },
  planCta: {
    display: 'inline-block',
    textDecoration: 'none',
    background: '#0d4f6e',
    color: '#fff',
    borderRadius: 8,
    padding: '0.6rem 1.1rem',
    fontSize: 'var(--font-size-ui)',
    fontWeight: 500,
    cursor: 'pointer',
    border: '1.5px solid transparent',
    transition: 'background 120ms ease',
  },

  // CTA banner
  ctaBanner: {
    background: '#0a0d12',
    padding: '5rem 1.5rem',
    textAlign: 'center',
  },
  ctaBannerH2: {
    fontSize: 'clamp(1.6rem, 3vw, 2.25rem)',
    fontWeight: 500,
    color: '#fff',
    letterSpacing: '-0.02em',
    marginBottom: '0.75rem',
    lineHeight: 1.15,
  },
  ctaBannerSub: {
    fontSize: 16,
    color: '#9aa3b2',
    marginBottom: '2rem',
    lineHeight: 1.6,
  },
  ctaBannerBtn: {
    background: '#0d4f6e',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '0.8rem 2rem',
    fontSize: 16,
    fontWeight: 500,
    cursor: 'pointer',
    textDecoration: 'none',
    display: 'inline-block',
    transition: 'background 120ms ease',
  },

  // L7: Early-access form
  formWrap: {
    maxWidth: 540,
    margin: '0 auto',
    background: '#13171f',
    borderRadius: 12,
    padding: '1.75rem',
    textAlign: 'left',
    border: '1px solid #2a3140',
  },
  form: { display: 'flex', flexDirection: 'column', gap: '0.85rem', position: 'relative' },
  formRow: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.85rem' },
  formLabel: {
    display: 'flex', flexDirection: 'column', gap: 6,
    fontSize: 'var(--font-size-sm)', fontWeight: 500, color: '#c7cfdb',
    letterSpacing: '0.02em',
  },
  formInput: {
    background: '#0a0d12',
    border: '1px solid #2a3140',
    color: '#dde2eb',
    padding: '0.55rem 0.7rem',
    borderRadius: 6,
    fontSize: 'var(--font-size-data)',
    outline: 'none',
    fontFamily: 'inherit',
  },
  formSubmit: {
    background: '#0d4f6e',
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '0.75rem 1rem',
    fontSize: 'var(--font-size-base)',
    fontWeight: 500,
    cursor: 'pointer',
    marginTop: '0.4rem',
    transition: 'background 120ms ease',
  },
  formNote: {
    fontSize: 'var(--font-size-sm)', color: '#5b6373', margin: '0.4rem 0 0',
    lineHeight: 1.55, textAlign: 'center',
  },
  formError: {
    background: '#7f1d1d', color: '#fecaca',
    padding: '0.55rem 0.7rem', borderRadius: 6, fontSize: 'var(--font-size-ui)',
  },
  formDone: {
    maxWidth: 480, margin: '0 auto',
    background: '#13171f',
    borderRadius: 12,
    padding: '2rem 1.75rem',
    border: '1px solid #0d4f6e',
    textAlign: 'center',
  },
  formDoneIcon: {
    width: 48, height: 48,
    borderRadius: '50%',
    background: '#0d4f6e', color: '#fff',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 'var(--font-size-2xl)', fontWeight: 500,
    marginBottom: 12,
  },
  formDoneH3: { color: '#fff', fontSize: 20, fontWeight: 500, margin: '0 0 8px' },
  formDoneP:  { color: '#9aa3b2', fontSize: 'var(--font-size-data)', lineHeight: 1.65, margin: 0 },

  // Footer
  footer: {
    background: '#0a0d12',
    borderTop: '1px solid #13171f',
    padding: '2rem 1.5rem',
  },
  footerInner: {
    maxWidth: 1140,
    margin: '0 auto',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: '1rem',
  },
  footerLogo: { display: 'flex', alignItems: 'center', gap: 6 },
  footerLinks: { display: 'flex', gap: '1.5rem' },
  footerLink: { color: '#5b6373', fontSize: 'var(--font-size-ui)', textDecoration: 'none', fontWeight: 500, transition: 'color 120ms ease' },
  footerCopy: { color: '#5b6373', fontSize: 'var(--font-size-sm)' },
};