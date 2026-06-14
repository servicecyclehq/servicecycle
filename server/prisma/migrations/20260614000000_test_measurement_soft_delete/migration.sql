-- Soft-delete for test measurements (forensics/immutability): retain the
-- row with deletedAt set instead of hard-deleting evidence.
ALTER TABLE "test_measurements" ADD COLUMN "deletedAt" TIMESTAMP(3);
