-- CR-1 (audit-2 2026-05-22): userId removed from canonical() in activityLogChain.js.
-- The chain resettle (nulling rowHash/prevHash on all activity_logs rows) was
-- applied directly via psql on 2026-05-23. This migration is a no-op so Prisma
-- records it as applied and does not block future migrations.
SELECT 1;
