import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { installGlobalErrorHandlers } from './lib/globalErrorReporter.js';

// Brand typography:
// Inter + JetBrains Mono are self-hosted via @font-face in index.css,
// served same-origin from /fonts/*.woff2. The previous attempt at importing
// here turned out to silently break the production build on Linux runners
// (Vite/Rollup tree-shook the entire app tree downstream of those 5 imports,
// producing a 185KB stub bundle missing all app code). See v0.5.4 incident
// notes. No third-party font CDN is used (telemetry-free brand); the woff2
// files live in client/public/fonts.

import './index.css';

// v0.90.8: install window.onerror + unhandledrejection handlers BEFORE any
// React or user code runs. Closes the proactive-ops gap that ErrorBoundary
// can't cover (event-handler throws, async errors, rejected promises). Both
// classes auto-POST to /api/errors/render with kind='uncaught' or 'promise'.
installGlobalErrorHandlers();

// v0.92.19: take manual control of scroll restoration so the browser does not
// restore a stale offset on reload/redirect (e.g. landing mid-dashboard after
// the signup redirect). The app restores scroll itself where it wants to.
if (typeof window !== 'undefined' && 'scrollRestoration' in window.history) {
  window.history.scrollRestoration = 'manual';
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
