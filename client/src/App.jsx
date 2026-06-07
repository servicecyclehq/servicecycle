import { Suspense, lazy, useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AiConsentProvider } from './context/AiConsentContext';
import { ConfirmProvider } from './context/ConfirmContext';
import AiConsentModal from './components/AiConsentModal';
import ProtectedRoute from './components/ProtectedRoute';
import ErrorBoundary from './components/ErrorBoundary';
import { useDocumentTitle } from './hooks/useDocumentTitle';

// Role guard — always rendered so the route exists in the tree during auth
// hydration, preventing the path="*" fallback from firing prematurely.
//
// `denyOnDemo`: when true, the route is unreachable on DEMO_MODE deployments
// even for role='admin' users. Used for ops-only surfaces (early-access leads)
// that must not be exposed to sandbox visitors who get auto-provisioned with
// role='admin'. (2026-05-10 review B1)
function RequireRole({ roles, children, denyOnDemo = false }) {
  const { user, loading, demoMode } = useAuth();
  if (loading) return <div className="loading">Loading…</div>;
  if (!user || !roles.includes(user.role)) return <Navigate to="/dashboard" replace />;
  if (denyOnDemo && demoMode) return <Navigate to="/dashboard" replace />;
  return children;
}

// W6 (audit Cluster B P0): code-splitting. Every route is now a dynamic
// import so the initial JS bundle only contains the shell + the route
// the visitor actually lands on. Pre-fix, all 41 page components shipped
// on every page including /login (1.5 MB / 395 KB gzip — parses to about
// 600ms on a mid-tier mobile, blocking LCP).
//
// Vite emits one chunk per lazy() call and HTTP/2-multiplexes them as
// React requests them. The Suspense boundary below shows a brief
// "Loading…" fallback during the chunk fetch — typically <100ms on a
// warm cache.
//
// Eager (kept top-level): Layout, ProtectedRoute, ErrorBoundary,
// AiConsentModal, AuthProvider. These render on every page and would
// just cost a spinner on the first paint if lazy.
import Layout from './components/Layout';
import OnboardingWizard from './components/OnboardingWizard';
import VersionSkewDetector from './components/VersionSkewDetector';

// v0.89.10: chunk-load-error auto-recovery. Every deploy invalidates Vite's
// content-hashed chunk names. A user mid-session with the old index.js
// cached will try to fetch a chunk filename that no longer exists and the
// lazy import rejects. Without this helper the affected route silently fails
// -- see the v0.89.7 -> v0.89.9 incident where /contracts became unreachable
// after a deploy. Recovery: detect the chunk-load error pattern, set a
// short-lived sessionStorage timestamp (30s self-expiry), and reload the
// page. The timestamp prevents an infinite reload loop if the failure is
// something else (network down, server actually 500). All lazy() route
// imports below use lazyWithReload so this applies app-wide.
const CHUNK_RELOAD_KEY = 'lapseiq_chunk_reload';
const CHUNK_RELOAD_WINDOW_MS = 30_000;
function lazyWithReload(importFn) {
  return lazy(() =>
    importFn().catch((err) => {
      const msg = (err && err.message) || '';
      const isChunkError =
        /Failed to fetch dynamically imported module/i.test(msg) ||
        /Importing a module script failed/i.test(msg) ||
        /Loading (CSS )?chunk/i.test(msg) ||
        (err && err.name === 'ChunkLoadError');
      if (!isChunkError) throw err;
      let ts = 0;
      try { ts = parseInt(window.sessionStorage.getItem(CHUNK_RELOAD_KEY) || '0', 10); } catch (_) {}
      const recentReload = ts && (Date.now() - ts) < CHUNK_RELOAD_WINDOW_MS;
      if (recentReload) throw err; // already tried -- don't loop
      try { window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now())); } catch (_) {}
      window.location.reload();
      // Suspense holds the fallback until reload completes.
      return new Promise(() => {});
    })
  );
}

