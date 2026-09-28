BEGIN;

-- A failed preflight rolls back the entire release. Repair these records from
-- Shopify before retrying; guessing a tenant or a paid snapshot would alter money.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Shop" s JOIN "PricingRule" r ON r.id = s."activePricingRuleId"
    WHERE r."shopId" <> s.id
  ) OR EXISTS (
    SELECT 1 FROM "ProtectionPurchase" p JOIN "Order" o ON o.id = p."orderId"
    WHERE p."shopId" <> o."shopId"
  ) OR EXISTS (
    SELECT 1 FROM "ProtectionPurchase" p JOIN "PricingRule" r ON r.id = p."pricingRuleId"
    WHERE p."shopId" <> r."shopId"
  ) OR EXISTS (
    SELECT 1 FROM "ProtectionRefund" r JOIN "Order" o ON o.id = r."orderId"
    WHERE r."shopId" <> o."shopId"
  ) THEN
    RAISE EXCEPTION 'Cross-shop relation detected; repair before durable-protection migration';
  END IF;

  IF EXISTS (SELECT 1 FROM "ProtectionRefund" WHERE status NOT IN ('PENDING', 'CONFIRMED', 'UNATTRIBUTED'))
     OR EXISTS (SELECT 1 FROM "ProtectionRefund" WHERE status = 'CONFIRMED' AND "succeededAt" IS NULL) THEN
    RAISE EXCEPTION 'Invalid protection refund status or confirmation date; repair before migration';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Order" o WHERE
      o."paidProtectionFee" < 0 OR
      (o."firstPaidAt" IS NULL AND (o."paidEligible" OR o."paidProtected")) OR
      (o."paidProtected" AND (o."firstPaidAt" IS NULL OR cardinality(o."paidProtectionLineIds") = 0)) OR
      (NOT o."paidProtected" AND (o."paidProtectionFee" <> 0 OR cardinality(o."paidProtectionLineIds") <> 0)) OR
      cardinality(o."paidProtectionLineIds") <> (
        SELECT count(DISTINCT line_id) FROM unnest(o."paidProtectionLineIds") AS line_ids(line_id)
      )
  ) OR EXISTS (
    SELECT 1 FROM "ProtectionPurchase" p JOIN "Order" o ON o.id = p."orderId"
    WHERE o."firstPaidAt" IS NOT NULL AND NOT o."paidProtected"
  ) THEN
    RAISE EXCEPTION 'Inconsistent paid-order snapshot; reconcile from Shopify before migration';
  END IF;
END $$;

CREATE TYPE "PricingBasis" AS ENUM ('SHIPPABLE_PRE_DISCOUNT');
CREATE TYPE "ProtectionRefundStatus" AS ENUM ('PENDING', 'CONFIRMED', 'UNATTRIBUTED');
CREATE TYPE "ClaimType" AS ENUM ('LOST', 'STOLEN', 'DAMAGED');
CREATE TYPE "ClaimStatus" AS ENUM ('SUBMITTED', 'VALIDATING', 'AUTO_APPROVED', 'REVIEW_REQUIRED', 'MERCHANT_APPROVED', 'MERCHANT_REJECTED', 'RESOLUTION_PENDING', 'RESOLVED');
CREATE TYPE "ClaimEventType" AS ENUM ('SUBMITTED', 'VALIDATION_COMPLETED', 'AUTO_APPROVED', 'REVIEW_REQUESTED', 'MERCHANT_APPROVED', 'MERCHANT_REJECTED', 'RESOLUTION_REQUESTED', 'RESOLVED');

ALTER TABLE "PricingRule" DROP CONSTRAINT "PricingRule_basis_check";
ALTER TABLE "PricingRule" ALTER COLUMN "basis" TYPE "PricingBasis" USING "basis"::"PricingBasis";
ALTER TABLE "ProtectionRefund" ALTER COLUMN "status" TYPE "ProtectionRefundStatus" USING "status"::"ProtectionRefundStatus";

ALTER TABLE "OrderLine" ADD COLUMN "shopId" TEXT;
UPDATE "OrderLine" l SET "shopId" = o."shopId" FROM "Order" o WHERE o.id = l."orderId";
ALTER TABLE "OrderLine" ALTER COLUMN "shopId" SET NOT NULL;

ALTER TABLE "Shop" ADD COLUMN "activePricingRuleShopId" TEXT;
UPDATE "Shop" SET "activePricingRuleShopId" = id WHERE "activePricingRuleId" IS NOT NULL;

