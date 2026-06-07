-- Hot-path indexes flagged by the Opus N+1 audit (2026-05-02). Each was a
-- full table scan on heavily-used filter fields:
--   - Contract.cancelByDate           — every Dashboard / Alerts cancel-window query
--   - Contract.evaluationStartByDate  — every overdue-review query
--   - Contract.internalOwnerId        — every scope-restricted viewer query
--   - Document.filePath               — every doc download lookup
--   - User.passwordResetToken         — every password-reset attempt

CREATE INDEX "contracts_accountId_cancelByDate_idx"
  ON "contracts"("accountId", "cancelByDate");

CREATE INDEX "contracts_accountId_evaluationStartByDate_idx"
  ON "contracts"("accountId", "evaluationStartByDate");

CREATE INDEX "contracts_accountId_internalOwnerId_idx"
  ON "contracts"("accountId", "internalOwnerId");

CREATE INDEX "documents_accountId_filePath_idx"
  ON "documents"("accountId", "filePath");

CREATE INDEX "users_passwordResetToken_idx"
  ON "users"("passwordResetToken");