// v0.37.1 W5 MT-023: HelpDrawer is lazy-imported and mounted once at
// the App root (under AppRoutes, next to <AiConsentModal />). Previously
// mounted inside <Layout />, which made the drawer's docstring claim
// "works on the login screen" untrue — public routes never rendered it.
// Lazy because react-markdown + remark-gfm add ~25KB gzip that we don't
// want in the initial chunk; the drawer is hydrated the first time the
// user clicks Help, not on first paint.
const HelpDrawer = lazyWithReload(() => import('./components/HelpDrawer'));

const LandingPage             = lazyWithReload(() => import('./pages/LandingPage'));
const Login                   = lazyWithReload(() => import('./pages/Login'));
const Register                = lazyWithReload(() => import('./pages/Register'));        // L3 + legal click-through
const ForgotPassword          = lazyWithReload(() => import('./pages/ForgotPassword'));
const ResetPassword           = lazyWithReload(() => import('./pages/ResetPassword'));
const AcceptInvite            = lazyWithReload(() => import('./pages/AcceptInvite'));
const Dashboard               = lazyWithReload(() => import('./pages/Dashboard'));
const ContractsList           = lazyWithReload(() => import('./pages/ContractsList'));
const ContractDetail          = lazyWithReload(() => import('./pages/ContractDetail'));
const NewContract             = lazyWithReload(() => import('./pages/NewContract'));
const VendorsList             = lazyWithReload(() => import('./pages/VendorsList'));
const VendorDetail            = lazyWithReload(() => import('./pages/VendorDetail'));
const BudgetForecast          = lazyWithReload(() => import('./pages/BudgetForecast'));
const IngestReview            = lazyWithReload(() => import('./pages/IngestReview'));
const UsersPage               = lazyWithReload(() => import('./pages/UsersPage'));
const AdminMetrics            = lazyWithReload(() => import('./pages/AdminMetrics')); // audit 3.2.6
const PermissionsPage         = lazyWithReload(() => import('./pages/PermissionsPage'));
const AlertsPage              = lazyWithReload(() => import('./pages/AlertsPage'));
const NewsPage                = lazyWithReload(() => import('./pages/NewsPage'));
const ProfilePage             = lazyWithReload(() => import('./pages/ProfilePage'));
const SettingsPage            = lazyWithReload(() => import('./pages/SettingsPage'));      // 4233-line page — biggest single chunk win
const ActivityLogPage         = lazyWithReload(() => import('./pages/ActivityLogPage'));
const ArchivedContracts       = lazyWithReload(() => import('./pages/ArchivedContracts'));
const ExecutiveSpendReport    = lazyWithReload(() => import('./pages/ExecutiveSpendReport'));
const ReportsHub              = lazyWithReload(() => import('./pages/ReportsHub'));
const RenewalHorizonReport    = lazyWithReload(() => import('./pages/RenewalHorizonReport'));
const RiskRadarReport         = lazyWithReload(() => import('./pages/RiskRadarReport'));
const SavingsLedgerReport     = lazyWithReload(() => import('./pages/SavingsLedgerReport'));
const LicenseWastageReport    = lazyWithReload(() => import('./pages/LicenseWastageReport'));
const SpendLedgerReport       = lazyWithReload(() => import('./pages/SpendLedgerReport'));
// v0.58.0: new Tier-1 white-space reports
const AutoRenewalExposureReport = lazyWithReload(() => import('./pages/AutoRenewalExposureReport'));
const VendorConcentrationReport = lazyWithReload(() => import('./pages/VendorConcentrationReport'));
const NonSaaSCategoryReport     = lazyWithReload(() => import('./pages/NonSaaSCategoryReport'));
// v0.59.0: stubs converted to real reports (4 of 4 Tier-1+ placeholders closed)
const CoTerminationOpportunityReport  = lazyWithReload(() => import('./pages/CoTerminationOpportunityReport'));
const RenewalCommitmentForecastReport = lazyWithReload(() => import('./pages/RenewalCommitmentForecastReport'));
const VendorPortfolioHeatMapReport    = lazyWithReload(() => import('./pages/VendorPortfolioHeatMapReport'));
const AuditEvidencePackReport         = lazyWithReload(() => import('./pages/AuditEvidencePackReport'));
// v0.60.0: Tier-2 new report
const ApplicationOverlapReport        = lazyWithReload(() => import('./pages/ApplicationOverlapReport'));
const M365OverlapReport               = lazyWithReload(() => import('./pages/M365OverlapReport'));
// v0.84.0: Budget Shock Simulator
const BudgetShockSimulator            = lazyWithReload(() => import('./pages/BudgetShockSimulator'));
// v0.85.0: Phase 3 Tier A reports
const TotalAddressableWasteReport         = lazyWithReload(() => import('./pages/TotalAddressableWasteReport'));
const TerminationWindowViolationsReport   = lazyWithReload(() => import('./pages/TerminationWindowViolationsReport'));
const LicenseReclamationRoiReport         = lazyWithReload(() => import('./pages/LicenseReclamationRoiReport'));
const CostPerActiveUserReport             = lazyWithReload(() => import('./pages/CostPerActiveUserReport'));
const NegotiationEffectivenessByOwnerReport = lazyWithReload(() => import('./pages/NegotiationEffectivenessByOwnerReport'));
const VendorNegotiationDifficultyReport   = lazyWithReload(() => import('./pages/VendorNegotiationDifficultyReport'));
const PriceEscalationRadarReport          = lazyWithReload(() => import('./pages/PriceEscalationRadarReport'));
const MultiYearCommitmentRiskReport       = lazyWithReload(() => import('./pages/MultiYearCommitmentRiskReport'));
const ContractHealthScoreReport           = lazyWithReload(() => import('./pages/ContractHealthScoreReport'));
const DepartmentBudgetAllocationReport    = lazyWithReload(() => import('./pages/DepartmentBudgetAllocationReport'));
const PricePerSeatBenchmarkReport         = lazyWithReload(() => import('./pages/PricePerSeatBenchmarkReport'));
const GlCodeSpendReport                   = lazyWithReload(() => import('./pages/GlCodeSpendReport'));
const WalkawayCalculatorReport            = lazyWithReload(() => import('./pages/WalkawayCalculatorReport'));
const PortfolioDecisionDashboardReport    = lazyWithReload(() => import('./pages/PortfolioDecisionDashboardReport'));
const RenewalWinRateReport                = lazyWithReload(() => import('./pages/RenewalWinRateReport'));
const ContractOwnershipReport             = lazyWithReload(() => import('./pages/ContractOwnershipReport'));

