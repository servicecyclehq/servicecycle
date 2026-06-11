import { Component, Fragment } from 'react';

/**
 * Global error boundary — catches render/lifecycle exceptions in any child
 * subtree and renders a friendly recovery UI instead of a blank screen.
 *
 * v0.76.1 (H1-4, H5-3): added "Try reloading this section" retry button,
 * context-aware "← Back to Settings" link when on /settings, support blurb
 * with generated error code, and timestamp logged in componentDidCatch.
 *
 * Class component is required; hooks cannot implement getDerivedStateFromError
 * or componentDidCatch per the React spec.
 *
 * Placement: wraps <AppRoutes /> in App.jsx so every page is covered.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorCode: null, retryKey: 0 };
    this.handleReset = this.handleReset.bind(this);
    this.handleRetry = this.handleRetry.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    const errorCode = Date.now().toString(36).toUpperCase();
    this.setState({ errorCode });
    const payload = {
      errorCode,
      kind:           'render',  // v0.90.8: explicit kind for render_errors discriminator
      name:           error && error.name,
      message:        error && error.message,
      stack:          error && error.stack,
      componentStack: info && info.componentStack,
      path:           typeof window !== 'undefined' && window.location ? window.location.pathname : null,
      appVersion: (typeof document !== 'undefined' && document.querySelector('meta[name="servicecycle-build-id"]') && document.querySelector('meta[name="servicecycle-build-id"]').getAttribute('content')) || null,
      at:             new Date().toISOString(),
    };
    try { window.__lastBoundaryError = payload; } catch (_) {}
    // v0.90.0: fire-and-forget POST so the server sees every render crash
    // the moment it happens. The endpoint always responds 204 -- failures
    // here are silent so a broken telemetry path never cascades.
    try {
      var ses = window.sessionStorage;
      var seenKey = 'servicecycle_boundary_posted_' + errorCode;
      if (!ses || !ses.getItem(seenKey)) {
        if (ses) { try { ses.setItem(seenKey, '1'); } catch (_) {} }
        var token = null;
        try { token = window.localStorage && window.localStorage.getItem('servicecycle_token'); } catch (_) {}
        var headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = 'Bearer ' + token;
        fetch('/api/errors/render', {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(payload),
          credentials: 'same-origin',
          keepalive: true,
        }).catch(function () {});
      }
    } catch (_) {}
    console.error('[ErrorBoundary] Uncaught render error (code:', errorCode + '):', error, info?.componentStack);
  }

  // Retry: unmount/remount the crashed subtree without a full page reload.
  handleRetry() {
    this.setState(s => ({ hasError: false, error: null, errorCode: null, retryKey: s.retryKey + 1 }));
  }

  // Reset + navigate home (existing behaviour, kept as secondary action).
  handleReset() {
    this.setState({ hasError: false, error: null, errorCode: null });
    window.location.assign('/dashboard');
  }

  render() {
    if (!this.state.hasError) return <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>;

    const { error, errorCode } = this.state;
    const isDev = import.meta.env?.DEV;
    const onSettings = window.location.pathname.includes('/settings');

    const linkStyle = {
      fontSize: 'var(--font-size-ui)', color: 'var(--color-primary, #0d4f6e)',
      textDecoration: 'underline', cursor: 'pointer', background: 'none',
      border: 'none', padding: 0, fontFamily: 'inherit',
    };

    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', minHeight: '100vh',
        padding: 32, textAlign: 'center',
        background: 'var(--color-bg, #fff)',
        color: 'var(--color-text, #111)',
        fontFamily: 'var(--font-sans, system-ui, sans-serif)',
      }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
          Something went wrong
        </h1>
        <p style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-text-secondary, #6b7280)', maxWidth: 420, lineHeight: 1.6, marginBottom: 24 }}>
          ServiceCycle hit an unexpected error on this page. Your data is safe — this
          is a display issue. Try reloading the section or navigating away.
        </p>

        {/* Primary: retry without full page reload */}
        <button
          onClick={this.handleRetry}
          style={{
            padding: '9px 20px', fontSize: 'var(--font-size-data)', fontWeight: 600,
            background: 'var(--color-primary, #0d4f6e)', color: '#fff',
            border: 'none', borderRadius: 6, cursor: 'pointer',
            marginBottom: 14,
          }}
        >
          Try reloading this section
        </button>

        {/* Secondary: context-aware back link + dashboard */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap', justifyContent: 'center' }}>
          {onSettings && (
            <button onClick={() => window.location.assign('/settings')} style={linkStyle}>
              ← Back to Settings
            </button>
          )}
          <button onClick={this.handleReset} style={linkStyle}>
            Go to Dashboard
          </button>
        </div>

        {/* Support blurb with error code */}
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary, #6b7280)', maxWidth: 380, lineHeight: 1.6 }}>
          Still stuck? Email{' '}
          <a href="mailto:support@servicecycle.app" style={{ color: 'inherit' }}>
            support@servicecycle.app
          </a>
          {errorCode && (
            <> and include error code: <strong>{errorCode}</strong></>
          )}.
        </p>

        {isDev && error && (
          <pre style={{
            marginTop: 28, padding: '12px 16px', maxWidth: 640,
            textAlign: 'left', fontSize: 'var(--font-size-xs)', lineHeight: 1.5,
            background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.2)',
            borderRadius: 6, overflow: 'auto', color: '#b91c1c',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {error.toString()}
          </pre>
        )}
      </div>
    );
  }
}
