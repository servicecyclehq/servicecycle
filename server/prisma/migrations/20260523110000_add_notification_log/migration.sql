-- S5-FN-07 (v0.75.x): NotificationLog table.
-- Records every alert digest send attempt so operators can answer
-- "did contract X renewal alert actually reach the recipient?"
-- without parsing application logs. 180-day retention enforced by nightly prune cron.

CREATE TABLE "notification_logs" (
    "id"                TEXT NOT NULL,
    "accountId"         TEXT NOT NULL,
    "userId"            TEXT,
    "contractId"        TEXT,
    "channel"           TEXT NOT NULL,
    "template"          TEXT NOT NULL,
    "recipient"         TEXT NOT NULL,
    "providerMessageId" TEXT,
    "status"            TEXT NOT NULL,
    "errorMessage"      TEXT,
    "alertCount"        INTEGER,
    "sentAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_logs_accountId_fkey"
        FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE,
    CONSTRAINT "notification_logs_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL,
    CONSTRAINT "notification_logs_contractId_fkey"
        FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE SET NULL
);

CREATE INDEX "notification_logs_accountId_sentAt_idx"
    ON "notification_logs" ("accountId", "sentAt" DESC);

CREATE INDEX "notification_logs_contractId_sentAt_idx"
    ON "notification_logs" ("contractId", "sentAt" DESC);

CREATE INDEX "notification_logs_sentAt_idx"
    ON "notification_logs" ("sentAt");