# Staging browser tests

Playwright checks the deployed Shopify checkout, embedded merchant app, and
webhook-to-database path together. The existing Vitest and
`@shopify/ui-extensions-tester` tests remain the fast checks for business rules,
Functions, and extension behavior.

The browser suite targets **app-test-kwvgodpl.myshopify.com** and the app in
`shopify.app.staging.toml`. It uses one worker, stops after the first failure,
and disables retries. A full successful run places three test orders, refunds
the first protection fee, and restores the original protection percentage.
Test orders and their financial records remain available for inspection.

## Verification status — 2 October 2026

The complete live suite passed once against the staging store: all 10 tests,
including purchase snapshots, a native protection-fee refund, Overview
financial deltas, and mobile checkout (about 16 minutes). The offline safety
and recovery tests pass with the existing Vitest suite.

A second complete run, to confirm that retained orders and rate history do not
affect the results, is still to be done before production. Each run places
three more test orders and leaves them in the store.

Failures during setup were test-side: Shopify's mobile checkout renders the
order summary twice, Admin's order search can lag a new order, the refund page
does not expose line items as table rows and hides its button text from
`innerText`, and Overview totals are compared in whole cents. If a live check
fails after Shopify changes its markup, inspect the failure trace and update
the shared helpers before changing the assertions' intent.

Keep the failing tests enabled. Do not mark financial coverage as passing,
retry payment automatically, or substitute database writes for native orders.

## First run

From the repository root:

Install Google Chrome for merchant sign-in and Admin steps. Then run:

```sh
npm ci
npx playwright install chromium
cp .env.e2e.example .env.e2e
```

Fill in `.env.e2e` locally. The runner uses only `E2E_*` variables and never
loads the application's `.env` or falls back to `DATABASE_URL`. Keep passwords
and database connection strings in this ignored file.

1. Run `npm run test:e2e:fixtures` to create the staging fixtures, or prepare
   them below and enter their **numeric variant IDs** yourself.
2. Enter the dedicated read-only staging database URL described below.
3. Run `npm run test:e2e:auth`. Sign into Shopify in the browser that opens,
   complete MFA if asked, and open **protection-staging** in the test store.
   You have ten minutes. The script saves the sign-in after verifying the
   staging app's origin and public API key.
4. Run `npm run test:e2e:headed` to watch the tests.
5. Run `npm run test:e2e` again. Run the suite a second time to
   check that retained orders and rate history do not affect the results.
6. Run `npm run test:e2e:report` to open the latest local HTML report.

No GitHub Actions setup is needed for these local runs. GitHub Actions already
checks that the suite loads, passes its safety tests, and type-checks. Running
the live Shopify journeys in GitHub Actions is deferred until authentication
and staging access are suitable for unattended runs.

## Staging prerequisites

The fixture command uses a separate, pinned Shopify CLI 4.8.3 without changing
this repo's application CLI. Complete its authorization page in your normal
browser. It creates two tagged test products with inventory tracking off,
publishes them to the staging Online Store, and creates `E2E10` for the physical
product only. Repeated runs verify and reuse them; they refuse to overwrite
changed or unrelated products, discounts, or local fixture settings. The
command saves the numeric variant IDs in `.env.e2e` and preserves the database
connection. It does not set up payments, shipping rates, or protection.

The test runner never invokes this command automatically.

The staging web service and worker must run the current backend and database
migrations. The staging app's Checkout UI extension and Cart Transform must
be deployed, protection must be active, and the merchant must have placed the
protection block in the published checkout. These tests exercise deployed
code; editing a local extension does not update the live checkout.

Use a Shopify user with permission to open this app, inspect payment settings,
read orders, and refund test orders. Refresh an expired sign-in with
`npm run test:e2e:auth`.

