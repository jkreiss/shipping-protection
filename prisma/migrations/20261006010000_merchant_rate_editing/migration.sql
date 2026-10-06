-- Preserve existing merchants' access; the operator can lock individual stores.
ALTER TABLE "ShopConfiguration"
ADD COLUMN "protectionRateEditable" BOOLEAN NOT NULL DEFAULT true;
