import { authenticate } from "../shopify.server";
import { deleteCustomerOrders, deleteShopData } from "../shop.server";
import { shopifyInstallationActive } from "../shopify/installation-check.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  if (topic === "SHOP_REDACT") {
    await deleteShopData(shop, { isInstalled: shopifyInstallationActive });
  }

  // The app stores no customer profile, only order records keyed by order ID,
  // so erasing a customer means erasing the orders Shopify names.
  if (topic === "CUSTOMERS_REDACT") {
    await deleteCustomerOrders(shop, payload?.orders_to_redact);
  }

  // A data request needs nothing back: the stored order records hold no
  // customer details. Authentication above verifies the HMAC before this
  // acknowledgement.
  return new Response();
};
