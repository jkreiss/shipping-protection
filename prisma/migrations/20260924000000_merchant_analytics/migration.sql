ALTER TABLE "Shop" ADD COLUMN "orderReconciliationUntil" TIMESTAMP(3);

ALTER TABLE "Order"
  ADD COLUMN "isTest" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "financialStatus" TEXT,
  ADD COLUMN "firstPaidAt" TIMESTAMP(3),
  ADD COLUMN "paidEligible" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "paidProtected" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "paidProtectionFee" DECIMAL(20,4) NOT NULL DEFAULT 0,
  ADD COLUMN "paidProtectionLineIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "Order_shopId_firstPaidAt_idx" ON "Order"("shopId", "firstPaidAt");

CREATE TABLE "ProtectionRefund" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "shopifyRefundId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "amount" DECIMAL(20,4) NOT NULL DEFAULT 0,
  "currencyCode" TEXT NOT NULL,
  "succeededAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProtectionRefund_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProtectionRefund_shopId_shopifyRefundId_key" ON "ProtectionRefund"("shopId", "shopifyRefundId");
CREATE INDEX "ProtectionRefund_shopId_status_idx" ON "ProtectionRefund"("shopId", "status");
ALTER TABLE "ProtectionRefund" ADD CONSTRAINT "ProtectionRefund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
