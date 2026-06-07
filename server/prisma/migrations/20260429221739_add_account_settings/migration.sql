-- CreateTable
CREATE TABLE "account_settings" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_settings_accountId_idx" ON "account_settings"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "account_settings_accountId_key_key" ON "account_settings"("accountId", "key");

-- AddForeignKey
ALTER TABLE "account_settings" ADD CONSTRAINT "account_settings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
