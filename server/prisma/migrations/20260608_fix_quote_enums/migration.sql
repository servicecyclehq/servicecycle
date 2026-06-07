-- Fix enum value names to match Prisma schema
-- QuoteDriver: budgetary_only → budgetary
ALTER TYPE "QuoteDriver" RENAME VALUE 'budgetary_only' TO 'budgetary';
-- QuoteTimeline: within_one_week → within_1_week, within_thirty_days → within_30_days
ALTER TYPE "QuoteTimeline" RENAME VALUE 'within_one_week' TO 'within_1_week';
ALTER TYPE "QuoteTimeline" RENAME VALUE 'within_thirty_days' TO 'within_30_days';
