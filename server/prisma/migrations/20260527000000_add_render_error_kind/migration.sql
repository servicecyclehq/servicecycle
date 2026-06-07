-- Add kind discriminator to render_errors so the same table can persist
-- render-boundary crashes (kind='render'), window.onerror events
-- (kind='uncaught'), unhandled promise rejections (kind='promise'),
-- and Express middleware errors (kind='server'). Default 'render' for
-- backwards compatibility with rows already persisted under v0.90.0.
ALTER TABLE "render_errors" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'render';
CREATE INDEX "render_errors_kind_idx" ON "render_errors"("kind");
