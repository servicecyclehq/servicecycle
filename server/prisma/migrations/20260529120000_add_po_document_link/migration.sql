-- Link a Document to a PurchaseOrder (PO file upload, item #10).
-- onDelete: SET NULL so archiving/removing a PO never deletes the stored file.
ALTER TABLE "documents" ADD COLUMN "poId" TEXT;
CREATE INDEX "documents_poId_idx" ON "documents"("poId");
ALTER TABLE "documents" ADD CONSTRAINT "documents_poId_fkey" FOREIGN KEY ("poId") REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;