# Shipping protection Shopify app

This repository contains an embedded Shopify app built with React Router. Its
checkout block offers optional shipping protection, a Cart Transform sets the
protection line price, and the backend records paid protection from Shopify order
data. Merchants can configure the offer and view order and revenue analytics.
Claims and automated resolutions are planned, but are not part of the current app.

## Local setup

Use Node.js `>=20.19 <22` or `>=22.12` and npm. The Shopify CLI is pinned as a
development dependency; use it through `npm run` or `npx shopify`.

```shell
npm ci
npx supabase login
npx supabase link --project-ref zpbrsewsozlpmxysecyw
cp -n .env.example .env
```

The default `shopify.app.toml` contains a local app ID placeholder. Create a
dedicated local Shopify app, replace that ID, and use its credentials in the
local environment. Do not use the production app ID or database for local work.
Copy `shopify.app.staging.toml.example` to `shopify.app.staging.toml` after
creating a separate staging app. Production uses
`shopify.app.production.toml`. Each environment needs its own Shopify app,
Railway environment, secrets, Sentry project, and PostgreSQL database. The
production client ID in this repository is public configuration, not a secret.

The app uses Prisma with Supabase PostgreSQL. In Supabase **Connect**, copy the
Session pooler URL (port 5432) into `DATABASE_URL` in the ignored `.env` file.
Replace the password placeholder, percent-encode special characters in the
password, and include `schema=public` and `sslmode=require` in the URL. The
Supabase CLI link does not set `DATABASE_URL` for Prisma. The app stores Shopify
access tokens in its database, so disable **Integrations → Data API** for this
project in the Supabase dashboard.

Then run:

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
Orders are recognised as protected only by the variant on one of the shop's
pricing rules, so a legacy Shopify metafield without a database rule, or a rule
left on a replaced product, fails the "Pricing is linked to the current
protection product" check until **Repair setup** publishes a rule for it.

