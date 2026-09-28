import { authenticate } from "./shopify.server";
import { processOrderWebhook } from "./order-ingestion.server";

export async function handleOrderWebhook(request) {
  const webhookId = request.headers.get("X-Shopify-Webhook-Id");
  const eventId = request.headers.get("X-Shopify-Event-Id");
  const { payload, shop, topic, admin } = await authenticate.webhook(request);
  if (!admin) return new Response("Offline Admin session unavailable", { status: 503 });
  try {
    await processOrderWebhook({ shopDomain: shop, webhookId, eventId, topic, payload, admin });
    return new Response();
  } catch {
    return new Response("Order reconciliation failed", { status: 500 });
  }
}
