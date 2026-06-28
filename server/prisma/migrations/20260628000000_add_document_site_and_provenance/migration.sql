-- Migration: 20260628000000_add_document_site_and_provenance
-- (1) Site-level documents: a drawing (e.g. a substation one-line) can attach to
--     a SITE rather than one asset, so it surfaces on every asset at that site
--     via an asset<->site union on the read paths. Nullable + ON DELETE SET NULL;
--     existing asset/work-order/account docs are unaffected.
-- (2) Document provenance: human-authoritative trust status, conservative default
--     ('unverified'). Drives the trust badge + a Revenue Intelligence signal.

-- (1) Document.siteId
ALTER TABLE "documents" ADD COLUMN "siteId" TEXT;
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "documents_siteId_idx" ON "documents"("siteId");

-- (2) Document.provenance
CREATE TYPE "DocProvenance" AS ENUM ('pe_sealed', 'engineered', 'as_built', 'vendor', 'unverified');
ALTER TABLE "documents" ADD COLUMN "provenance" "DocProvenance" NOT NULL DEFAULT 'unverified';
