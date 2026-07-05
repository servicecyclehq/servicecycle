-- A4 work-order chat + photo annotation (2026-07-05)
-- docs/scoping/audits/wo-chat-annotation-research.md Option 2: flat
-- WorkOrderComment feed + simple tap-to-pin DocumentAnnotation. Additive
-- only -- two new tables, no changes to any existing table.
--
-- Hand-written rather than a raw `prisma migrate diff` dump: a fresh shadow-
-- database replay of the full migration history produces unrelated noise
-- (constraint/index renames on access_blockers / failed_login_attempts /
-- rate_sheet / work_order_part_usages, and a tsvector DROP DEFAULT + GIN
-- index drop on drawing_page_texts) because an earlier migration in this
-- history (20260705_edms_phase1_scaffold) was deliberately hand-edited to
-- add a real Postgres GENERATED column that Prisma's own diff engine can't
-- fully reconcile against a clean replay. None of that is related to this
-- change, so it's deliberately excluded here -- see this same session's
-- backfillDrawingRevisions / EDMS commits for that migration's own history.

-- CreateTable
CREATE TABLE "work_order_comments" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" VARCHAR(4000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "work_order_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_annotations" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "shapes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "document_annotations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_order_comments_accountId_idx" ON "work_order_comments"("accountId");

-- CreateIndex
CREATE INDEX "work_order_comments_workOrderId_createdAt_idx" ON "work_order_comments"("workOrderId", "createdAt");

-- CreateIndex
CREATE INDEX "document_annotations_accountId_idx" ON "document_annotations"("accountId");

-- CreateIndex
CREATE INDEX "document_annotations_documentId_idx" ON "document_annotations"("documentId");

-- AddForeignKey
ALTER TABLE "work_order_comments" ADD CONSTRAINT "work_order_comments_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_comments" ADD CONSTRAINT "work_order_comments_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_comments" ADD CONSTRAINT "work_order_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_annotations" ADD CONSTRAINT "document_annotations_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
