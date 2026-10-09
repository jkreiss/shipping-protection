-- The retention purge sweeps finished deliveries received before its cutoff.
-- One statement: CONCURRENTLY cannot run inside a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "WebhookDelivery_status_receivedAt_idx" ON "WebhookDelivery"("status", "receivedAt");
