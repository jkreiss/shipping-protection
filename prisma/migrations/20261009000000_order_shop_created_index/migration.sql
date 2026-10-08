-- The retention purge finds each shop's expired orders. Built concurrently so
-- order writes continue during the deploy; this file must stay one statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Order_shopId_shopifyCreatedAt_idx" ON "Order"("shopId", "shopifyCreatedAt");
