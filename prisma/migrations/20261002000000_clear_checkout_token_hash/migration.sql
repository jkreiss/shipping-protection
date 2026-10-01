-- The app no longer stores checkout-token hashes. Clear the existing ones;
-- the column is dropped in a later release, after no running code writes it.
UPDATE "Order" SET "checkoutTokenHash" = NULL WHERE "checkoutTokenHash" IS NOT NULL;
