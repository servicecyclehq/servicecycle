/**
 * TermsPage — public, unauthenticated route at /terms.
 *
 * Refreshed in the legal-stack sweep to render the canonical draft from
 * legal/terms-draft-2026-05.md via the shared LegalDocPage chrome. The
 * pre-sweep version was hard-coded JSX that pre-dated the lawyer-review
 * scaffolding; the rendered draft carries an unmissable disclaimer
 * banner so readers know it's not the published version yet.
 *
 * After lawyer sign-off, swap the import to legal/terms.md and remove
 * the disclaimer header from the source file.
 */

import LegalDocPage from './LegalDocPage';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
// eslint-disable-next-line import/no-unresolved
import termsSource from '../legal/terms-draft-2026-05.md?raw';

export default function TermsPage() {
  useDocumentTitle('Terms of service');
  return (
    <LegalDocPage
      source={termsSource}
      lastUpdated="legal/terms-draft-2026-05.md"
    />
  );
}