ALTER TABLE "ProtectionPurchase"
  ADD COLUMN "pricingContractVersion" INTEGER,
  ADD COLUMN "protectionLineIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "purchasedAt" TIMESTAMP(3),
  ALTER COLUMN "eligibleSubtotalAmount" DROP NOT NULL;

-- An existing purchase's rule attribution is trustworthy only if its fee and
-- current protection line IDs match the immutable first-payment snapshot.
-- Earlier schema versions did not store a contract version or line IDs.
WITH paid AS (
  SELECT p.id,
    p."feeAmount" = o."paidProtectionFee" AND p."currencyCode" = o."currencyCode" AND
    ARRAY(SELECT l."shopifyLineItemId" FROM "OrderLine" l
          WHERE l."orderId" = o.id AND l."isProtection" ORDER BY l."shopifyLineItemId") =
    ARRAY(SELECT line_id FROM unnest(o."paidProtectionLineIds") AS line_ids(line_id) ORDER BY line_id)
      AS snapshot_matches
  FROM "ProtectionPurchase" p JOIN "Order" o ON o.id = p."orderId"
  WHERE o."paidProtected"
), trusted AS (
  SELECT p.id,
    paid.snapshot_matches AND p."attributionStatus" = 'ATTRIBUTED' AND
    p."pricingRuleId" IS NOT NULL AND p."ruleId" IS NOT NULL AND
    p."ruleVersion" IS NOT NULL AND p."rateBasisPoints" IS NOT NULL AND
    p.basis = 'SHIPPABLE_PRE_DISCOUNT' AND
    p."ruleId" = r."ruleId" AND p."ruleVersion" = r.version AND
    p."rateBasisPoints" = r."rateBasisPoints" AND p.basis = r.basis::TEXT
      AS keep_attribution
  FROM "ProtectionPurchase" p JOIN paid ON paid.id = p.id
  LEFT JOIN "PricingRule" r ON r.id = p."pricingRuleId"
)
UPDATE "ProtectionPurchase" p SET
  "purchasedAt" = o."firstPaidAt",
  "protectionLineIds" = o."paidProtectionLineIds",
  "feeAmount" = o."paidProtectionFee",
  "currencyCode" = o."currencyCode",
  "eligibleSubtotalAmount" = NULL,
  "pricingRuleId" = CASE WHEN trusted.keep_attribution THEN p."pricingRuleId" ELSE NULL END,
  "ruleId" = CASE WHEN trusted.keep_attribution THEN p."ruleId" ELSE NULL END,
  "ruleVersion" = CASE WHEN trusted.keep_attribution THEN p."ruleVersion" ELSE NULL END,
  "rateBasisPoints" = CASE WHEN trusted.keep_attribution THEN p."rateBasisPoints" ELSE NULL END,
  basis = CASE WHEN trusted.keep_attribution THEN p.basis ELSE NULL END,
  "attributionStatus" = CASE WHEN trusted.keep_attribution THEN 'ATTRIBUTED'::"ProtectionAttributionStatus" ELSE 'UNATTRIBUTED'::"ProtectionAttributionStatus" END,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "Order" o, paid, trusted
WHERE p."orderId" = o.id AND paid.id = p.id AND trusted.id = p.id;

-- Restore paid protection records removed by later order edits. Historical
-- eligible subtotal and pricing provenance cannot be reconstructed safely.
INSERT INTO "ProtectionPurchase" (
  id, "orderId", "shopId", "currencyCode", "eligibleSubtotalAmount", "feeAmount",
  "protectionLineIds", "purchasedAt", "attributionStatus", "createdAt", "updatedAt"
)
SELECT 'historical-' || o.id, o.id, o."shopId", o."currencyCode", NULL,
  o."paidProtectionFee", o."paidProtectionLineIds", o."firstPaidAt",
  'UNATTRIBUTED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Order" o
WHERE o."paidProtected" AND NOT EXISTS (
  SELECT 1 FROM "ProtectionPurchase" p WHERE p."orderId" = o.id AND p."shopId" = o."shopId"
);

UPDATE "ProtectionPurchase" p SET "protectionLineIds" = ARRAY(
  SELECT l."shopifyLineItemId" FROM "OrderLine" l
  WHERE l."orderId" = p."orderId" AND l."isProtection" ORDER BY l."shopifyLineItemId"
)
WHERE p."purchasedAt" IS NULL;

