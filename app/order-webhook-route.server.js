import { authenticate } from "./shopify.server";
import { PermanentWebhookError, receiveOrderWebhook } from "./webhook-inbox.server.js";
import { logEvent, reportFailure } from "./observability.server.js";

export async function handleOrderWebhook(request) {
  const webhookId = request.headers.get("X-Shopify-Webhook-Id");
  const eventId = request.headers.get("X-Shopify-Event-Id");
  const { payload, shop, topic } = await authenticate.webhook(request);
  const started = Date.now();
  try {
    const deliveryId = await receiveOrderWebhook({ shopDomain: shop, webhookId, eventId, topic, payload });
    logEvent("webhook_received", { shop, topic, deliveryId, durationMs: Date.now() - started });
    return new Response();
  } catch (error) {
    // Resending can't change the outcome, and repeated failures can get the
    // subscription removed. Acknowledge it; reconciliation backfills real orders.
    if (error instanceof PermanentWebhookError) {
      reportFailure("webhook_rejected", error, { shop, topic, webhookId, durationMs: Date.now() - started });
      return new Response();
    }
    reportFailure("webhook_receipt", error, { shop, topic, webhookId, durationMs: Date.now() - started });
    return new Response("Webhook receipt failed", { status: 500 });
  }
}
