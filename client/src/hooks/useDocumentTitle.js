// Pass-3 audit LOW #2 (2026-05-17): per-route document.title in the SPA.
//
// Pre-fix every page rendered with the static "LapseIQ — Renewal management
// that respects your data" title from client/index.html. That hurt browser-
// tab discrimination ("which tab was the dashboard?"), screen-reader page
// announcements, and history-stack navigation. The demo SPA is noindex
// so SEO benefit is minimal, but the UX benefit is real.
//
// Usage:
//   import { useDocumentTitle } from '../hooks/useDocumentTitle';
//   function Dashboard() {
//     useDocumentTitle('Dashboard');
//     return ...;
//   }
// produces document.title = "Dashboard · LapseIQ".

import { useEffect } from 'react';

const SUFFIX = ' · LapseIQ';

export function useDocumentTitle(title) {
  useEffect(() => {
    if (!title) return;
    const prev = document.title;
    document.title = `${title}${SUFFIX}`;
    // Restore on unmount so a flash of a leftover title doesn't appear
    // during route transitions (especially with React.lazy + Suspense).
    return () => { document.title = prev; };
  }, [title]);
}

export default useDocumentTitle;
