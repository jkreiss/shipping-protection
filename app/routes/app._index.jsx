import { authenticate } from "../shopify.server";

// App Bridge hides the rel="home" link, so the dashboard lives at
// /app/overview where it can appear as its own navigation item.
export const loader = async ({ request }) => {
  const { redirect } = await authenticate.admin(request);
  return redirect("/app/overview", { target: "_self" });
};
