import { authenticate } from "../shopify.server";
import { reconcileOrders } from "../order-reconciliation.server";

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const result = await reconcileOrders({
    admin,
    shopDomain: session.shop,
  });
  return Response.json(result);
};
