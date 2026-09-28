import { authenticate } from "../shopify.server";
import { deleteShopData } from "../shop.server";

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  if (topic === "SHOP_REDACT") {
    await deleteShopData(shop);
  }

  // Customer requests contain PII, but this app stores no customer data.
  // Authentication above verifies the HMAC before this acknowledgement.
  return new Response();
};