const SetupWizardPage         = lazyWithReload(() => import('./pages/SetupWizardPage'));   // (S8) first-run operator wizard
const PrivacyPage             = lazyWithReload(() => import('./pages/PrivacyPage'));       // (A2) public, mounted outside Layout shell
const TermsPage               = lazyWithReload(() => import('./pages/TermsPage'));         // (A3) public, mounted outside Layout shell
const EulaPage                = lazyWithReload(() => import('./pages/EulaPage'));          // legal stack: install.sh links here
const SubProcessorsPage       = lazyWithReload(() => import('./pages/SubProcessorsPage')); // legal stack: DPA + privacy reference
const DemoSandboxNoticePage   = lazyWithReload(() => import('./pages/DemoSandboxNoticePage')); // demo signup click-through target
const EarlyAccessLeadsPage    = lazyWithReload(() => import('./pages/EarlyAccessLeadsPage')); // L7 admin consumer

// Suspense fallback. Kept extremely small (one styled <div>) so it
// itself doesn't add weight. Mirrors the existing `.loading` rule in
// index.css and the RequireRole "Loading…" string for visual parity.
function RouteFallback() {
  return (
    <div
      className="loading"
      role="status"
      aria-live="polite"
      style={{ padding: 24, color: 'var(--color-text-secondary)' }}
    >
      Loading…
    </div>
  );
}

