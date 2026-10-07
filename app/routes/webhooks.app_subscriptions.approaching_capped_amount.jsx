import { authenticate } from "../shopify.server";
import { noteCapApproaching } from "../billing/agreements.server";
import { logEvent } from "../observability.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  logEvent("webhook_received", { shop, topic });
  await noteCapApproaching({ shopDomain: shop, payload });

  return new Response();
};
