-- [C-13] Dedicated QuoteDriver for arc-flash re-study opportunities.
-- A confirmed material change vs the prior arc-flash study invalidates it
-- ("new study required"); the auto-created QuoteRequest now carries a first-class
-- driver instead of borrowing a generic one, so the sales-manager opportunities
-- roll-up can filter by it. Additive enum value; IF NOT EXISTS = idempotent/safe.
ALTER TYPE "QuoteDriver" ADD VALUE IF NOT EXISTS 'compliance_restudy';
