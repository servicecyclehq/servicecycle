-- CreateTable
CREATE TABLE "instance_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "setupCompletedAt" TIMESTAMP(3),
    "setupCompletedBy" TEXT,
    "demoMode" BOOLEAN NOT NULL DEFAULT false,
    "demoLastResetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instance_config_pkey" PRIMARY KEY ("id")
);
