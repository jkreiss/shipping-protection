-- US setup now turns on stolen, lost, and damaged, matching the checkout copy.
-- Shops that already finished setup only had the stolen flag.
UPDATE "ShopConfiguration"
SET "stolenCoverageEnabled" = true,
    "lostCoverageEnabled" = true,
    "damagedCoverageEnabled" = true
WHERE "attachmentStrategy" = 'CHECKOUT_UI_CART_TRANSFORM';
