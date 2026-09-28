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

The confirmed `ProtectionPurchase` row is the durable paid record. It freezes
the first verified payment time, fee, protection line IDs, and any observed rule
snapshot. Unpaid rows remain provisional and can change with order edits. The
paid fields on `Order` are synchronized caches; analytics and refund attribution
read the confirmed purchase. Historical purchases recovered from paid order
snapshots have unknown eligible subtotal and pricing provenance left null. Claim
and claim event tables are present for later work; there is no claim intake or
resolution endpoint yet. Versioned coverage terms and checkout provenance are
needed before automated claim decisions.

The database prevents updates and ordinary deletion of confirmed purchases,
and only allows claims against confirmed purchases. Claim events are append-only.
Shop data redaction removes these records in dependency order inside one
transaction.

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
preferences.

### Coordinated durable-protection migration

This release changes database constraints and the application code together.
Back up the PostgreSQL database and verify the backup, pause incoming app and
webhook traffic, then run `npx prisma migrate deploy` from the matching release.
The migration stops on cross-shop links, invalid refund states, or inconsistent
paid-order snapshots; repair those records against Shopify and retry rather than
reassigning them. Deploy the matching backend and checkout extension, resume
traffic, and run order reconciliation before relying on analytics. Verify the
Supabase **Data API** is disabled in the project dashboard; local
`supabase/config.toml` also has `[api] enabled = false`. Prisma owns these tables
and accesses PostgreSQL from the backend only. See the [Prisma 6 migration
workflow](https://www.prisma.io/docs/orm/v6/prisma-migrate/workflows/development-and-production)
and [Supabase Prisma guide](https://supabase.com/docs/guides/database/prisma).

### Deploy the backend on Railway

Railway needs **one service from the repository root**. Its public HTTPS domain
serves the embedded Admin app, authentication, and webhook routes. The
`insurance-ext` checkout UI and `shipping-protection-transform` Cart Transform
are Shopify extensions, not Railway services or background workers. Railway may
offer to create services for these npm workspaces; use the root app instead.

1. Push the app to a GitHub repository. Confirm `.env` is untracked and contains
   no committed secrets. The root `Dockerfile` installs build dependencies,
   generates Prisma Client, and builds the web app. `.dockerignore` keeps local
   credentials out of the image.
2. In Railway, create a service from that GitHub repository. Open the **service
   tile**, then **Settings**. Connect the repository under **Service Source** if
   needed. Leave **Root Directory** blank or set it to `/`; it is a separate
   setting from Service Source. Generate a domain under **Public Networking**.
   If asked for a target port before the first deployment, enter `3000` (the
   port exposed by the Dockerfile). Use the domain's `https://` URL as the app
   origin. If Railway already created services
   from the two extension directories, confirm their root directories and
   retire them after the root service is working.
3. In the root service's **Variables** tab, set the real values below. The
   placeholders in `.env.example` do not configure Railway. When you set the
   domain target port manually to `3000`, also set `PORT=3000` here so the app
   listens on the same internal port.

   | Variable | Value |
   | --- | --- |
   | `SHOPIFY_APP_URL` | Railway HTTPS origin, without a trailing slash |
   | `SHOPIFY_API_KEY` | Client ID for the linked Shopify app |
   | `SHOPIFY_API_SECRET` | Client secret for that app |
   | `SCOPES` | Same comma-separated scopes as `shopify.app.toml` |
   | `DATABASE_URL` | Supabase Session pooler URL, port 5432, with `schema=public&sslmode=require` |
   | `CHECKOUT_TOKEN_HASH_SECRET` | Dedicated random secret of at least 16 characters |
   | `NODE_ENV` | `production` |
   | `PORT` | `3000`, matching the manually selected domain target port |

   Copy the pooler URL from Supabase **Connect** and URL-encode any special
   characters in its password. Prisma connects to Supabase PostgreSQL directly;
   the browser and checkout extension need no Supabase key or database URL.
4. Set Railway's **Pre-Deploy Command** to `npx prisma migrate deploy`. Leave the
   start command at the Dockerfile default, `npm run start`. This applies
   migrations before a new deployment starts rather than on every restart.
5. The `shopify.app.production.toml` config points at the Railway HTTPS origin
   and its `/auth/callback` route. From a local terminal in the repository root,
   validate it with `shopify app config validate --json --config production`,
   then publish the configuration and both extensions with
   `shopify app deploy --config production`. Shopify CLI is not installed in the
   Railway container and does not host the backend.
6. In Shopify's Dev Dashboard, open the app's **Distribution** card and choose
   **Public** for this multi-merchant app. Shopify does not let you change the
   distribution method later. The backend uses `AppDistribution.AppStore` to
   match this choice. A custom-distribution app is limited to one store or one
   Plus organization.
7. Open the Railway HTTPS URL and install the app on a development store.
   Confirm the embedded Admin pages load, add the checkout block in Shopify's
   Checkout Editor, and place a paid protection test order. Check Railway logs
   for webhook errors and confirm exactly one protection purchase is recorded
   in Supabase. The checkout extension currently uses Shopify checkout APIs and
   a shop metafield; it makes no direct HTTP request to Supabase or the backend.

Railway's [service settings](https://docs.railway.com/services),
[public networking](https://docs.railway.com/networking/public-networking), and
[pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command)
document the host-side steps. Shopify's
[deployment guide](https://shopify.dev/docs/apps/launch/deployment/deploy-to-hosting-service)
explains the separate app configuration deployment.
