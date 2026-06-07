/**
 * EulaPage — public, unauthenticated route at /eula.
 *
 * Referenced from scripts/install.sh (the EULA acceptance prompt
 * directs operators here) and from the legal/README.md cross-link
 * map, so this URL must resolve.
 *
 * Source of truth is legal/eula-draft-2026-05.md — single file, two
 * surfaces (markdown for lawyer review + this page for the operator).
 * After lawyer sign-off, swap the import to legal/eula.md and remove
 * the disclaimer banner.
 */

import LegalDocPage from './LegalDocPage';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
// eslint-disable-next-line import/no-unresolved
import eulaSource from '../legal/eula-draft-2026-05.md?raw';

export default function EulaPage() {
  useDocumentTitle('End-user license');
  return (
    <LegalDocPage
      source={eulaSource}
      lastUpdated="legal/eula-draft-2026-05.md"
    />
  );
}
