# Shipping protection Shopify app

This repository contains an embedded Shopify app built with React Router. Its
checkout block offers optional shipping protection, a Cart Transform sets the
protection line price, and the backend records paid protection from Shopify order
data. Merchants can configure the offer and view order and revenue analytics.
Claims and automated resolutions are planned, but are not part of the current app.

## Local setup

Use Node.js `>=20.19 <22` or `>=22.12`, npm, and the Shopify CLI. npm is the
package manager for this repository.

```shell
npm ci
npx supabase login
npx supabase link --project-ref zpbrsewsozlpmxysecyw
cp -n .env.example .env
```

The app uses Prisma with Supabase PostgreSQL. In Supabase **Connect**, copy the
Session pooler URL (port 5432) into `DATABASE_URL` in the ignored `.env` file.
Replace the password placeholder, percent-encode special characters in the
password, and include `schema=public` and `sslmode=require` in the URL. The
Supabase CLI link does not set `DATABASE_URL` for Prisma. The app stores Shopify
access tokens in its database, so disable **Integrations → Data API** for this
project in the Supabase dashboard.

Set `CHECKOUT_TOKEN_HASH_SECRET` to a dedicated random secret. The backend uses
it to hash checkout tokens before storing their hashes. Then run:

```shell
npm run setup
npx prisma migrate status
npm run verify:postgres
npm run dev
```

`npm run setup` generates the Prisma client and applies migrations from
`prisma/migrations`. `npm run verify:postgres` checks order ingestion, refunds,
reconciliation, and tenant isolation in a rolled-back transaction. The
Supabase CLI manages the project; Prisma owns the app tables. The old local
PostgreSQL Compose file remains available as a development alternative.

## Checkout offer

The merchant setup flow on the app home page configures the protection product,
pricing rule, shop metafield, and Cart Transform. The checkout block reads that
configuration and uses explicit customer opt-in. See the [checkout extension
README](extensions/insurance-ext/README.md) for eligibility and activation
steps. After deploying the app version, add the block to the order summary in
the Checkout Editor and save it. Shop Pay activation is separate.

Each shop has a `ShopConfiguration` row. New shops default to protection off,
attachment strategy `NONE`, and all returns, claim-intake, and auto-approval
flags off. Successful setup enables the shop metafield and Cart Transform
pricing used by the checkout block, with the existing loss, theft, and damage
offer. Historical rates stay on pricing rules and protection purchases.
Existing shops with an active pricing rule are backfilled during migration.
A healthy legacy Shopify metafield without a database rule is adopted during
the next setup read.

The app checks the shop's Shopify Plus plan and Cart Transform `updateOperation`
eligibility before setup. The only implemented strategy is
`CHECKOUT_UI_CART_TRANSFORM`; `THEME_CART` is reserved and resolves as
unavailable. Backend health checks cannot confirm that a merchant placed the
checkout block. The merchant must add the block in Checkout Editor, activate
Shop Pay separately if used, and place a test order. Shopify documents the
[checkout UI plan requirement](https://shopify.dev/docs/api/checkout-ui-extensions/latest)
and [Cart Transform price-update restrictions](https://shopify.dev/docs/api/functions/latest/cart-transform).

The current app uses single-merchant distribution. This refactor prepares
shop-scoped data and configuration in one backend and database; unrelated
merchants would need a separately planned public-distribution app because
[Shopify distribution methods cannot be changed after selection](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method).

Shopify orders, refunds, and webhook data are the source of truth for paid
protection and revenue. The checkout selection alone is not a purchase record.
The app's webhook routes are declared in `shopify.app.toml`; order
reconciliation can fill gaps after missed or delayed deliveries.

## Merchant analytics

The embedded Analytics page opens to the last 30 merchant-local calendar days.
It scans available Shopify orders in resumable batches; use **Continue sync**
until the initial scan completes. Protected and eligible orders are dated by
the first completed payment. Protection refunds are recorded once per Shopify
refund ID and dated by successful refund transactions.

Test orders are excluded unless **Include test orders (preview only)** is
selected. Totals use the current shop currency. The page flags pending or
unattributable refunds, unresolved payment dates, and records in another
currency as data quality notices.

## Checks and deployment

```shell
npm test
npm run lint
npm run typecheck
npm run build
```

`typecheck` generates React Router and Cart Transform types before checking the
app and both extensions; it needs the Shopify CLI to access its local
preferences. The Dockerfile uses `npm ci` and builds the web app. Configure the
host's Shopify app variables, `DATABASE_URL`, and
`CHECKOUT_TOKEN_HASH_SECRET`; apply migrations with `npm run setup` before
starting the server with `npm run start`. Deploy Shopify app configuration and
extensions through the Shopify CLI as a separate step.
