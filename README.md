# Shipping protection Shopify app

An embedded Shopify app built with React Router. Its checkout block offers
optional shipping protection, a Cart Transform sets the protection line price,
and the backend records paid protection from Shopify order data. Merchants
configure the offer and view order and revenue analytics. Claims and automated
resolutions are planned but not built.

Detailed design notes live in [`docs/agents`](docs/agents/README.md); release
evidence and recovery procedures live in the
[production readiness runbook](docs/production-readiness.md).

## Local setup

Use Node.js `>=20.19 <22` or `>=22.12`. The Shopify CLI is a dev dependency; run
it through `npx shopify` or `npm run`.

```shell
npm ci
cp -n .env.example .env
```

`shopify.app.toml` holds a local app ID placeholder: create a dedicated local
Shopify app and use its ID and credentials. For staging, copy
`shopify.app.staging.toml.example` to `shopify.app.staging.toml`. Production
uses `shopify.app.production.toml`. Each environment has its own Shopify app,
Railway environment, secrets, and database; never use production for local work.

Set `DATABASE_URL` in `.env` to the Supabase **Connect** → Session pooler URL
(port 5432) with a percent-encoded password and
`schema=public&sslmode=require`. Keep **Integrations → Data API** disabled in
the Supabase dashboard, because the database holds Shopify access tokens.
`compose.yaml` runs a local PostgreSQL as an alternative.

```shell
npm run setup            # prisma generate + migrate deploy
npx prisma migrate status
npm run verify:postgres
npm run dev
```

## Checkout offer

The setup flow on the app home page configures the protection product, pricing
rule, shop metafield, and Cart Transform. It first checks for a Shopify Plus
plan and Cart Transform `updateOperation` eligibility. The only implemented
attachment strategy is `CHECKOUT_UI_CART_TRANSFORM`.

After deploying an app version, open **Settings → Checkout → Configure → Edit**,
add the Shipping Protection block, and save. Place it under **Shipping method**;
it offers protection before an address is entered. Shop Pay
activation is separate. The backend cannot confirm
the block was placed, so place a test order. See the [checkout extension
README](extensions/insurance-ext/README.md) for eligibility and activation.

New shops get a `ShopConfiguration` row with protection off and every returns,
claim-intake, and auto-approval flag off. Orders count as protected only by the
variant on one of the shop's pricing rules. A legacy metafield without a rule,
or a rule left on a replaced product, fails the "Pricing is linked to the
current protection product" check until **Update protection setup** is run.

## Checkout offer settings

Settings groups pricing and customer-facing text in one **Checkout offer** block.
Checkout requires customers to choose protection themselves. Blank copy fields
restore the translated defaults; custom plain text applies to every checkout
language. The fee and store disclosure remain visible. Copy names shipping
protection and may describe only the current theft-after-delivery benefit.

Lock or allow each editor separately for an installed store from an operator
shell with database access:

```shell
npm run merchant:checkout-editing -- store.myshopify.com pricing locked
npm run merchant:checkout-editing -- store.myshopify.com copy locked
```