function AppRoutes() {
  const { user, loading, aiEnabled, aiConfigured, onboardingDone, features } = useAuth();
  const location = useLocation(); // H2-4 (v0.76.7): feed currentPath to HelpDrawer
  // H5-5 (v0.76.8): online/offline detection
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const handleOnline  = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online',  handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online',  handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);
  // NOTE: user is still needed for the root redirect and OnboardingWizard check below.

  // v0.47 perf: with ProtectedRoute now soft-gated, the route element is
  // mounted DURING the auth probe (user=null, loading=true). Feature flags
  // are computed from `user`, which means `features.<key>` is false in the
  // loading window. Without this guard, /alerts, /news, /budget and /ingest
  // would all false-redirect to /dashboard before /api/auth/me even returns.
  //
  // Wait for loading=false before evaluating the feature gate — render the
  // same Suspense fallback for visual parity with the route's own chunk
  // load. The savings from the soft-gate apply to /contracts (the priority
  // for v0.47); feature-gated routes still see a brief Loading… during
  // auth hydration, which matches their pre-v0.47 behavior.
  const featureGated = (key, el) =>
    loading ? <RouteFallback /> : (features[key] ? el : <Navigate to="/dashboard" replace />);

  return (
    <>
      {/* H5-5 (v0.76.8): offline banner — fixed bottom strip, dismissed automatically when back online */}
      {!isOnline && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9998,
            background: '#78350f', color: '#fef3c7',
            padding: '10px 20px',
            fontSize: 'var(--font-size-ui)', fontWeight: 500,
            display: 'flex', alignItems: 'center', gap: 10,
            boxShadow: '0 -2px 8px rgba(0,0,0,0.25)',
          }}
        >
          <span aria-hidden="true">📶</span>
          No internet connection — changes will sync when you are back online.
        </div>
      )}

      {/* Onboarding wizard overlay — shown for authenticated users who haven't
          dismissed it yet. Renders on top of whatever page is currently active.
          Audit Cluster D P0: only show to writers (admin + manager). Viewers
          and consultants previously hit a wizard that recommended actions
          (Add your first vendor, Add your first contract) that 403'd on
          submit. The wizard is admin/manager onboarding by design. */}
      {user && !onboardingDone && ['admin', 'manager'].includes(user.role) && <OnboardingWizard />}

      <Suspense fallback={<RouteFallback />}>
        <Routes>
          {/* Root: marketing landing page for visitors, dashboard for logged-in users */}
          <Route
            path="/"
            element={user ? <Navigate to="/dashboard" replace /> : <LandingPage />}
          />

          {/* First-run operator wizard (S8) — pre-auth, only reachable on a
              fresh instance. The api/client.js interceptor routes 503
              needsSetup:true responses here automatically. */}
          <Route path="/setup" element={<SetupWizardPage />} />

          {/* Auth pages */}
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />{/* L3 + legal click-through */}
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password/:token" element={<ResetPassword />} />
          <Route path="/accept-invite/:token" element={<AcceptInvite />} />

          {/* (A2/A3) Legal pages — public, no Layout shell, no auth required.
              Each page is reachable at both the bare path and a /legal/* alias.
              Register.jsx's checkbox label, SetupWizardPage.jsx, and the demo
              EULA acceptance flow all link to /legal/* — keeping the bare
              paths preserves any external links (install.sh, marketing copy)
              that already point at /eula etc. */}
          <Route path="/privacy"                    element={<PrivacyPage />} />
          <Route path="/legal/privacy"              element={<PrivacyPage />} />
          <Route path="/terms"                      element={<TermsPage />} />
          <Route path="/legal/terms"                element={<TermsPage />} />
          <Route path="/eula"                       element={<EulaPage />} />
          <Route path="/legal/eula"                 element={<EulaPage />} />
          <Route path="/sub-processors"             element={<SubProcessorsPage />} />
          <Route path="/legal/sub-processors"       element={<SubProcessorsPage />} />
          <Route path="/demo-sandbox-notice"        element={<DemoSandboxNoticePage />} />
          <Route path="/legal/demo-sandbox-notice"  element={<DemoSandboxNoticePage />} />

          {/* Protected — all routes inside the shell layout */}
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            {/* Always-visible core pages */}
            <Route path="dashboard"          element={<Dashboard />} />
            <Route path="contracts"          element={<ContractsList />} />
            <Route path="contracts/new"      element={
              <RequireRole roles={['admin', 'manager']}>
                <NewContract />
              </RequireRole>
            } />
            <Route path="contracts/archived" element={<ArchivedContracts />} />
            <Route path="contracts/:id"      element={<ContractDetail />} />
            <Route path="vendors"            element={<VendorsList />} />
            <Route path="vendors/:id"        element={<VendorDetail />} />
            <Route path="profile"            element={<ProfilePage />} />

            {/* Feature-gated pages — redirect to dashboard if not enabled */}
            <Route path="budget"  element={featureGated('budget', <BudgetForecast />)} />
            {/* Reports hub + all canned report pages — manager / admin only.
                /reports → hub card grid; sub-paths → individual reports.
                The legacy /reports/executive-spend path is kept for backward
                compatibility (bookmarks, Loom walkthrough links). */}
            <Route path="reports" element={
              <RequireRole roles={['admin', 'manager']}>
                <ReportsHub />
              </RequireRole>
            } />
            <Route path="reports/renewal-horizon" element={
              <RequireRole roles={['admin', 'manager']}>
                <RenewalHorizonReport />
              </RequireRole>
            } />
            <Route path="reports/risk-radar" element={
              <RequireRole roles={['admin', 'manager']}>
                <RiskRadarReport />
              </RequireRole>
            } />
            <Route path="reports/savings-ledger" element={
              <RequireRole roles={['admin', 'manager']}>
                <SavingsLedgerReport />
              </RequireRole>
            } />
            <Route path="reports/license-wastage" element={
              <RequireRole roles={['admin', 'manager']}>
                <LicenseWastageReport />
              </RequireRole>
            } />
            <Route path="reports/spend-ledger" element={
              <RequireRole roles={['admin', 'manager']}>
                <SpendLedgerReport />
              </RequireRole>
            } />
            <Route path="reports/executive-spend" element={
              <RequireRole roles={['admin', 'manager']}>
                <ExecutiveSpendReport />
              </RequireRole>
            } />
            {/* v0.58.0: new Tier-1 reports */}
            <Route path="reports/auto-renewal-exposure" element={
              <RequireRole roles={['admin', 'manager']}>
                <AutoRenewalExposureReport />
              </RequireRole>
            } />
            <Route path="reports/vendor-concentration" element={
              <RequireRole roles={['admin', 'manager']}>
                <VendorConcentrationReport />
              </RequireRole>
            } />
            <Route path="reports/non-saas-categories" element={
              <RequireRole roles={['admin', 'manager']}>
                <NonSaaSCategoryReport />
              </RequireRole>
            } />
            {/* v0.60.0: Tier-2 new report */}
            <Route path="reports/application-overlap" element={
              <RequireRole roles={['admin', 'manager']}>
                <ApplicationOverlapReport />
              </RequireRole>
            } />
            <Route path="reports/m365-overlap" element={
              <RequireRole roles={['admin', 'manager']}>
                <M365OverlapReport />
              </RequireRole>
            } />
            {/* v0.84.0: Budget Shock Simulator */}
            <Route path="reports/budget-shock-simulator" element={
              <RequireRole roles={['admin', 'manager']}>
                <BudgetShockSimulator />
              </RequireRole>
            } />
            {/* v0.85.0: Phase 3 Tier A reports */}
            <Route path="reports/total-addressable-waste" element={
              <RequireRole roles={['admin', 'manager']}>
                <TotalAddressableWasteReport />
              </RequireRole>
            } />
            <Route path="reports/termination-window-violations" element={
              <RequireRole roles={['admin', 'manager']}>
                <TerminationWindowViolationsReport />
              </RequireRole>
            } />
            <Route path="reports/license-reclamation-roi" element={
              <RequireRole roles={['admin', 'manager']}>
                <LicenseReclamationRoiReport />
              </RequireRole>
            } />
            <Route path="reports/cost-per-active-user" element={
              <RequireRole roles={['admin', 'manager']}>
                <CostPerActiveUserReport />
              </RequireRole>
            } />
            <Route path="reports/negotiation-effectiveness-by-owner" element={
              <RequireRole roles={['admin', 'manager']}>
                <NegotiationEffectivenessByOwnerReport />
              </RequireRole>
            } />
            <Route path="reports/vendor-negotiation-difficulty" element={
              <RequireRole roles={['admin', 'manager']}>
                <VendorNegotiationDifficultyReport />
              </RequireRole>
            } />
            {/* v0.86.0: Phase-3 Tier B — converted from stubs */}
            <Route path="reports/price-escalation-radar" element={
              <RequireRole roles={['admin', 'manager']}>
                <PriceEscalationRadarReport />
              </RequireRole>
            } />
            <Route path="reports/multi-year-commitment-risk" element={
              <RequireRole roles={['admin', 'manager']}>
                <MultiYearCommitmentRiskReport />
              </RequireRole>
            } />
            <Route path="reports/contract-health-score" element={
              <RequireRole roles={['admin', 'manager']}>
                <ContractHealthScoreReport />
              </RequireRole>
            } />
            <Route path="reports/department-budget-allocation" element={
              <RequireRole roles={['admin', 'manager']}>
                <DepartmentBudgetAllocationReport />
              </RequireRole>
            } />
            <Route path="reports/price-per-seat-benchmark" element={
              <RequireRole roles={['admin', 'manager']}>
                <PricePerSeatBenchmarkReport />
              </RequireRole>
            } />
            <Route path="reports/gl-code-spend" element={
              <RequireRole roles={['admin', 'manager']}>
                <GlCodeSpendReport />
              </RequireRole>
            } />
            <Route path="reports/walkaway-calculator" element={
              <RequireRole roles={['admin', 'manager']}>
                <WalkawayCalculatorReport />
              </RequireRole>
            } />
            <Route path="reports/portfolio-decision-dashboard" element={
              <RequireRole roles={['admin', 'manager']}>
                <PortfolioDecisionDashboardReport />
              </RequireRole>
            } />
            <Route path="reports/renewal-win-rate" element={
              <RequireRole roles={['admin', 'manager']}>
                <RenewalWinRateReport />
              </RequireRole>
            } />
            <Route path="reports/contract-ownership" element={
              <RequireRole roles={['admin', 'manager']}>
                <ContractOwnershipReport />
              </RequireRole>
            } />
            {/* v0.58.0: Phase-3 stub placeholders. Coming soon in v0.59+ */}
            <Route path="reports/audit-evidence-pack" element={
              <RequireRole roles={['admin', 'manager']}>
                <AuditEvidencePackReport />
              </RequireRole>
            } />
            <Route path="reports/vendor-heat-map" element={
              <RequireRole roles={['admin', 'manager']}>
                <VendorPortfolioHeatMapReport />
              </RequireRole>
            } />
            <Route path="reports/co-term-opportunity" element={
              <RequireRole roles={['admin', 'manager']}>
                <CoTerminationOpportunityReport />
              </RequireRole>
            } />
            <Route path="reports/renewal-commitment-forecast" element={
              <RequireRole roles={['admin', 'manager']}>
                <RenewalCommitmentForecastReport />
              </RequireRole>
            } />
            <Route path="alerts"  element={featureGated('alerts', <AlertsPage />)} />
            <Route path="news"    element={featureGated('news', <NewsPage />)} />
            {aiEnabled && aiConfigured && (
              <Route path="ingest" element={featureGated('ingest', <IngestReview />)} />
            )}

            {/* Admin / manager pages — routes always exist so the Router never
                hits the path="*" fallback during auth hydration; RequireRole
                handles the loading state and role check inside the element. */}
            <Route path="users"       element={<RequireRole roles={['admin']}><UsersPage /></RequireRole>} />
            <Route path="permissions" element={<RequireRole roles={['admin']}><PermissionsPage /></RequireRole>} />
            <Route path="settings"    element={<RequireRole roles={['admin']}><SettingsPage /></RequireRole>} />
            <Route path="activity"    element={<RequireRole roles={['admin', 'manager']}><ActivityLogPage /></RequireRole>} />
            <Route path="admin/early-access" element={<RequireRole roles={['admin']} denyOnDemo><EarlyAccessLeadsPage /></RequireRole>} />
            <Route path="admin/metrics"      element={<RequireRole roles={['admin']}><AdminMetrics /></RequireRole>} />
            {/* 2026-05-10 review M3: in-shell 404 so unknown paths under an
                authenticated session don't silently redirect to /dashboard
                (which masked broken links from emails, old bookmarks, and
                typos in nav code). */}
            <Route path="*" element={<NotFoundInShell />} />
          </Route>

          {/* Top-level fallback — applies when there's no session shell
              (e.g. an unauthenticated visitor hitting a typo). Keep the
              redirect-to-root behaviour: LandingPage is the right surface
              for a stranger; logged-in users never reach this leg because
              of the inner-shell 404 above. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>

      {/* v0.37.1 W5 MT-023: HelpDrawer mounted at the App root with its
          own Suspense boundary (null fallback) so the lazy chunk loads
          out-of-band the first time the user clicks Help — public routes
          (Login, Register, Legal) now have a real working Help drawer.
          The drawer manages its own open state and listens for the global
          lapseiq:open-help CustomEvent, so a null Suspense fallback is
          correct — there's nothing to render until the chunk lands AND
          the user has dispatched the open event. */}
      <Suspense fallback={null}>
        <HelpDrawer currentPath={location.pathname} />
      </Suspense>
    </>
  );
}

