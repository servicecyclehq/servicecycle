-- AddColumn: resolvedAt on quote_requests and arc_flash_incidents
-- These fields track when a record reached a terminal/resolved state.
-- quote_requests: set when status transitions to 'accepted' or 'declined'.
-- arc_flash_incidents: set when status transitions to 'closed'.

ALTER TABLE "quote_requests" ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMP(3);
ALTER TABLE "arc_flash_incidents" ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMP(3);
