import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { readConfig } from "./support/config.js";

// Explicit, one-time fixture preparation. The test runner never invokes this.
const config = readConfig(process.env, "auth");
const marker = "yasas-playwright-fixture";
const discountTitle = "E2E physical fixture 10%";

/** @typedef {{id: string, price: string, inventoryItem: {requiresShipping: boolean, tracked: boolean}}} Variant */
/** @typedef {{id: string, handle: string, tags: string[], variants: {nodes: Variant[]}}} Product */
/** @typedef {Record<string, unknown> & {data?: Record<string, unknown>, errors?: {message: string}[]}} GraphqlResult */
/** @typedef {{id: string, codeDiscount: {title?: string, customerGets?: {value: {percentage?: number}, items: {products?: {nodes: {id: string}[]}}}}}} Discount */

/** @param {string[]} args */
function cli(args, interactive = false) {
  const result = spawnSync(
    "npm",
    ["exec", "--yes", "--package=@shopify/cli@4.8.3", "--", "shopify", ...args],
    {
      env: process.env,
      encoding: "utf8",
      stdio: interactive ? "inherit" : "pipe",
    },
  );
  if (result.status !== 0) {
    if (!interactive && result.stderr) process.stderr.write(result.stderr);
    throw new Error(
      "Shopify fixture setup stopped. Complete store authorization and run this command again.",
    );
  }
  return result.stdout ?? "";
}

/** @param {string} query @param {Record<string, unknown>} variables */
function execute(query, variables = {}, mutation = false) {
  const output = cli([
    "store",
    "execute",
    "--store",
    config.shopDomain,
    "--version",
    "2026-07",
    "--json",
    "--query",
    query,
    "--variables",
    JSON.stringify(variables),
    ...(mutation ? ["--allow-mutations"] : []),
  ]);
  const response = /** @type {GraphqlResult} */ (JSON.parse(output));
  // `store execute --json` returns the data object directly in CLI 4.x.
  const data = response.data ?? response;
  if (response.errors?.length || !Object.keys(data).length)
    throw new Error(
      `Shopify fixture query failed: ${response.errors?.map((error) => error.message).join("; ") ?? "missing data"}`,
    );
  for (const payload of Object.values(data)) {
    const errors = /** @type {{userErrors?: {message: string}[]}} */ (payload)
      ?.userErrors;
    if (errors?.length)
      throw new Error(errors.map((error) => error.message).join("; "));
  }
  return data;
}

cli(
  [
    "store",
    "auth",
    "--store",
    config.shopDomain,
    "--scopes",
    "read_products,write_products,read_inventory,read_publications,write_publications,read_discounts,write_discounts",
  ],
  true,
);

const lookup =
  /** @type {{shop: {myshopifyDomain: string}, products: {nodes: Product[]}, publications: {nodes: {id: string, name: string}[]}, codeDiscountNodeByCode: Discount | null}} */ (
    execute(`query E2EFixtureLookup {
  shop { myshopifyDomain }
  products(first: 10, query: "handle:e2e-physical-fixture OR handle:e2e-digital-fixture") {
    nodes { id handle tags variants(first: 2) { nodes { id price inventoryItem { requiresShipping tracked } } } }
  }
  publications(first: 20) { nodes { id name } }
  codeDiscountNodeByCode(code: "E2E10") { id codeDiscount { ... on DiscountCodeBasic {
    title customerGets { value { ... on DiscountPercentage { percentage } }
      items { ... on DiscountProducts { products(first: 2) { nodes { id } } } } }
  } } }
}`)
  );
if (lookup.shop.myshopifyDomain !== config.shopDomain)
  throw new Error("The CLI did not reach the staging store.");
const publication = lookup.publications.nodes.find(
  (item) => item.name === "Online Store",
);
if (!publication)
  throw new Error("The staging Online Store publication was not found.");
const publicationId = publication.id;
if (
  lookup.codeDiscountNodeByCode &&
  lookup.codeDiscountNodeByCode.codeDiscount.title !== discountTitle
)
  throw new Error(
    "E2E10 already belongs to another discount. No existing discount will be changed.",
  );
for (const [kind, key] of [
  ["physical", "E2E_PHYSICAL_VARIANT_ID"],
  ["digital", "E2E_DIGITAL_VARIANT_ID"],
]) {
  const configured = process.env[key]?.trim();
  const existing = lookup.products.nodes.find(
    (item) => item.handle === `e2e-${kind}-fixture`,
  );
  if (
    configured &&
    existing?.variants.nodes[0]?.id !==
      `gid://shopify/ProductVariant/${configured}`
  )
    throw new Error(
      `${key} already selects another fixture. Existing store data and settings will not be changed.`,
    );
}
if (process.env.E2E_DISCOUNT_CODE && process.env.E2E_DISCOUNT_CODE !== "E2E10")
  throw new Error(
    "This setup helper uses E2E10; a different discount is already configured.",
  );

