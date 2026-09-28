import { authenticate } from "../shopify.server";
import { markShopUninstalled } from "../shop.server";

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await markShopUninstalled(shop);

  return new Response();
};