The app checks the shop's Shopify Plus plan and Cart Transform `updateOperation`
eligibility before setup. The only implemented strategy is
`CHECKOUT_UI_CART_TRANSFORM`; `THEME_CART` is reserved and resolves as
unavailable. Backend health checks cannot confirm that a merchant placed the
checkout block. The merchant must add the block in Checkout Editor, activate
Shop Pay separately if used, and place a test order. Shopify documents the
[checkout UI plan requirement](https://shopify.dev/docs/api/checkout-ui-extensions/latest)
and [Cart Transform price-update restrictions](https://shopify.dev/docs/api/functions/latest/cart-transform).

The backend is configured for public app distribution. The current release is
limited to a Plus-capable test store; unrelated merchant installs need review
and a release plan because
[Shopify distribution methods cannot be changed after selection](https://shopify.dev/docs/apps/launch/distribution/select-distribution-method).

Shopify orders, refunds, and webhook data are the source of truth for paid
protection and revenue. The checkout selection alone is not a purchase record.
The app's webhook routes are declared in `shopify.app.toml`; order
reconciliation can fill gaps after missed or delayed deliveries.

The confirmed `ProtectionPurchase` row is the durable paid record. It freezes
the first verified payment time, fee, protection line IDs, covered merchandise,
order value, and any observed rule snapshot. Unpaid rows remain provisional and can change with order edits. The
paid fields on `Order` are synchronized caches; analytics and refund attribution
read the confirmed purchase. Historical purchases recovered from paid order
snapshots have unknown eligible subtotal, covered merchandise, order value, and pricing provenance left null. Claim
and claim event tables are present for later work; there is no claim intake or
resolution endpoint yet. Versioned coverage terms and checkout provenance are
needed before automated claim decisions.

The database prevents updates and ordinary deletion of confirmed purchases,
and only allows claims against confirmed purchases. Claim events are append-only.
Shop data redaction removes these records in dependency order inside one
transaction.

Verified order and refund webhooks write a minimal PostgreSQL inbox row and
return after that write. The worker runs `WORKER_CONCURRENCY` delivery loops;
each claims every queued delivery for one order, fetches the latest order once
through Admin GraphQL, applies it with the delivery completion in one
transaction, retries with a lease and bounded backoff, and reports terminal
failures. The inbox stores no raw webhook payload or customer information. Run
one worker service: its loops share an in-process Admin API budget per shop.

Reconciliation runs only in the worker. It backfills 60 days on install, then
rechecks each shop about every 10 minutes, fetching only orders that are
missing locally or newer in Shopify. `reconciliation_completed` logs show
orders listed, fetched, and skipped, and `shopify_graphql_cost` logs show each
Admin API call's query cost.

## Merchant analytics

The Overview shows the last 30 merchant-local calendar days from stored data;
**Refresh** re-reads it and never calls Shopify for orders. Until the initial
backfill completes it says order history is still syncing, and it warns that
order sync is behind when the last completed sync is over an hour old. Single
orders that fail to store alert the operator through Sentry instead. Protected and eligible orders are dated by
the first completed payment. Protection refunds are recorded once per Shopify
refund ID and dated by successful refund transactions.

Test orders are excluded unless **Include test orders (preview only)** is
selected. Totals use the current shop currency. Protected GMV is discounted,
shippable paid merchandise, excluding protection, shipping, and tax. Average
protection fee is gross confirmed fees divided by protected orders. Attach rate
is an order-based estimate because checkout exposure is unknown. The page flags pending or
unattributable refunds, unresolved payment dates, and records in another
currency as data quality notices.
The page also warns when the requested range extends beyond the verified scan
or when historical protected orders lack a paid merchandise snapshot.

## Checks and deployment

```shell
npm test
npm run lint
npm run typecheck
npm run build
npm run verify:postgres
```

`typecheck` generates React Router and Cart Transform types before checking the
app and both extensions. GitHub Actions runs these checks and the PostgreSQL
verification against an isolated test database.

The [staging browser test guide](e2e/README.md) explains the Playwright suite,
test-store fixtures, read-only database login, and first sign-in. Run
`npm run test:e2e:headed` locally after setup. CI lists the browser tests and
type-checks them; live Shopify journeys currently run locally.

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

Staging and production need two Railway services from the repository root:
the public web service and a private worker service. The checkout UI and Cart
Transform are Shopify extensions, deployed through Shopify CLI separately.

The isolated **load** environment needs an additional `shopify-mock` Railway
service. Follow the [load-testing setup](scripts/load/README.md) for its three
services, deployment branch, commands, and complete per-service variable blocks.

1. Push the app to a GitHub repository. Confirm `.env` is untracked and contains
   no committed secrets. The root `Dockerfile` installs build dependencies,
   generates Prisma Client, and builds the web app. `.dockerignore` keeps local
   credentials out of the image.
2. In Railway, create a web service from that GitHub repository. Open the **service
   tile**, then **Settings**. Connect the repository under **Service Source** if
   needed. Leave **Root Directory** blank or set it to `/`; it is a separate
   setting from Service Source. Generate a domain under **Public Networking**.
   If asked for a target port before the first deployment, enter `3000` (the
   port exposed by the Dockerfile). Use the domain's `https://` URL as the app
   origin. If Railway already created services
   from the two extension directories, confirm their root directories and
   retire them after the root service is working.
3. In the web service's **Variables** tab, set the real values below. Give the
   worker the same environment's application secrets and database URL. The
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
   | `NODE_ENV` | `production` |
   | `PORT` | `3000`, matching the manually selected domain target port |
   | `APP_ENV` | `staging` or `production` |
   | `SENTRY_DSN` | Environment-specific server error-monitoring DSN; optional locally. Prod and staging share one Sentry project (split by `APP_ENV`); a load-test environment must use its own project or none, so it cannot use up production's event quota |
| `SENTRY_WORKER_MONITOR` | Worker only, optional: slug of a Sentry Cron monitor. The worker checks in about once a minute while all its loops are running, and Sentry alerts when check-ins stop. Needs `SENTRY_DSN` |
   | `WORKER_CONCURRENCY` | Worker only, optional: parallel webhook delivery loops, 1 to 16 (default 4) |

   Set `&connection_limit=` on `DATABASE_URL` for **both** services. Without
   it, Prisma sizes its pool from the machine's CPU count, and one service can
   exhaust the Supabase session pooler on its own (`EMAXCONNSESSION ... max
   clients are limited to pool_size`). Each worker delivery loop can hold a
   connection while it stores an order, and reconciliation uses one more, so
   give the worker at least `WORKER_CONCURRENCY + 2`. During a deploy the old
   and new containers overlap, so keep **twice** the web and worker limits
   combined within the pooler's pool size (**Database → Settings**). With a
   pool size of 15: web `3`, worker `4` with `WORKER_CONCURRENCY=2` (7 normally,
   14 during a deploy). Raise the pool size before raising these limits.
   Copy the pooler URL from Supabase **Connect** and URL-encode any special
   characters in its password. Prisma connects to Supabase PostgreSQL directly;
   the browser and checkout extension need no Supabase key or database URL.
   Configure Sentry alerts for `webhook_terminal` and
   `protection_price_unmatched`, and route them to the release operator.
   `protection_price_unmatched` means a paid order wasn't charged the live
   protection price, usually because the Cart Transform failed and the line was
   charged $0.00. Alert on a burst (for example 3 or more in an hour): a failed
   Function deploy or configuration affects every cart until it is rolled back. Logs and Sentry events contain only safe IDs, operation names,
   error classes, and timings; they exclude raw webhooks and customer data.
4. Set the web service's **Pre-Deploy Command** to `npx prisma migrate deploy`,
   start command to `npm run start`, and health check path to `/healthz`. Create
   a private worker service from the same image with start command
   `npm run worker`. Start it only after migrations and the web health check
   pass. Keep the worker service without a public domain.

   If a previous deploy of migration
   `20260930000000_webhook_inbox_paid_metrics` failed with PostgreSQL `55P04`
   (`unsafe use of new value "PENDING"`), pause Railway automatic deployment and
   back up the affected database. Run `npx prisma migrate status` against that
   environment's `DATABASE_URL`. If it reports that migration as failed, run
   this once against the same database:

   ```sh
   npx prisma migrate resolve --rolled-back 20260930000000_webhook_inbox_paid_metrics
   ```

   Push the commit that splits the enum addition from its first use, then
   redeploy with the normal `npx prisma migrate deploy` pre-deploy command.
   The migration was made safe to retry if its earlier attempt applied some
   statements before failing. Do not run `prisma migrate reset` on a hosted
   database. Prisma's [failed migration recovery guide](https://www.prisma.io/docs/orm/v6/prisma-migrate/workflows/patching-and-hotfixing)
   explains the `resolve --rolled-back` step.
5. Connect both staging services to `main` and both production services to
   `production` (see [Release to production](#release-to-production)). Require
   the GitHub `CI / verify` check to pass before Railway automatic deployment
   in both environments. Back up PostgreSQL before each
   production migration and verify that the backup can be restored. Use separate
   databases for staging and production.
6. The `shopify.app.production.toml` config points at the Railway HTTPS origin
   and its `/auth/callback` route. From a local terminal in the repository root,
   validate it with `shopify app config validate --json --config production`,
   then publish the configuration and both extensions with
   `npx shopify app deploy --config production` only after the matching backend
   passes smoke checks. Shopify app versions do not deploy the hosted web app.
7. In Shopify's Dev Dashboard, open the app's **Distribution** card and choose
   **Public** for this multi-merchant app. Shopify does not let you change the
   distribution method later. The backend uses `AppDistribution.AppStore` to
   match this choice. A custom-distribution app is limited to one store or one
   Plus organization.
8. Open the Railway HTTPS URL and install the app on a Plus-capable development store.
   Confirm the embedded Admin pages load, add the checkout block in Shopify's
   Checkout Editor, and place a paid protection test order. Check Railway logs
   for webhook errors and confirm exactly one protection purchase is recorded
   in Supabase. The checkout extension currently uses Shopify checkout APIs and
   a shop metafield; it makes no direct HTTP request to Supabase or the backend.

For the test-store release, exercise opt-in and removal, paid orders, unpaid
cancellations, partial and full merchandise refunds, protection-fee refunds,
duplicate deliveries, failed processing and recovery, uninstall and reinstall,
and merchant-local date filters. Verify `/healthz`, worker completion, Shopify
delivery logs, Sentry alerts, and reconciliation. Keep real customer charges
disabled until approved protection terms and a defined claims process exist.
`npm audit --omit=dev` currently reports four high advisories, all from
`deepmerge-ts` under `prisma` → `@prisma/config` (assessed 2026-10-01). That
code runs only in the Prisma CLI while it loads this repository's own
configuration (for example `prisma migrate deploy`); the Prisma client the app
runs does not include it, and no request input reaches it. npm's suggested fix
is a Prisma downgrade, so leave it until Prisma ships a patched release.

**To do (no custom domain yet):** once the app has its production domain, create
a Sentry Uptime monitor on `https://<domain>/healthz` that alerts the operator on
any non-200 response, and confirm it fires against a stopped staging web service.
Railway's health check only gates deploys and restarts, so until this exists a
web outage after deploy goes unnoticed. Set `SENTRY_WORKER_MONITOR` on the worker
service too, so a dead worker also alerts. See the runbook's
[monitoring to-do](docs/production-readiness.md).

Railway's [service settings](https://docs.railway.com/services),
[public networking](https://docs.railway.com/networking/public-networking), and
[pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command)
document the host-side steps. Shopify's
[deployment guide](https://shopify.dev/docs/apps/launch/deployment/deploy-to-hosting-service)
explains the separate app configuration deployment.

### Release to staging
1. Push to main for backend updates
2. To deploy shopify extension or app updates use 
   ```sh
   npx shopify app deploy --config staging
   ```

### Release to production

Work on `main`. Every push to `main` deploys to staging. Production deploys
only when the `production` branch moves, and it only ever fast-forwards to a
commit that has already run on staging.

1. Push to `main` and wait for `CI / verify` to pass and the staging deploy to
   finish. Check the staging deploy log to confirm `prisma migrate deploy`
   succeeded.
2. If the change touches extensions or app configuration, run
   `npx shopify app deploy --config staging`.
3. Test on the staging store.
4. Push the tested commit to production:

   ```sh
   git fetch origin
   git push origin <tested-sha>:production
   ```

   Use the commit hash shown on the staging deployment in Railway.
   `git push origin main:production` is fine when `main` has not moved since
   you tested. Git rejects the push if it is not a fast-forward; never add
   `--force`. Back up the production database first if the release includes a
   migration.
5. Wait for the production deploy and check `/healthz` and the logs.
6. If the change touches extensions or app configuration, deploy them from the
   released commit:

   ```sh
   git checkout production && git pull
   npx shopify app deploy --config production
   git checkout main
   ```

Fix production problems on `main` and release them the same way. Do not commit
directly to `production`.

In GitHub, protect `production` under **Settings → Branches**: require the
`verify` status check, require linear history, disallow force pushes and
deletion, and do not allow bypassing. Do not require pull requests, because
releases are direct fast-forward pushes.
