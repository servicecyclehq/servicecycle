-- F2: add the 'draft' quote-request status (saved but not yet sent).
ALTER TYPE "QuoteRequestStatus" ADD VALUE IF NOT EXISTS 'draft';
