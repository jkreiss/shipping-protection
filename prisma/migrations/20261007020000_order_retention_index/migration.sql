-- The daily retention purge finds orders placed before its cutoff.
CREATE INDEX "Order_shopifyCreatedAt_idx" ON "Order"("shopifyCreatedAt");