Use `locked` or `editable` for either setting. Both permissions default on. Permission changes
preserve the store's saved offer and rate, and merchant requests cannot change
the permissions. See [release notes](docs/production-readiness.md#checkout-offer-settings-2026-10-07)
for the required migration and Shopify extension deployment.

The existing pricing-only command remains available:

```shell
npm run merchant:rate-editing -- store.myshopify.com locked
npm run merchant:rate-editing -- store.myshopify.com editable
```

To set a managed rate: make it editable, save the rate in Settings, then lock it.

## Orders and webhooks

Shopify orders, refunds, and webhooks are the source of truth; the checkout
selection is not a purchase record. A confirmed `ProtectionPurchase` row is the
durable paid record. The database blocks updates and ordinary deletes on it, and
claims can attach only to confirmed purchases. Claim tables exist, but there is
no intake or resolution endpoint yet.

Verified order and refund webhooks write a minimal inbox row (no raw payload or
customer data) and return. The worker runs `WORKER_CONCURRENCY` loops. Each
claims all queued deliveries for one order, fetches the order once through
Admin GraphQL, and applies it with the delivery completion in one transaction,
retrying with a lease and bounded backoff. Run exactly one worker service: its
loops share an in-process Admin API budget per shop.

Reconciliation runs only in the worker: a 60-day backfill on install, then a
check about every 10 minutes for orders missing locally or newer in Shopify.
Watch the `reconciliation_completed` and `shopify_graphql_cost` logs.

The worker also deletes order records placed more than 24 months ago, with
their purchases, refunds, claims, and webhook deliveries: on start, then daily.
This is the privacy policy's retention ceiling, and ingestion never stores an
order already past it. Watch `retention_purge_completed`. A backlog runs in
one-minute turns between reconciliation passes (`retention_purge_paused`);
`retention_purge_failed` retries after an hour.

## Merchant analytics

The Overview shows the last 30 merchant-local days from stored data; **Refresh**
never calls Shopify for orders. It says history is syncing until the backfill
completes, and warns when the last sync is over an hour old. Test orders are
excluded unless **Include test orders (preview only)** is selected. Metric
definitions are in [analytics and payouts](docs/agents/analytics-payouts.md).

## Checks

```shell
npm test
npm run lint
npm run typecheck
npm run build
npm run verify:postgres
npm run verify:webhook-postgres
```

`typecheck` generates React Router and Cart Transform types, then checks the
app, both extensions, and the E2E project. CI runs all of these plus
`npm run test:e2e:list` against an isolated PostgreSQL database.

The live Playwright suite runs locally with `npm run test:e2e:headed`; see the
[staging browser test guide](e2e/README.md).

## Deploy the backend on Railway

Each environment has two Railway services built from the repository root with
the root `Dockerfile`: a public web service and a private worker. Extensions
deploy separately through Shopify CLI. The load environment also needs a
`shopify-mock` service; see the [load-testing setup](scripts/load/README.md).

1. Create the web service from the GitHub repository with **Root Directory**
   blank or `/`. Generate a domain under **Public Networking**, with target port
   `3000`, and use its `https://` URL as the app origin.
2. Set these variables on the web service. Give the worker the same secrets and
   database URL.

   | Variable | Value |
   | --- | --- |
   | `SHOPIFY_APP_URL` | Railway HTTPS origin, no trailing slash |
   | `SHOPIFY_API_KEY` | Client ID for the environment's Shopify app |
   | `SHOPIFY_API_SECRET` | Client secret for that app |
   | `SCOPES` | Same comma-separated scopes as the app TOML |
   | `DATABASE_URL` | Session pooler URL with `schema=public&sslmode=require&connection_limit=N` |
   | `NODE_ENV` | `production` |
   | `PORT` | `3000` |
   | `APP_ENV` | `staging` or `production` |
   | `SENTRY_DSN` | Shared by staging and production, split by `APP_ENV`. A load environment uses its own project or none, so it can't use up production's quota |
   | `SENTRY_WORKER_MONITOR` | Worker only, optional: Sentry Cron monitor slug. The worker checks in about once a minute while all loops run |
   | `WORKER_CONCURRENCY` | Worker only, optional: delivery loops, 1–16 (default 4) |

   Set `connection_limit` on **both** services, or Prisma sizes its pool from
   the CPU count and one service can exhaust the pooler (`EMAXCONNSESSION`).
   The worker needs at least `WORKER_CONCURRENCY + 2`. Old and new containers
   overlap during a deploy, so keep twice the combined limits within the
   pooler's pool size (**Database → Settings**). With a pool size of 15: web
   `3`, worker `4` with `WORKER_CONCURRENCY=2` (7 normally, 14 during a deploy).

   Send Sentry alerts for `webhook_terminal` and `protection_price_unmatched` to
   the operator. A burst of `protection_price_unmatched` (say 3 or more in an
   hour) usually means the Cart Transform failed and protection is being charged
   $0.00 on every cart.
3. On the web service, set **Pre-Deploy Command** to `npx prisma migrate deploy`,
   start command to `npm run start`, and health check path to `/healthz`. Create
   the worker from the same image with start command `npm run worker` and no
   public domain. Start it only after migrations and the web health check pass.
4. Connect both staging services to `main` and both production services to
   `production`, and require the GitHub `CI / verify` check before automatic
   deployment.
5. Validate and deploy the Shopify configuration and extensions only after the
   matching backend passes smoke checks; app versions don't deploy the web app:

   ```sh
   npx shopify app config validate --json --config production
   npx shopify app deploy --config production
   ```

6. Install on a Plus-capable development store, add the checkout block, place a
   paid protection test order, and confirm exactly one protection purchase is
   recorded. The full acceptance checklist is section 4 of the
   [readiness runbook](docs/production-readiness.md). Keep real customer charges
   disabled until approved protection terms and a claims process exist.

**To do (no custom domain yet):** once production has its domain, create a
Sentry Uptime monitor on `https://<domain>/healthz` that alerts on any non-200,
and confirm it fires against a stopped staging web service. Railway's health
check only gates deploys, so a web outage goes unnoticed until then. Also set
`SENTRY_WORKER_MONITOR` on the worker.

## Release to production

Every push to `main` deploys to staging. Production deploys only when the
`production` branch fast-forwards to a commit that has already run on staging.

1. Push to `main`, wait for `CI / verify` and the staging deploy, and check the
   deploy log for a successful `prisma migrate deploy`.
2. If extensions or app configuration changed, run
   `npx shopify app deploy --config staging`.
3. Test on the staging store.
4. Back up the production database if the release includes a migration, then
   push the tested commit (the SHA on the Railway staging deployment):

   ```sh
   git fetch origin
   git push origin <tested-sha>:production
   ```

   `main:production` is fine if `main` hasn't moved. Never `--force`.
5. Wait for the production deploy and check `/healthz` and the logs.
6. If extensions or app configuration changed, deploy them from the released
   commit:

   ```sh
   git checkout production && git pull
   npx shopify app deploy --config production
   git checkout main
   ```

Fix production problems on `main` and release them the same way; never commit
to `production` directly. In GitHub branch settings, `production` requires the
`verify` check and linear history, and blocks force pushes, deletion, and
bypassing. It doesn't require pull requests, because releases are direct pushes.

## Draft changelogs

Every push to `main` creates or updates one **Next release** draft in GitHub
Releases, listing non-merge commits since the last published release. It can
also be run manually as **Generate Draft Changelog** in Actions. After a
release passes production checks, rename the draft's `changelog-draft-*` tag to
the version (for example, `v0.1.0`), make final copy edits, and publish.
