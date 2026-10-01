import { readFileSync } from "node:fs";

export const STAGING_SHOP = "app-test-kwvgodpl.myshopify.com";
export const AUTH_DIRECTORY = new URL("../.auth/", import.meta.url);
export const INGESTION_TIMEOUT = 180_000;

/** @param {Record<string, string | undefined>} env @param {string} key */
function required(env, key) {
  const value = env[key]?.trim();
  if (!value)
    throw new Error(
      `Set ${key} in .env.e2e. The runner never reads the application's .env.`,
    );
  return value;
}

/** @param {Record<string, string | undefined>} env @param {"suite" | "auth" | "restore"} purpose */
export function readConfig(env = process.env, purpose = "suite") {
  const shopDomain = required(env, "E2E_SHOP_DOMAIN");
  if (shopDomain !== STAGING_SHOP)
    throw new Error(`Only the staging store ${STAGING_SHOP} is allowed.`);
  const toml = readFileSync(
    new URL("../../shopify.app.staging.toml", import.meta.url),
    "utf8",
  );
  const appOrigin = new URL(
    toml.match(/^application_url\s*=\s*"([^"]+)"/m)?.[1] ?? "",
  ).origin;
  const clientId = toml.match(/^client_id\s*=\s*"([^"]+)"/m)?.[1];
  if (
    !clientId ||
    appOrigin !== "https://insurance-backend-staging.up.railway.app" ||
    clientId === "96f5fc78f8240440dd885872ce8c11cb"
  ) {
    throw new Error(
      "The staging app configuration is missing or points at production.",
    );
  }
  const adminAppUrl =
    env.E2E_ADMIN_APP_URL?.trim() ||
    `https://admin.shopify.com/store/app-test-kwvgodpl/apps/${clientId}`;
  assertAdminUrl(adminAppUrl);
  const databaseUrl =
    purpose === "auth" ? "" : required(env, "E2E_DATABASE_URL");
  if (databaseUrl && !/^postgres(?:ql)?:\/\//.test(databaseUrl))
    throw new Error(
      "E2E_DATABASE_URL must be a read-only PostgreSQL connection.",
    );
  const gateway = env.E2E_PAYMENT_GATEWAY?.trim() ?? "";
  if (purpose === "suite" && !["bogus", "shopify-payments"].includes(gateway))
    throw new Error(
      "Set E2E_PAYMENT_GATEWAY to a supported test gateway: bogus or shopify-payments.",
    );
  const physicalVariantId =
    purpose === "suite" ? required(env, "E2E_PHYSICAL_VARIANT_ID") : "";
  const digitalVariantId =
    purpose === "suite" ? required(env, "E2E_DIGITAL_VARIANT_ID") : "";
  if (
    purpose === "suite" &&
    (!/^\d+$/.test(physicalVariantId) ||
      !/^\d+$/.test(digitalVariantId) ||
      physicalVariantId === digitalVariantId)
  )
    throw new Error("Set distinct numeric fixture variant IDs.");
  const shippingCountry =
    (purpose === "suite" ? env.E2E_SHIPPING_COUNTRY?.trim() : undefined) ||
    "US";
  if (shippingCountry !== "US" && shippingCountry !== "AU")
    throw new Error(
      "E2E_SHIPPING_COUNTRY must be US or AU for the test address.",
    );
  const shippingAddress =
    shippingCountry === "US"
      ? {
          country: "US",
          state: "CA",
          street: "1 Market Street",
          city: "San Francisco",
          postalCode: "94105",
          phone: "4155550100",
        }
      : {
          country: "AU",
          state: "NSW",
          street: "1 George Street",
          city: "Sydney",
          postalCode: "2000",
          phone: "0400000000",
        };
  return {
    shopDomain,
    appOrigin,
    clientId,
    adminAppUrl,
    databaseUrl,
    physicalVariantId,
    digitalVariantId,
    discountCode: purpose === "suite" ? required(env, "E2E_DISCOUNT_CODE") : "",
    paymentGateway: /** @type {"bogus" | "shopify-payments"} */ (gateway),
    shippingAddress,
    testGatewayCardName: "Test payment gateway",
    storefrontPassword: env.E2E_STOREFRONT_PASSWORD ?? "",
  };
}

export function assertAdminUrl(url = "") {
  const parsed = new URL(url);
  if (
    parsed.origin !== "https://admin.shopify.com" ||
    !/^\/store\/app-test-kwvgodpl\/apps\/[^/]+\/?$/.test(parsed.pathname)
  )
    throw new Error(
      "The Admin URL must open the installed app in the staging store.",
    );
}

/** @param {ReturnType<typeof readConfig>} config @param {{frameUrl: string, apiKey: string | null}} identity */
export function assertAppIdentity(config, identity) {
  if (
    new URL(identity.frameUrl).origin !== config.appOrigin ||
    identity.apiKey !== config.clientId
  )
    throw new Error(
      "The browser did not load the expected staging app. Run npm run test:e2e:auth to sign in again.",
    );
}

/** @param {{superuser: boolean, canWrite: boolean, canReadSessions: boolean, canCreate: boolean}} role */
export function assertReadOnlyRole(role) {
  if (role.superuser || role.canWrite || role.canReadSessions || role.canCreate)
    throw new Error(
      "E2E_DATABASE_URL must use a read-only staging login without Session access or schema creation privileges. See e2e/README.md.",
    );
}

/** @param {{variant_id: number, requires_shipping: boolean, original_price: number, quantity: number}[]} items @param {ReturnType<typeof readConfig>} config @param {boolean} mixed */
export function assertFixtureCart(items, config, mixed) {
  const physical = items.find(
    (item) => String(item.variant_id) === config.physicalVariantId,
  );
  const digital = items.find(
    (item) => String(item.variant_id) === config.digitalVariantId,
  );
  if (
    items.length !== (mixed ? 2 : 1) ||
    !physical?.requires_shipping ||
    physical.original_price !== 10000 ||
    physical.quantity !== 1 ||
    (mixed &&
      (!digital ||
        digital.requires_shipping ||
        digital.original_price !== 4000 ||
        digital.quantity !== 1))
  ) {
    throw new Error(
      "The staging fixtures must be one shippable item priced at 100 and one digital item priced at 40, with no unexpected cart items.",
    );
  }
}

export function syntheticEmail(runId = "", label = "") {
  return `e2e-${runId}-${label}@example.com`;
}

/** @param {string} label @param {number} amount @param {string} currency */
export function assertRefundTotal(label, amount, currency) {
  const invalid = () => {
    throw new Error("The native refund total must equal only the expected protection fee and currency.");
  };
  if (!Number.isFinite(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(currency))
    invalid();
  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  const symbol = { USD: "US$", AUD: "A$", CAD: "CA$", NZD: "NZ$" }[currency];
  const allowed = [`Refund ${money}`, `Refund ${money} ${currency}`];
  if (symbol) allowed.push(`Refund ${symbol}${amount.toFixed(2)}`);
  if (!allowed.includes(label.replace(/\s+/g, " ").trim())) invalid();
}
