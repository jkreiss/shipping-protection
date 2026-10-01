-- Lease that serializes protection setup and rate changes per shop.
ALTER TABLE "Shop" ADD COLUMN "settingsLockedUntil" TIMESTAMP(3);