// 2026-05-10 review M3 fix: dedicated 404 page rendered inside the auth
// shell so the sidebar + main layout stay visible. Gives the user a clear
// "this page doesn't exist" signal plus a one-click recovery path.
function NotFoundInShell() {
  useDocumentTitle('Page not found');
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Page not found</h1>
          <div className="page-subtitle">The URL you followed doesn't match a page in LapseIQ.</div>
        </div>
      </div>
      <div className="page-body">
        <div className="card" style={{ padding: 24, maxWidth: 520 }}>
          <p style={{ marginBottom: 12, color: 'var(--color-text-secondary)' }}>
            Double-check the link, or jump to one of these:
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            <li><a href="/dashboard" style={{ color: 'var(--color-primary)' }}>→ Dashboard</a></li>
            <li><a href="/contracts" style={{ color: 'var(--color-primary)' }}>→ Contracts</a></li>
            <li><a href="/vendors"   style={{ color: 'var(--color-primary)' }}>→ Vendors</a></li>
            <li><a href="/alerts"    style={{ color: 'var(--color-primary)' }}>→ Alerts</a></li>
          </ul>
        </div>
      </div>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        {/* Phase 4 (v0.4.0): AiConsentProvider sits inside AuthProvider so its
            useEffect can react to login/logout via useAuth().user. The
            modal renders once at root and listens to the context. Any
            component triggering an AI action calls
            useAiConsent().requestConsent(actionFn). */}
        <AiConsentProvider>
          {/* v0.42: ConfirmProvider hosts a single <ConfirmDialog/> at the
              root and exposes useConfirm() — Promise-based replacement for
              window.confirm() at every destructive-action call site. */}
          <ConfirmProvider>
            <VersionSkewDetector />
            <ErrorBoundary>
              <AppRoutes />
              <AiConsentModal />
            </ErrorBoundary>
          </ConfirmProvider>
        </AiConsentProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
