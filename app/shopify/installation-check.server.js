import { unauthenticated } from "../shopify.server.js";
import { SESSION_INSTALLATION_QUERY } from "../session-storage.server.js";
import { adminGraphql, isAccessLost } from "./admin-graphql.server.js";
import { reportFailure } from "../observability.server.js";

// Shopify's answer to refreshing a revoked offline token.
function refreshRejected(error) {
  return (
    error?.response?.code === 400 &&
    error.response.body?.error === "invalid_subject_token"
  );
}

// Whether the app is installed on the shop now, by Shopify's answer to the
// stored token. Any installation the token reaches counts: this decides whether
// shop/redact deletes data, so it doesn't add the domain and shop-ID checks a
// new session must pass. A token refresh along the way still saves the session
// under those checks, so a renamed myshopify domain can read as "not installed"
// then. A rejected or missing token means it isn't installed. Anything else (including a failed token refresh, which
// the Shopify library reports as a bare 500) is reported and thrown, so a
// webhook that depends on it fails and Shopify retries it; if it never
// resolves, the report is what an operator acts on.
export async function shopifyInstallationActive(
  shop,
  { loadAdmin = unauthenticated.admin } = {},
) {
  try {
    const { admin } = await loadAdmin(shop);
    const data = await adminGraphql(
      admin,
      SESSION_INSTALLATION_QUERY,
      {},
      { shop },
    );
    return Boolean(data?.currentAppInstallation?.id);
  } catch (error) {
    if (isAccessLost(error) || refreshRejected(error)) return false;
    reportFailure(
      "installation_check_failed",
      error instanceof Error ? error : new Error("Installation check failed."),
      { shop },
    );
    throw error;
  }
}