ALTER TABLE "Shop" DROP CONSTRAINT "Shop_activePricingRuleId_fkey";
ALTER TABLE "OrderLine" DROP CONSTRAINT "OrderLine_orderId_fkey";
ALTER TABLE "ProtectionPurchase" DROP CONSTRAINT "ProtectionPurchase_pricingRuleId_fkey";
DROP INDEX "Shop_activePricingRuleId_key";
DROP INDEX "PricingRule_ruleId_key";
DROP INDEX "OrderLine_orderId_isProtection_idx";
DROP INDEX "OrderLine_orderId_shopifyLineItemId_key";
DROP INDEX "ProtectionPurchase_orderId_key";
DROP INDEX "ProtectionPurchase_pricingRuleId_idx";
DROP INDEX "ProtectionPurchase_shopId_idx";
DROP INDEX "ProtectionPurchase_attributionStatus_idx";

CREATE UNIQUE INDEX "Shop_activePricingRuleId_activePricingRuleShopId_key" ON "Shop"("activePricingRuleId", "activePricingRuleShopId");
CREATE UNIQUE INDEX "PricingRule_shopId_ruleId_key" ON "PricingRule"("shopId", "ruleId");
CREATE INDEX "OrderLine_shopId_orderId_isProtection_idx" ON "OrderLine"("shopId", "orderId", "isProtection");
CREATE UNIQUE INDEX "OrderLine_shopId_orderId_shopifyLineItemId_key" ON "OrderLine"("shopId", "orderId", "shopifyLineItemId");
CREATE INDEX "ProtectionPurchase_shopId_pricingRuleId_idx" ON "ProtectionPurchase"("shopId", "pricingRuleId");
CREATE INDEX "ProtectionPurchase_shopId_attributionStatus_idx" ON "ProtectionPurchase"("shopId", "attributionStatus");
CREATE UNIQUE INDEX "ProtectionPurchase_shopId_id_key" ON "ProtectionPurchase"("shopId", id);
CREATE INDEX "ProtectionRefund_shopId_orderId_idx" ON "ProtectionRefund"("shopId", "orderId");

