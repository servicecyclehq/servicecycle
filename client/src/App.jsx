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

// W6 (audit Cluster B P0): code-splitting. Every route is a dynamic
// import so the initial JS bundle only contains the shell + the route
// the visitor actually lands on.
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
// lazy import rejects. Without this helper the affected route silently fails.
// Recovery: detect the chunk-load error pattern, set a short-lived
// sessionStorage timestamp (30s self-expiry), and reload the page. The
// timestamp prevents an infinite reload loop if the failure is something
// else (network down, server actually 500). All lazy() route imports below
// use lazyWithReload so this applies app-wide.
const CHUNK_RELOAD_KEY = 'servicecycle_chunk_reload';
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
// the App root (under AppRoutes, next to <AiConsentModal />) so public
// routes (Login, Register, Legal) get a working Help drawer too.
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
const InviteAcceptPage        = lazyWithReload(() => import('./pages/InviteAcceptPage')); // partner invite accept
const SharedCompliancePage    = lazyWithReload(() => import('./pages/SharedCompliancePage')); // #21 public auditor/insurer share
const TryParserPage           = lazyWithReload(() => import('./pages/TryParserPage')); // #17 public parser-as-funnel
const Dashboard               = lazyWithReload(() => import('./pages/Dashboard'));
// ServiceCycle core domain pages
const AssetsList              = lazyWithReload(() => import('./pages/AssetsList'));
const AssetDetail             = lazyWithReload(() => import('./pages/AssetDetail'));
const NewAsset                = lazyWithReload(() => import('./pages/NewAsset'));
const ImportAssets            = lazyWithReload(() => import('./pages/ImportAssets'));
const TestReportImport        = lazyWithReload(() => import('./pages/TestReportImport'));
const AddData                 = lazyWithReload(() => import('./pages/AddData'));
const BackfillImport          = lazyWithReload(() => import('./pages/BackfillImport')); // #34 bulk backfill (zip of reports)
const ArchivedAssets          = lazyWithReload(() => import('./pages/ArchivedAssets'));
const SitesList               = lazyWithReload(() => import('./pages/SitesList'));
const SiteDetail              = lazyWithReload(() => import('./pages/SiteDetail'));
const ContractorsList         = lazyWithReload(() => import('./pages/ContractorsList'));
const ContractorDetail        = lazyWithReload(() => import('./pages/ContractorDetail'));
const QemwWallet              = lazyWithReload(() => import('./pages/QemwWallet'));
const WorkOrdersList          = lazyWithReload(() => import('./pages/WorkOrdersList'));
const WorkOrderDetail         = lazyWithReload(() => import('./pages/WorkOrderDetail'));
const ComplianceCalendar      = lazyWithReload(() => import('./pages/ComplianceCalendar'));
const DeficienciesPage        = lazyWithReload(() => import('./pages/DeficienciesPage'));   // account-wide NETA findings triage
const NewsPage                = lazyWithReload(() => import('./pages/NewsPage'));           // industry news feed (all roles)
// Shared / admin pages
const UsersPage               = lazyWithReload(() => import('./pages/UsersPage'));
const AdminMetrics            = lazyWithReload(() => import('./pages/AdminMetrics')); // audit 3.2.6
const PermissionsPage         = lazyWithReload(() => import('./pages/PermissionsPage'));
const AlertsPage              = lazyWithReload(() => import('./pages/AlertsPage'));
const DisasterResponsePage    = lazyWithReload(() => import('./pages/DisasterResponsePage')); // disaster response mode
const ProfilePage             = lazyWithReload(() => import('./pages/ProfilePage'));
const SettingsPage            = lazyWithReload(() => import('./pages/SettingsPage'));
const ActivityLogPage         = lazyWithReload(() => import('./pages/ActivityLogPage'));
const ReportsHub              = lazyWithReload(() => import('./pages/ReportsHub'));
// Per-standard compliance suite (launched from the Reports hub)
const ComplianceStandardsReport      = lazyWithReload(() => import('./pages/ComplianceStandardsReport'));
const ComplianceStandardDetailReport = lazyWithReload(() => import('./pages/ComplianceStandardDetailReport'));
const AuditSnapshotsPage             = lazyWithReload(() => import('./pages/AuditSnapshotsPage'));
const OverdueReport                  = lazyWithReload(() => import('./pages/OverdueReport'));    // overdue maintenance report (admin/manager)
const StandardsLibrary               = lazyWithReload(() => import('./pages/StandardsLibrary')); // standards reference library (admin/manager)
const AuditsPage                     = lazyWithReload(() => import('./pages/AuditsPage')); // audit visits + REC tracking
const EquipmentTemplates             = lazyWithReload(() => import('./pages/EquipmentTemplates')); // equipment template library
const OutagePlannerPage              = lazyWithReload(() => import('./pages/OutagePlannerPage')); // account-wide outage consolidation planner
const CmmsImport                     = lazyWithReload(() => import('./pages/CmmsImport'));         // CMMS bulk import hub
const FleetDashboard                 = lazyWithReload(() => import('./pages/FleetDashboard'));     // OEM fleet dashboard (oem_admin)

