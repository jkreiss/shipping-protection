ALTER TABLE "WebhookDelivery"
  ADD COLUMN IF NOT EXISTS "shopifyOrderId" TEXT,
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "leaseToken" TEXT,
  ADD COLUMN IF NOT EXISTS "leaseUntil" TIMESTAMP(3);

-- Old processed deliveries do not need to be replayed. Failed deliveries need
-- an order ID before the new worker can safely retry them.
UPDATE "WebhookDelivery" SET "shopifyOrderId" = '' WHERE "shopifyOrderId" IS NULL;
ALTER TABLE "WebhookDelivery" ALTER COLUMN "shopifyOrderId" SET NOT NULL;
ALTER TABLE "WebhookDelivery" ALTER COLUMN "status" SET DEFAULT 'PENDING';
UPDATE "WebhookDelivery" SET "status" = 'FAILED' WHERE "status" = 'PROCESSING';
CREATE INDEX IF NOT EXISTS "WebhookDelivery_status_nextAttemptAt_leaseUntil_idx"
  ON "WebhookDelivery"("status", "nextAttemptAt", "leaseUntil");

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "paidMerchandiseAmount" DECIMAL(20,4);
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "orderHistoryStartAt" TIMESTAMP(3);
ALTER TABLE "ProtectionPurchase"
  ADD COLUMN IF NOT EXISTS "coveredMerchandiseAmount" DECIMAL(20,4),
  ADD COLUMN IF NOT EXISTS "orderValueAmount" DECIMAL(20,4);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_paid_merchandise_check') THEN
    ALTER TABLE "Order" ADD CONSTRAINT "Order_paid_merchandise_check"
      CHECK ("paidMerchandiseAmount" IS NULL OR "paidMerchandiseAmount" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProtectionPurchase_covered_value_check') THEN
    ALTER TABLE "ProtectionPurchase" ADD CONSTRAINT "ProtectionPurchase_covered_value_check"
      CHECK (("coveredMerchandiseAmount" IS NULL OR "coveredMerchandiseAmount" >= 0) AND
             ("orderValueAmount" IS NULL OR "orderValueAmount" >= 0));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION prevent_paid_order_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."firstPaidAt" IS NOT NULL AND (
    NEW."firstPaidAt" IS DISTINCT FROM OLD."firstPaidAt" OR
    NEW."paidEligible" IS DISTINCT FROM OLD."paidEligible" OR
    NEW."paidMerchandiseAmount" IS DISTINCT FROM OLD."paidMerchandiseAmount"
  ) THEN
    RAISE EXCEPTION 'Paid order snapshot is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "Order_paid_snapshot_immutable" ON "Order";
CREATE TRIGGER "Order_paid_snapshot_immutable" BEFORE UPDATE ON "Order"
  FOR EACH ROW EXECUTE FUNCTION prevent_paid_order_snapshot_mutation();
