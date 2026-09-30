-- Records whether each protection purchase was charged the live price.
-- Existing rows stay NULL: they were never checked.
DO $$ BEGIN
  CREATE TYPE "ProtectionPricingCheck" AS ENUM ('MATCHED', 'UNMATCHED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ProtectionPurchase" ADD COLUMN IF NOT EXISTS "pricingCheck" "ProtectionPricingCheck";
