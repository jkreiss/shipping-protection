import { redirect } from "react-router";
import { login } from "../../shopify.server";

// Shopify's library sends requests it can't tie to a shop here. A valid
// ?shop= makes login() throw a redirect into Shopify's install flow; anything
// else goes to the landing page, because the App Store forbids asking
// merchants to type a shop domain (requirement 2.3.1).
export const loader = async ({ request }) => {
  await login(request);

  throw redirect("/");
};
