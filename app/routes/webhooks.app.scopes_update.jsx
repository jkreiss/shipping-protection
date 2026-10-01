import { authenticate } from "../shopify.server";
import { recordGrantedScopes } from "../shop.server";
import { logEvent, reportFailure } from "../observability.server";

export const action = async ({ request }) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);

  logEvent("webhook_received", { shop, topic });
  if (session) {
    const recorded = await recordGrantedScopes({
      shopDomain: shop, sessionId: session.id, scopes: payload?.current,
    });
    if (!recorded) {
      reportFailure("scopes_update_invalid", new Error("Scopes payload has no scope list."), { shop });
    }
  }

  return new Response();
};
