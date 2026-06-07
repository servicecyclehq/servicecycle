-- CreateTable: payment_schedules
CREATE TABLE "payment_schedules" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "scheduleType" TEXT NOT NULL DEFAULT 'installment',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable: payment_installments
CREATE TABLE "payment_installments" (
    "id" TEXT NOT NULL,
    "paymentScheduleId" TEXT NOT NULL,
    "yearNumber" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_installments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_schedules_contractId_key" ON "payment_schedules"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_installments_paymentScheduleId_yearNumber_key" ON "payment_installments"("paymentScheduleId", "yearNumber");

-- CreateIndex
CREATE INDEX "payment_installments_paymentScheduleId_idx" ON "payment_installments"("paymentScheduleId");

-- AddForeignKey
ALTER TABLE "payment_schedules" ADD CONSTRAINT "payment_schedules_contractId_fkey"
    FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_installments" ADD CONSTRAINT "payment_installments_paymentScheduleId_fkey"
    FOREIGN KEY ("paymentScheduleId") REFERENCES "payment_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
