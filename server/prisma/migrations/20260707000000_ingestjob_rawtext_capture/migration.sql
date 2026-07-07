-- IngestJob.rawText (2026-07-07 overnight capture-gap fix): durable store for
-- the full text pdfplumber/OCR read off a document, separate from `result`
-- (which only ever carries the post-collapse preview). Nullable, additive,
-- zero behavior change until the worker starts writing to it.
ALTER TABLE "ingest_jobs" ADD COLUMN "rawText" TEXT;
