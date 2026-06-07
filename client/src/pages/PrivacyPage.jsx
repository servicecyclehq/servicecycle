/**
 * PrivacyPage — public, unauthenticated route at /privacy.
 *
 * Refreshed in the legal-stack sweep to render the canonical draft from
 * legal/privacy-draft-2026-05.md via the shared LegalDocPage chrome.
 * The pre-sweep version was hard-coded JSX; the rendered draft carries
 * an unmissable disclaimer banner so readers know it's not the
 * published version yet.
 *
 * After lawyer sign-off, swap the import to legal/privacy.md and
 * remove the disclaimer header from the source file.
 */

import LegalDocPage from './LegalDocPage';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
// eslint-disable-next-line import/no-unresolved
import privacySource from '../legal/privacy-draft-2026-05.md?raw';

export default function PrivacyPage() {
  useDocumentTitle('Privacy policy');
  return (
    <LegalDocPage
      source={privacySource}
      lastUpdated="legal/privacy-draft-2026-05.md"
    />
  );
}
