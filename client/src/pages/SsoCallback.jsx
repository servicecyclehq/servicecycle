import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../api/client';
import BrandMark from '../components/BrandMark';

// Public landing for the SSO handoff. The server redirects here with a single-
// use ?code=; we trade it once at POST /api/sso/exchange for the real JWT pair
// (no tokens ever ride in the URL), then store the session like a normal login.
export default function SsoCallback() {
  const { setAuthData } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [error, setError] = useState(false);
  const ran = useRef(false); // guard React strict-mode double-invoke (code is single-use)

  // Reuse the same open-redirect guard the login page uses.
  const nextParam = searchParams.get('next');
  const safeNext = nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/dashboard';

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const code = searchParams.get('code');
    if (!code) { navigate('/login?sso_error=unavailable', { replace: true }); return; }

    api.post('/api/sso/exchange', { code })
      .then((res) => {
        const d = res?.data?.data;
        if (!d?.token) throw new Error('no token');
        setAuthData(d.token, d.refreshToken, d.user);
        const dest = d.redirectTo && d.redirectTo.startsWith('/') && !d.redirectTo.startsWith('//') ? d.redirectTo : safeNext;
        navigate(dest, { replace: true });
      })
      .catch(() => {
        setError(true);
        setTimeout(() => navigate('/login?sso_error=unavailable', { replace: true }), 1500);
      });
  }, [searchParams, navigate, setAuthData, safeNext]);

  return (
    <div className="login-page">
      <div className="login-box" style={{ textAlign: 'center' }}>
        <div className="login-logo" style={{ justifyContent: 'center' }}>
          <BrandMark size={40} variant="light" />
        </div>
        {error ? (
          <p role="alert" style={{ color: 'var(--color-text-secondary)' }}>
            We couldn’t complete single sign-on. Returning you to the sign-in page…
          </p>
        ) : (
          <p aria-live="polite" style={{ color: 'var(--color-text-secondary)' }}>Signing you in…</p>
        )}
      </div>
    </div>
  );
}
