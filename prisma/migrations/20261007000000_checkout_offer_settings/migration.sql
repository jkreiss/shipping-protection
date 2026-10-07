ALTER TABLE "ShopConfiguration"
  ADD COLUMN "protectionPreselectionEditable" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "protectionCopyEditable" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "protectionPreselected" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "protectionCheckboxLabel" TEXT,
  ADD COLUMN "protectionSupportingText" TEXT;
