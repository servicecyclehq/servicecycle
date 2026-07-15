-- Additive: store the draft-time derived multi-source topology (feeds/sides/dualCorded/gaps + busHints)
-- on the arc-flash ingest so the review UI can surface gap flags and confirm can persist AssetFeed edges.
ALTER TABLE "arc_flash_ingests" ADD COLUMN "derivedTopology" JSONB;