// Field Mode — phone-first technician surface. Own chrome (FieldLayout, no
// sidebar), mounted behind ProtectedRoute but OUTSIDE the desktop Layout.
const FieldLayout             = lazyWithReload(() => import('./pages/field/FieldLayout'));
const FieldHome               = lazyWithReload(() => import('./pages/field/FieldHome'));
const FieldScan               = lazyWithReload(() => import('./pages/field/FieldScan'));
const FieldAsset              = lazyWithReload(() => import('./pages/field/FieldAsset'));
const FieldNewAsset           = lazyWithReload(() => import('./pages/field/FieldNewAsset'));
const FieldBatchNameplate     = lazyWithReload(() => import('./pages/field/FieldBatchNameplate')); // #13 batch nameplate

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
  const { user, loading, onboardingDone, features } = useAuth();
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
  // loading window. Without this guard, feature-gated routes (/alerts)
  // would false-redirect to /dashboard before /api/auth/me even returns.
  //
  // Wait for loading=false before evaluating the feature gate — render the
  // same Suspense fallback for visual parity with the route's own chunk load.
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
          (Add your first site, Add your first asset) that 403'd on submit.
          The wizard is admin/manager onboarding by design. */}
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
          <Route path="/invite/accept" element={<InviteAcceptPage />} />
          <Route path="/share/:token" element={<SharedCompliancePage />} />{/* #21 public auditor/insurer view */}
          <Route path="/try" element={<TryParserPage />} />{/* #17 public parser-as-funnel */}

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

          {/* Field Mode — authenticated but OUTSIDE the desktop Layout shell.
              FieldLayout provides its own slim phone chrome (no sidebar). */}
          <Route
            path="/field"
            element={
              <ProtectedRoute>
                <FieldLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<FieldHome />} />
            <Route path="scan" element={<FieldScan />} />
            <Route path="new" element={<FieldNewAsset />} />
            <Route path="batch" element={<FieldBatchNameplate />} />
            <Route path="asset/:id" element={<FieldAsset />} />
          </Route>

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
            <Route path="assets"             element={<AssetsList />} />
            <Route path="assets/new"         element={
              <RequireRole roles={['admin', 'manager']}>
                <NewAsset />
              </RequireRole>
            } />
            <Route path="assets/import"      element={
              <RequireRole roles={['admin', 'manager']}>
                <ImportAssets />
              </RequireRole>
            } />
            <Route path="test-reports/import" element={
              <RequireRole roles={['admin', 'manager', 'oem_admin']}>
                <TestReportImport />
              </RequireRole>
            } />
            <Route path="add-data" element={
              <RequireRole roles={['admin', 'manager']}>
                <AddData />
              </RequireRole>
            } />
            {/* #34 bulk historical backfill — zip of report PDFs/photos. */}
            <Route path="backfill" element={
              <RequireRole roles={['admin', 'manager', 'oem_admin']}>
                <BackfillImport />
              </RequireRole>
            } />
            <Route path="assets/archived"    element={<ArchivedAssets />} />
            <Route path="assets/:id"         element={<AssetDetail />} />
            <Route path="sites"              element={<SitesList />} />
            <Route path="sites/:id"          element={<SiteDetail />} />
            <Route path="contractors"        element={<ContractorsList />} />
            <Route path="contractors/qemw-wallet" element={<QemwWallet />} />
            <Route path="contractors/:id"    element={<ContractorDetail />} />
            <Route path="work-orders"        element={<WorkOrdersList />} />
            <Route path="work-orders/:id"    element={<WorkOrderDetail />} />
            {/* Account-wide deficiency triage — all roles (viewers see the
                list; Resolve/Reopen affordances are manager+ inside the page,
                mirroring the server's requireManager gates). */}
            <Route path="deficiencies"       element={<DeficienciesPage />} />
            <Route path="calendar"           element={<ComplianceCalendar />} />
            {/* Industry news feed — all roles, like the other read surfaces. */}
            <Route path="news"               element={<NewsPage />} />
            <Route path="profile"            element={<ProfilePage />} />

            {/* Legacy ServiceCycle paths — old bookmarks and emails land on the
                nearest ServiceCycle equivalent instead of the in-shell 404. */}
            <Route path="contracts/*"        element={<Navigate to="/assets" replace />} />
            <Route path="vendors/*"          element={<Navigate to="/contractors" replace />} />

            {/* Reports hub — manager / admin only. Individual report pages
                are launched from the hub itself. */}
            <Route path="reports" element={
              <RequireRole roles={['admin', 'manager']}>
                <ReportsHub />
              </RequireRole>
            } />
            {/* Per-standard compliance suite — same admin/manager gate as the
                hub so a viewer can't deep-link past the hub's role check. */}
            <Route path="reports/compliance" element={
              <RequireRole roles={['admin', 'manager']}>
                <ComplianceStandardsReport />
              </RequireRole>
            } />
            <Route path="reports/compliance/:standardCode" element={
              <RequireRole roles={['admin', 'manager']}>
                <ComplianceStandardDetailReport />
              </RequireRole>
            } />
            <Route path="reports/snapshots" element={
              <RequireRole roles={['admin', 'manager']}>
                <AuditSnapshotsPage />
              </RequireRole>
            } />
            <Route path="reports/overdue" element={
              <RequireRole roles={['admin', 'manager']}>
                <OverdueReport />
              </RequireRole>
            } />
            <Route path="reports/standards-library" element={
              <RequireRole roles={['admin', 'manager']}>
                <StandardsLibrary />
              </RequireRole>
            } />

            {/* Audit visits + recommendation tracking — same admin/manager
                gate as the Reports hub. */}
            <Route path="audits" element={
              <RequireRole roles={['admin', 'manager']}>
                <AuditsPage />
              </RequireRole>
            } />

            {/* Equipment Template Library — open to all authenticated roles */}
            <Route path="equipment-templates" element={<EquipmentTemplates />} />

            {/* Outage Consolidation Planner — account-wide view */}
            <Route path="outage-planner" element={<OutagePlannerPage />} />

            {/* CMMS bulk import hub — admin / manager only */}
            <Route path="import" element={
              <RequireRole roles={['admin', 'manager']}>
                <CmmsImport />
              </RequireRole>
            } />

            {/* OEM fleet dashboard — oem_admin only */}
            <Route path="fleet" element={
              <RequireRole roles={['oem_admin']}>
                <FleetDashboard />
              </RequireRole>
            } />

            {/* Feature-gated pages — redirect to dashboard if not enabled */}
            <Route path="alerts"  element={featureGated('alerts', <AlertsPage />)} />
            <Route path="disaster-response" element={<DisasterResponsePage />} />

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
          servicecycle:open-help CustomEvent, so a null Suspense fallback is
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
          <div className="page-subtitle">The URL you followed doesn't match a page in ServiceCycle.</div>
        </div>
      </div>
      <div className="page-body">
        <div className="card" style={{ padding: 24, maxWidth: 520 }}>
          <p style={{ marginBottom: 12, color: 'var(--color-text-secondary)' }}>
            Double-check the link, or jump to one of these:
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            <li><a href="/dashboard"   style={{ color: 'var(--color-primary)' }}>→ Dashboard</a></li>
            <li><a href="/assets"      style={{ color: 'var(--color-primary)' }}>→ Assets</a></li>
            <li><a href="/work-orders" style={{ color: 'var(--color-primary)' }}>→ Work Orders</a></li>
            <li><a href="/contractors" style={{ color: 'var(--color-primary)' }}>→ Contractors</a></li>
            <li><a href="/alerts"      style={{ color: 'var(--color-primary)' }}>→ Alerts</a></li>
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
