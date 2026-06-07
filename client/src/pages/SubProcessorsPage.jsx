/**
 * SubProcessorsPage — public, unauthenticated route at /sub-processors.
 *
 * Referenced from the DPA template (Annex 3 cross-references this page
 * as the live source of truth) and the privacy policy. Customers'
 * procurement teams expect this URL to exist on any vendor's trust
 * page.
 *
 * Source of truth is legal/sub-processors-2026-05.md.
 */

import LegalDocPage from './LegalDocPage';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
// eslint-disable-next-line import/no-unresolved
import source from '../legal/sub-processors-2026-05.md?raw';

export default function SubProcessorsPage() {
  useDocumentTitle('Sub-processors');
  return (
    <LegalDocPage
      source={source}
      lastUpdated="legal/sub-processors-2026-05.md"
    />
  );
}
