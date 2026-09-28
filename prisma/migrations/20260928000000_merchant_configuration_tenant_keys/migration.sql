BEGIN;

-- Stop before changing financial rows if existing tenant references disagree.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "ProtectionRefund" r
    JOIN "Order" o ON o.id = r."orderId"
    WHERE r."shopId" <> o."shopId"
  ) OR EXISTS (
    SELECT 1 FROM "ProtectionPurchase" p
    JOIN "Order" o ON o.id = p."orderId"
    JOIN "PricingRule" pr ON pr.id = p."pricingRuleId"
    WHERE pr."shopId" <> o."shopId"
  ) OR EXISTS (
    SELECT 1 FROM "Shop" s
    JOIN "PricingRule" pr ON pr.id = s."activePricingRuleId"
    WHERE pr."shopId" <> s.id
  ) THEN
    RAISE EXCEPTION 'Cross-shop financial relationship detected; inspect and repair before migration';
  END IF;
END $$;

CREATE TYPE "ProtectionAttachmentStrategy" AS ENUM ('NONE', 'CHECKOUT_UI_CART_TRANSFORM', 'THEME_CART');

CREATE TABLE "ShopConfiguration" (
  "shopId" TEXT NOT NULL,
  "protectionEnabled" BOOLEAN NOT NULL DEFAULT false,
  "stolenCoverageEnabled" BOOLEAN NOT NULL DEFAULT false,
  "lostCoverageEnabled" BOOLEAN NOT NULL DEFAULT false,
  "damagedCoverageEnabled" BOOLEAN NOT NULL DEFAULT false,
  "returnsEnabled" BOOLEAN NOT NULL DEFAULT false,
  "freeReturnsEnabled" BOOLEAN NOT NULL DEFAULT false,
  "attachmentStrategy" "ProtectionAttachmentStrategy" NOT NULL DEFAULT 'NONE',
  "emailClaimIntakeEnabled" BOOLEAN NOT NULL DEFAULT false,
  "formClaimIntakeEnabled" BOOLEAN NOT NULL DEFAULT false,
  "adminClaimIntakeEnabled" BOOLEAN NOT NULL DEFAULT false,
  "autoApprovalEnabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShopConfiguration_pkey" PRIMARY KEY ("shopId")
);

ALTER TABLE "ShopConfiguration" ADD CONSTRAINT "ShopConfiguration_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing shops with a published active rule retain their current offer.
INSERT INTO "ShopConfiguration" (
  "shopId", "protectionEnabled", "stolenCoverageEnabled", "lostCoverageEnabled",
  "damagedCoverageEnabled", "attachmentStrategy", "updatedAt"
)
SELECT s.id, true, true, true, true, 'CHECKOUT_UI_CART_TRANSFORM', CURRENT_TIMESTAMP
FROM "Shop" s JOIN "PricingRule" pr ON pr.id = s."activePricingRuleId"
WHERE pr."shopId" = s.id AND pr.state = 'ACTIVE';

ALTER TABLE "ProtectionPurchase" ADD COLUMN "shopId" TEXT;
UPDATE "ProtectionPurchase" p SET "shopId" = o."shopId"
FROM "Order" o WHERE o.id = p."orderId";
ALTER TABLE "ProtectionPurchase" ALTER COLUMN "shopId" SET NOT NULL;

CREATE UNIQUE INDEX "Order_id_shopId_key" ON "Order"("id", "shopId");
CREATE UNIQUE INDEX "PricingRule_id_shopId_key" ON "PricingRule"("id", "shopId");
CREATE INDEX "ProtectionPurchase_shopId_idx" ON "ProtectionPurchase"("shopId");
CREATE UNIQUE INDEX "ProtectionPurchase_orderId_shopId_key" ON "ProtectionPurchase"("orderId", "shopId");

ALTER TABLE "ProtectionPurchase" DROP CONSTRAINT "ProtectionPurchase_orderId_fkey";
ALTER TABLE "ProtectionRefund" DROP CONSTRAINT "ProtectionRefund_orderId_fkey";
ALTER TABLE "ProtectionPurchase" ADD CONSTRAINT "ProtectionPurchase_orderId_shopId_fkey"
  FOREIGN KEY ("orderId", "shopId") REFERENCES "Order"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProtectionRefund" ADD CONSTRAINT "ProtectionRefund_orderId_shopId_fkey"
  FOREIGN KEY ("orderId", "shopId") REFERENCES "Order"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProtectionPurchase" ADD CONSTRAINT "ProtectionPurchase_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
