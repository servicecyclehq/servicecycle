/**
 * DemoSandboxNoticePage — public, unauthenticated route at
 * /demo-sandbox-notice (and /legal/demo-sandbox-notice alias).
 *
 * Renders the canonical Demo Sandbox Notice from
 * legal/demo-sandbox-notice-2026-05.md via the shared LegalDocPage chrome.
 *
 * Linked from:
 *   - Register.jsx inline checkbox label (the "Demo Sandbox Notice above"
 *     reference, which is also rendered inline in the form for visibility)
 *   - LegalDocPage footer-nav (cross-document discovery)
 *
 * After lawyer sign-off, swap the import to the published filename and
 * remove the disclaimer header from the source file.
 */

import LegalDocPage from './LegalDocPage';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
// eslint-disable-next-line import/no-unresolved
import demoNoticeSource from '../legal/demo-sandbox-notice-2026-05.md?raw';

export default function DemoSandboxNoticePage() {
  useDocumentTitle('Demo sandbox notice');
  return (
    <LegalDocPage
      source={demoNoticeSource}
      lastUpdated="legal/demo-sandbox-notice-2026-05.md"
    />
  );
}