Sign-in uses ordinary Google Chrome with a dedicated profile inside
`e2e/.auth/browser-profile/`, separate from your personal browser profile.
Playwright connects only after Shopify Admin opens. The temporary debugging
endpoint listens only on your computer, but it has no authentication: while
auth or a suite runs, any local process (including another OS user's) can
attach and read the signed-in Shopify session. This is an accepted risk for a
single-user developer machine. Use a Shopify staff account limited to the
staging store, and avoid running these commands on shared hosts.
The suite uses ordinary visible Chrome for merchant and buyer steps because
Shopify verification challenged the automated browser during live setup.
Every buyer starts in a fresh anonymous context with no merchant cookies;
buyers do not use the signed-in profile's default context. The command closes
its windows after it finishes. Avoid running auth or another suite against
this profile concurrently. The normal and headed commands both show Chrome
when this sign-in mode is used; a fully headless run remains unverified.

Prepare these fixtures in the staging store:

| Fixture          | Requirements                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Physical product | One available variant priced at 100.00 in the shop currency; requires shipping; no selling plan                                                          |
| Digital product  | One available variant priced at 40.00; does not require shipping; no selling plan                                                                        |
| Discount         | `E2E10`, or the configured code; 10% off the physical fixture only; exclude the digital and protection products; no customer restrictions or usage limit |
| Delivery         | An available shipping rate for San Francisco, California 94105, United States (the default test address)                                                 |
| Payments         | Shopify's Test payment gateway (formerly Bogus Gateway), or Shopify Payments with test mode enabled                                                      |

Publish both fixture products to the Online Store and ensure they have enough
inventory for repeated runs. Use the store's default currency and a checkout
language of English. Keep other discount experiments out of these fixtures.

Set `E2E_PAYMENT_GATEWAY=bogus` for the Test payment gateway/Bogus Gateway, or
`shopify-payments` for Shopify Payments in test mode. The preflight checks the
payment settings; it does not enable or change gateways. Only documented test
card details are submitted. Each completed order must also be marked as a
test order in Shopify's ingested data.

The staging store currently offers Canada and the United States and uses USD,
so the suite uses the US address. Set `E2E_SHIPPING_COUNTRY=AU` to use Sydney,
NSW 2000 after enabling that destination. The fixtures and checkout must stay
in the shop's default currency for these amount assertions.

Set `E2E_STOREFRONT_PASSWORD` if the storefront is password protected.
`E2E_ADMIN_APP_URL` can be the installed app's base URL copied from Admin, such
as `https://admin.shopify.com/store/app-test-kwvgodpl/apps/<app-handle>`; omit
any trailing `/app/...` path. The sign-in script remembers the URL Shopify
actually uses.

## Read-only staging database login

Create a separate PostgreSQL login in the **staging** Supabase project. Do not
use the application's database owner connection. The suite needs SELECT
access to the tenant, pricing, order, purchase, refund, and webhook records;
it must not read Shopify access tokens from `Session`.

Run this once as the staging database owner, replacing the password:

```sql
CREATE ROLE e2e_reader LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION PASSWORD '<choose-a-new-strong-password>';
GRANT CONNECT ON DATABASE postgres TO e2e_reader;
GRANT USAGE ON SCHEMA public TO e2e_reader;
GRANT SELECT ON TABLE
  public."Shop", public."PricingRule", public."Order",
  public."ProtectionPurchase", public."ProtectionRefund",
  public."WebhookDelivery"
TO e2e_reader;
```

Use that login in `E2E_DATABASE_URL`. Supabase's **session** pooler typically
uses a username of `e2e_reader.<project-reference>`; its direct connection uses
`e2e_reader`. Use the staging project's host and database name, URL-encode the
password, and retain the required SSL settings. Check the connection details
in that project's dashboard. If the database name is not `postgres`, use its
actual name in the CONNECT grant.

The preflight rejects superusers, table write privileges, schema creation,
and SELECT access to `Session`, including inherited privileges. It also
requires the installed staging tenant to exist and waits for that tenant's
pending webhook deliveries to drain. Every subsequent data query is scoped
to that tenant. It never seeds data, migrates the database, writes financial
records, or changes permissions.

## Coverage and useful commands

| File                | Coverage                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `admin.spec.js`     | Overview and Settings render; a saved rate survives refresh; invalid rate does not publish a rule                                                                                                      |
| `checkout.spec.js`  | Default opt-out, one priced protection line, removal, mixed/digital-only carts, pre-discount pricing; desktop and mobile Chromium                                                                      |
| `lifecycle.spec.js` | Paid protected orders at 1% and 2%, historical purchase snapshots, an unprotected control order, webhook ingestion, protection-only refund, Overview deltas, exclusion of test orders from live totals |

```sh
npm run test:e2e:list                 # Lists 10 tests; needs no credentials/browser
npm run typecheck:e2e                # Strict JS/JSDoc checks
npm run test:e2e -- --project=desktop
npm run test:e2e -- --project=mobile-checkout
npm run test:e2e -- admin.spec.js
npm run test:e2e -- checkout.spec.js
npm run test:e2e -- lifecycle.spec.js
```

Every live test uses the same staging preflight, even when run alone. Buyers
have fresh anonymous browser contexts; the merchant uses the separately saved
sign-in. Shopify cart links prepare the fixture carts; cart API reads verify
their prices, shipping flags, discounts, and run markers. Purchases have
unique synthetic emails and cart notes. Webhook and
refund checks poll for at most three minutes and report scoped delivery
statuses when they time out. Avoid editing rates or placing other orders in
the staging store during a run, because the Overview assertions compare
before/after totals.

This suite covers standard checkout in Chromium. Shop Pay, additional markets,
currencies, subscription checkout, and sustained load need separate coverage.
Shopify owns the checkout and Admin markup; if it changes, update the shared
helpers in `support/checkout.js` and `support/merchant.js` after inspecting a
failure trace.

## Recovery and local artifacts

The suite records the original percentage before changing it. Normal teardown
restores it through Settings; that restoration may publish another pricing
rule version. Historical purchases are never rewritten or deleted.

If a run is killed or restoration fails, its journal remains in
`e2e/.auth/rate-restore.json`, and another run refuses to start. Stop the old
process, then run:

```sh
npm run test:e2e:restore
```

The recovery command verifies the staging app and read-only database, restores
the saved percentage through the UI, verifies the active database rate, and
removes the journal only after success. If sign-in expired, run the auth
command first. Do not delete the
journal to skip recovery. If a saved process ID has been reused, stop the
unrelated process only if appropriate; otherwise restore the saved percentage
manually and remove the journal after checking it in Settings.

`e2e/.auth/` holds private browser state and the recovery journal.
`.playwright/` holds the local report, failure screenshots, and traces. Both
are ignored by Git, ESLint, and Docker. Traces can contain authenticated
requests, so keep them private. Sign-in itself is never traced; successful
test traces are discarded. No live artifacts are uploaded by CI.

References: [Playwright authentication](https://playwright.dev/docs/auth),
[Shopify test payments](https://help.shopify.com/en/manual/checkout-settings/test-orders/payments-test-mode),
[Shopify cart API](https://shopify.dev/docs/api/ajax/reference/cart),
[Shopify cart links](https://shopify.dev/docs/apps/build/checkout/create-cart-permalinks),
[Supabase role permissions](https://supabase.com/docs/guides/database/postgres/roles),
[Supabase connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres).
