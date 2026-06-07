-- v0.90.0 (2026-05-26): client-side render-error telemetry.
-- ErrorBoundary auto-POSTs to /api/errors/render and the server persists
-- each fire here. Lets us see B-class bugs (render crashes) the moment they
-- happen in prod instead of waiting for a customer report.

CREATE TABLE "render_errors" (
    "id" TEXT NOT NULL,
    "errorCode" TEXT NOT NULL,
    "name" TEXT,
    "message" TEXT,
    "stack" TEXT,
    "componentStack" TEXT,
    "path" TEXT,
    "userId" TEXT,
    "accountId" TEXT,
    "userAgent" TEXT,
    "lapseiqVersion" TEXT,
    "ip" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "render_errors_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "render_errors_occurredAt_idx" ON "render_errors"("occurredAt");
CREATE INDEX "render_errors_errorCode_idx" ON "render_errors"("errorCode");
CREATE INDEX "render_errors_userId_idx" ON "render_errors"("userId");