-- Loss and damage in transit are the merchant's existing Australian Consumer
-- Law obligation and must not be sold as protection.
UPDATE "ShopConfiguration"
SET "lostCoverageEnabled" = false, "damagedCoverageEnabled" = false
WHERE "lostCoverageEnabled" OR "damagedCoverageEnabled";
