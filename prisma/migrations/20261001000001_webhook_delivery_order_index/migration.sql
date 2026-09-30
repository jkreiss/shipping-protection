-- Lets the worker claim every queued delivery for one order together.
CREATE INDEX IF NOT EXISTS "WebhookDelivery_shopId_shopifyOrderId_status_idx"
  ON "WebhookDelivery"("shopId", "shopifyOrderId", "status");