ALTER TABLE "Shop" ADD CONSTRAINT "Shop_activePricingRuleId_activePricingRuleShopId_fkey"
  FOREIGN KEY ("activePricingRuleId", "activePricingRuleShopId") REFERENCES "PricingRule"(id, "shopId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Shop" ADD CONSTRAINT "Shop_activePricingRule_shop_check"
  CHECK (("activePricingRuleId" IS NULL AND "activePricingRuleShopId" IS NULL) OR
    ("activePricingRuleId" IS NOT NULL AND "activePricingRuleShopId" IS NOT NULL AND "activePricingRuleShopId" = id));
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_orderId_shopId_fkey"
  FOREIGN KEY ("orderId", "shopId") REFERENCES "Order"(id, "shopId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProtectionPurchase" ADD CONSTRAINT "ProtectionPurchase_pricingRuleId_shopId_fkey"
  FOREIGN KEY ("pricingRuleId", "shopId") REFERENCES "PricingRule"(id, "shopId") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "Order" ADD CONSTRAINT "Order_paid_protection_snapshot_check"
  CHECK ("paidProtectionFee" >= 0 AND
    ("firstPaidAt" IS NOT NULL OR (NOT "paidEligible" AND NOT "paidProtected")) AND
    ("paidProtected" OR ("paidProtectionFee" = 0 AND cardinality("paidProtectionLineIds") = 0)) AND
    (NOT "paidProtected" OR ("firstPaidAt" IS NOT NULL AND cardinality("paidProtectionLineIds") > 0)));
ALTER TABLE "Order" ADD CONSTRAINT "Order_amounts_check"
  CHECK ("subtotalAmount" >= 0 AND "totalAmount" >= 0 AND
    "totalDiscountsAmount" >= 0 AND "totalShippingAmount" >= 0 AND "totalTaxAmount" >= 0);
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_amounts_check"
  CHECK (quantity >= 0 AND "originalUnitAmount" >= 0 AND "preDiscountAmount" >= 0 AND
    "totalDiscountAmount" >= 0 AND "finalAmount" >= 0);
ALTER TABLE "ProtectionRefund" ADD CONSTRAINT "ProtectionRefund_amount_check"
  CHECK (amount >= 0 AND (status <> 'CONFIRMED' OR "succeededAt" IS NOT NULL));
ALTER TABLE "ProtectionPurchase" ADD CONSTRAINT "ProtectionPurchase_snapshot_check"
  CHECK ("feeAmount" >= 0 AND ("eligibleSubtotalAmount" IS NULL OR "eligibleSubtotalAmount" >= 0) AND
    ("purchasedAt" IS NULL OR cardinality("protectionLineIds") > 0) AND
    ("pricingContractVersion" IS NULL OR "pricingContractVersion" >= 1) AND
    ("attributionStatus" <> 'ATTRIBUTED' OR
      ("pricingRuleId" IS NOT NULL AND "ruleId" IS NOT NULL AND
       "ruleVersion" IS NOT NULL AND "ruleVersion" >= 1 AND
       "rateBasisPoints" IS NOT NULL AND "rateBasisPoints" BETWEEN 1 AND 10000 AND
       basis IS NOT NULL AND basis = 'SHIPPABLE_PRE_DISCOUNT')));

CREATE TABLE "Claim" (
  id TEXT NOT NULL PRIMARY KEY,
  "shopId" TEXT NOT NULL,
  "protectionPurchaseId" TEXT NOT NULL,
  type "ClaimType" NOT NULL,
  status "ClaimStatus" NOT NULL DEFAULT 'SUBMITTED',
  description TEXT,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "ClaimEvent" (
  id TEXT NOT NULL PRIMARY KEY,
  "shopId" TEXT NOT NULL,
  "claimId" TEXT NOT NULL,
  type "ClaimEventType" NOT NULL,
  "actorRef" TEXT,
  reason TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Claim_shopId_status_submittedAt_idx" ON "Claim"("shopId", status, "submittedAt");
CREATE INDEX "Claim_shopId_protectionPurchaseId_idx" ON "Claim"("shopId", "protectionPurchaseId");
CREATE UNIQUE INDEX "Claim_shopId_id_key" ON "Claim"("shopId", id);
CREATE INDEX "ClaimEvent_shopId_claimId_createdAt_id_idx" ON "ClaimEvent"("shopId", "claimId", "createdAt", id);

ALTER TABLE "Claim" ADD CONSTRAINT "Claim_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_shopId_protectionPurchaseId_fkey" FOREIGN KEY ("shopId", "protectionPurchaseId") REFERENCES "ProtectionPurchase"("shopId", id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClaimEvent" ADD CONSTRAINT "ClaimEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClaimEvent" ADD CONSTRAINT "ClaimEvent_shopId_claimId_fkey" FOREIGN KEY ("shopId", "claimId") REFERENCES "Claim"("shopId", id) ON DELETE CASCADE ON UPDATE CASCADE;

-- Once payment is confirmed, even a later direct write cannot rewrite or
-- remove the financial snapshot. Shop redaction is the sole delete exception.
CREATE FUNCTION prevent_confirmed_purchase_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."purchasedAt" IS NOT NULL THEN
    IF TG_OP = 'DELETE' AND current_setting('app.allow_shop_redaction', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Confirmed ProtectionPurchase is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ProtectionPurchase_confirmed_immutable" BEFORE UPDATE OR DELETE ON "ProtectionPurchase"
  FOR EACH ROW EXECUTE FUNCTION prevent_confirmed_purchase_mutation();

CREATE FUNCTION require_confirmed_claim_purchase() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ProtectionPurchase" p
    WHERE p."shopId" = NEW."shopId" AND p.id = NEW."protectionPurchaseId"
      AND p."purchasedAt" IS NOT NULL FOR SHARE
  ) THEN
    RAISE EXCEPTION 'A claim requires a confirmed protection purchase';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Claim_confirmed_purchase" BEFORE INSERT OR UPDATE OF "shopId", "protectionPurchaseId" ON "Claim"
  FOR EACH ROW EXECUTE FUNCTION require_confirmed_claim_purchase();

-- Events may be appended, but ordinary updates/deletes are forbidden. Privacy
-- redaction explicitly enables transaction-local deletion before removing shop.
CREATE FUNCTION prevent_claim_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_shop_redaction', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ClaimEvent is append-only';
END $$;
CREATE TRIGGER "ClaimEvent_append_only" BEFORE UPDATE OR DELETE ON "ClaimEvent"
  FOR EACH ROW EXECUTE FUNCTION prevent_claim_event_mutation();

COMMIT;