/** @param {"physical" | "digital"} kind */
function product(kind) {
  const physical = kind === "physical";
  const handle = `e2e-${kind}-fixture`;
  let found = lookup.products.nodes.find((item) => item.handle === handle);
  if (!found) {
    const created = /** @type {{productSet: {product: Product | null}}} */ (
      execute(
        `mutation CreateE2EProduct($input: ProductSetInput!) {
      productSet(input: $input, synchronous: true) {
        product { id handle tags variants(first: 2) { nodes { id price inventoryItem { requiresShipping tracked } } } }
        userErrors { field message code }
      }
    }`,
        {
          input: {
            title: `E2E ${physical ? "Physical" : "Digital"} Fixture`,
            handle,
            tags: [marker],
            status: "ACTIVE",
            productOptions: [
              { name: "Title", values: [{ name: "Default Title" }] },
            ],
            variants: [
              {
                optionValues: [{ optionName: "Title", name: "Default Title" }],
                price: physical ? "100.00" : "40.00",
                taxable: false,
                inventoryItem: { requiresShipping: physical, tracked: false },
              },
            ],
          },
        },
        true,
      )
    );
    found = created.productSet.product ?? undefined;
  }
  if (
    !found ||
    !found.tags.includes(marker) ||
    found.variants.nodes.length !== 1
  )
    throw new Error(
      `The ${kind} fixture is missing or is not owned by this setup helper.`,
    );
  const variant = found.variants.nodes[0];
  if (
    Number(variant.price) !== (physical ? 100 : 40) ||
    variant.inventoryItem.requiresShipping !== physical ||
    variant.inventoryItem.tracked
  )
    throw new Error(
      `The ${kind} fixture's price or shipping/inventory settings changed. Review it in Admin; the helper will not overwrite it.`,
    );
  execute(
    `mutation PublishE2EProduct($id: ID!, $publicationId: ID!) {
    publishablePublish(id: $id, input: [{publicationId: $publicationId}]) { userErrors { field message } }
  }`,
    { id: found.id, publicationId },
    true,
  );
  return {
    productId: found.id,
    variantId: variant.id.replace("gid://shopify/ProductVariant/", ""),
  };
}

const physical = product("physical");
const digital = product("digital");
if (lookup.codeDiscountNodeByCode) {
  const gets = lookup.codeDiscountNodeByCode.codeDiscount.customerGets;
  const items = gets?.items.products?.nodes;
  if (
    gets?.value.percentage !== 0.1 ||
    items?.length !== 1 ||
    items[0].id !== physical.productId
  )
    throw new Error(
      "The existing fixture discount changed. Review E2E10 in Admin; the helper will not overwrite it.",
    );
} else {
  execute(
    `mutation CreateE2EDiscount($physicalProductId: ID!, $startsAt: DateTime!) {
    discountCodeBasicCreate(basicCodeDiscount: {
      title: "E2E physical fixture 10%", code: "E2E10", context: {all: ALL},
      startsAt: $startsAt, appliesOncePerCustomer: false,
      customerGets: {value: {percentage: 0.1}, items: {products: {productsToAdd: [$physicalProductId]}}, appliesOnOneTimePurchase: true, appliesOnSubscription: false}
    }) { codeDiscountNode { id } userErrors { field message code } }
  }`,
    {
      physicalProductId: physical.productId,
      startsAt: new Date().toISOString(),
    },
    true,
  );
}

const envFile = new URL("../.env.e2e", import.meta.url);
let environment = readFileSync(envFile, "utf8");
for (const [key, value] of Object.entries({
  E2E_PHYSICAL_VARIANT_ID: physical.variantId,
  E2E_DIGITAL_VARIANT_ID: digital.variantId,
  E2E_DISCOUNT_CODE: "E2E10",
})) {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const existing = environment
    .match(pattern)?.[0]
    .slice(key.length + 1)
    .trim();
  if (existing && existing !== value)
    throw new Error(
      `${key} is already configured differently. The local file was not overwritten.`,
    );
  environment = pattern.test(environment)
    ? environment.replace(pattern, `${key}=${value}`)
    : `${environment}\n${key}=${value}\n`;
}
writeFileSync(envFile, environment, { mode: 0o600 });
chmodSync(envFile, 0o600);
console.log(
  "Staging fixtures verified and their variant IDs saved in .env.e2e. Run npm run test:e2e:auth, then npm run test:e2e:headed.",
);
