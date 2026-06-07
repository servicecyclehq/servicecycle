import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

// v0.47 perf — soft-gate
//
// Pre-v0.47, this component returned a full-tree "Loading…" until
// AuthContext's /api/auth/me probe resolved. That serialised the entire
// critical path of any protected page behind one round-trip — the lazy
// route chunk, the page's own mount fetches, and React reconciliation all
// waited for /api/auth/me to come back before they could even START.
//
// On /contracts that meant the hard-refresh waterfall looked like:
//   HTML shell → entry JS → /api/auth/me → ContractsList chunk → 6 mount
//   fetches → render.
// ~5 s wall-clock-serial on the CF-fronted demo droplet.
//
// Soft-gate behaviour now:
//   • While loading=true (token present, /api/auth/me in flight) the route
//     subtree renders OPTIMISTICALLY. The page's own data fetches go out
//     in parallel with the auth probe instead of strictly after it.
//   • If loading=false and the user is null (no token at all, or token
//     was rejected), we redirect to /login the same way as before.
//   • If a page-level fetch races and 401s because the token is invalid,
//     the axios interceptor in client.js handles the redirect — see
//     redirectToLoginIfProtected() there. The brief race is the price of
//     the ~500-800 ms saving on the happy path.
//
// Feature-flag gated routes (alerts/news/budget/ingest) still rely on
// `useAuth().features`, which is null-out during the optimistic window —
// the corresponding <Route element=…> branches in App.jsx handle the
// loading=true case themselves so they don't false-redirect to /dashboard.
export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();

  // Only redirect once we're sure: probe finished + no user.
  if (!loading && !user) {
    return <Navigate to="/login" replace />;
  }

  // Render optimistically during the loading window. Children with strict
  // user dependencies should gate their effects on `user` themselves.
  return children;
}
