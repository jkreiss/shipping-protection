import { authenticate } from "../shopify.server";
import { applySubscriptionWebhook, syncBillingAgreement } from "../billing/agreements.server";
import { logEvent, reportFailure } from "../observability.server";

export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  logEvent("webhook_received", { shop, topic });
  const result = await applySubscriptionWebhook({ shopDomain: shop, payload });
  // A subscription we have not stored (for example, a second approval page the
  // merchant opened): read the shop's subscriptions from Shopify instead.
  if (result === "unmatched" && admin) {
    try {
      await syncBillingAgreement({ admin, shopDomain: shop });
    } catch (error) {
      reportFailure("billing_sync_failed", error, { shop, topic });
    }
  }

  return new Response();
};
