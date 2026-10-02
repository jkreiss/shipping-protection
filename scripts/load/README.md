# Mock Shopify Admin API

This is the first piece of the isolated load environment: an HTTP mock and an
environment-gated Admin GraphQL transport. It does not provision infrastructure
or run the burst/soak scenarios yet. `npm run load:smoke` seeds one fake merchant,
sends a small signed webhook set, and checks the resulting financial records.

## Railway setup: three services in the load environment

Production and staging use **two** services: web and worker. Load testing needs
**three**: web, worker, and a new `shopify-mock` service that stands in for Shopify's
Admin API. Supabase is the separate PostgreSQL database, not the third Railway
service. If you copied production's two services, keep them and add `shopify-mock`.

Connect all three to this repository's **`load-testing` branch**, use the repository
root and existing root `Dockerfile`, and deploy the same commit to all three.
Set their commands explicitly so worker and mock do not inherit the web default.

| Setting | Load web | Load worker | `shopify-mock` |
| --- | --- | --- | --- |
| Start command | `npm run start` | `npm run worker` | `npm run load:mock` |
| Pre-deploy command | `npx prisma migrate deploy` | `npx prisma migrate deploy` | Empty; remove inherited migration commands |
| Health check path | `/healthz` | Empty; worker has no HTTP server | `/healthz` |
| Public domain | Generate an HTTPS domain targeting port 3000 | None | None |
| Private networking | Available in the load environment | Available in the load environment | Enable/use its private domain on port 4010 |
| Replicas for the first run | 1 | 1 | 1 |

Deploy web and mock first. Start the worker after migrations and both health
checks pass. The mock's `/healthz` returns `{"ok":true}`; worker readiness is
checked through its deployment logs, not an HTTP health check.

### Values to obtain before entering variables

- **Load web URL:** generate the web service's public domain. Use the complete
  `https://...` origin, without a trailing slash, on both web and worker. The
  Shopify SDK requires it at startup even for the worker. It does not need to
  be registered with a real Shopify app for this mock load test.
- **Mock private domain:** copy the mock service's actual private domain from
  Railway networking settings. If it is `shopify-mock.railway.internal` and you
  set `PORT=4010`, the URL is `http://shopify-mock.railway.internal:4010`. Web,
  worker, and mock must be in the same Railway environment. Replace the example
  hostname below if Railway assigns a different private domain.
- **Database URL:** copy the **Session pooler** URL (port 5432) from the isolated
  Supabase project's Connect panel. URL-encode special characters in its password.
  Web and worker use the same project and database with different connection
  limits. Never copy a production database URL into this environment.
- **Mock token:** generate a random load-only token, for example with
  `openssl rand -hex 32`, and set that same value on all three services. This is
  separate from the dummy Shopify secret used to sign future webhooks.

Replace every `<...>` placeholder below before deploying. Enter each variable
in the named Railway service's Variables tab; editing this README does not set
Railway variables. Keep real database passwords and generated tokens out of Git.

### Load web: complete variable block

```dotenv
APP_ENV=load
NODE_ENV=production
PORT=3000
DATABASE_URL=postgresql://postgres.<LOAD_PROJECT_REF>:<URL_ENCODED_PASSWORD>@<SESSION_POOLER_HOST>:5432/postgres?schema=public&sslmode=require&connection_limit=3
SHOPIFY_APP_URL=https://<LOAD_WEB_PUBLIC_DOMAIN>
SHOPIFY_API_KEY=load-dummy-key
SHOPIFY_API_SECRET=load-dummy-secret
SCOPES=write_products,read_orders,write_publications,write_cart_transforms
SHOPIFY_ADMIN_MOCK_URL=http://shopify-mock.railway.internal:4010
SHOPIFY_ADMIN_MOCK_TOKEN=<SAME_RANDOM_LOAD_ONLY_TOKEN>
```

### Load worker: complete variable block

```dotenv
APP_ENV=load
NODE_ENV=production
DATABASE_URL=postgresql://postgres.<LOAD_PROJECT_REF>:<URL_ENCODED_PASSWORD>@<SESSION_POOLER_HOST>:5432/postgres?schema=public&sslmode=require&connection_limit=4
SHOPIFY_APP_URL=https://<LOAD_WEB_PUBLIC_DOMAIN>
SHOPIFY_API_KEY=load-dummy-key
SHOPIFY_API_SECRET=load-dummy-secret
SCOPES=write_products,read_orders,write_publications,write_cart_transforms
SHOPIFY_ADMIN_MOCK_URL=http://shopify-mock.railway.internal:4010
SHOPIFY_ADMIN_MOCK_TOKEN=<SAME_RANDOM_LOAD_ONLY_TOKEN>
WORKER_CONCURRENCY=2
```

The worker has no listening port, so it does not require `PORT`. Web and worker
must share the dummy Shopify credentials, scopes, app URL, and mock token. The
future webhook sender must sign deliveries with the same `SHOPIFY_API_SECRET`.
`NODE_ENV=production` selects the hosted Node runtime behavior; `APP_ENV=load`
selects the mock transport. Do not use real Shopify credentials.

### `shopify-mock`: complete variable block

This example is for an October 2026 campaign. Change `MOCK_START_AT` for later
campaigns so generated timestamps remain within the last 60 days and in the past.

```dotenv
APP_ENV=load
NODE_ENV=production
PORT=4010
MOCK_HOST=::
SHOPIFY_ADMIN_MOCK_TOKEN=<SAME_RANDOM_LOAD_ONLY_TOKEN>
MOCK_SHOPS=1
MOCK_ORDERS_PER_SHOP=20
MOCK_START_AT=2026-09-01T00:00:00.000Z
MOCK_INTERVAL_MS=1000
MOCK_LATENCY_MS=100
MOCK_JITTER_MS=100
MOCK_HTTP429_EVERY=0
MOCK_HTTP500_EVERY=0
MOCK_THROTTLE_EVERY=0
```

The mock does **not** need `DATABASE_URL`, `SHOPIFY_APP_URL`, `SHOPIFY_API_KEY`,
`SHOPIFY_API_SECRET`, `SCOPES`, `WORKER_CONCURRENCY`, or `SHOPIFY_ADMIN_MOCK_URL`.
Remove inherited variables for those names from this service. The shared
Dockerfile generates Prisma Client during the build, but the running mock uses
no database and performs no migrations.

Set `MOCK_HOST=::` as shown so the mock accepts IPv6 as well as IPv4 connections.
[Railway private domains](https://docs.railway.com/networking/private-networking/how-it-works)
can resolve to IPv6; this also supports older environments with IPv6-only private
DNS. The script's unset host default is `0.0.0.0`, so set this variable explicitly
for Railway.

Start with the 20-order, one-merchant dataset and no faults above. After the
seed/sender smoke test passes, a larger campaign can use `MOCK_SHOPS=10` and
`MOCK_ORDERS_PER_SHOP=200000` (**2 million orders total**), with
`MOCK_HTTP429_EVERY=101`, `MOCK_HTTP500_EVERY=211`, and `MOCK_THROTTLE_EVERY=53`.
Order count is per shop, not shared across all shops. All the dataset/fault
settings are optional except `MOCK_START_AT`; explicit values above make the
first deployment predictable. Unset defaults are 1 shop, 200,000 orders per shop,
1000 ms spacing, 100 ms base latency, 100 ms jitter, and disabled faults.

### Database pool limits and optional variables

The blocks above use web `connection_limit=3`, worker `connection_limit=4`, and
`WORKER_CONCURRENCY=2`. This example fits a Supabase session pool size of 15:
7 connections normally, up to 14 while old/new containers overlap during a
deployment. Confirm your project's actual pool size before using these values.
For a campaign that matches production, use production's concurrency and pool
limits only after confirming that the isolated project has the same capacity.
The worker needs at least `WORKER_CONCURRENCY + 2` connections. Budget for all
replicas, deployment overlap, migrations, and any harness connections too.

This repository's Prisma schema uses only `DATABASE_URL`, including migrations;
there is no `DIRECT_URL` requirement. No Supabase anon key, service role key, or
Supabase API URL is needed by these services.

Optional web/worker variable: `SENTRY_DSN` for a **load-specific** monitoring
project. Leave it unset to use structured logs only; do not inherit production's
DSN. `SHOP_CUSTOM_DOMAIN` is unnecessary for synthetic `load-N.myshopify.com`
shops and should remain unset. `WORKER_CONCURRENCY` accepts 1–16 (default 4);
the explicit value above is deliberately paired with the example pool limits.

### Deployment checks and next step

1. Confirm all three services deploy the same `load-testing` commit. Keep their
   source branches separate from staging and production.
2. Confirm the public web `/healthz` passes and the mock logs
   `mock_shopify_ready`. The mock's private `/healthz` should return `{"ok":true}`
   when requested from within the load environment.
3. Confirm web/worker have the matching mock URL/token and the isolated database
   URL. Missing configuration will fail application startup or the first fetch.
4. Seed a fake merchant, session, and pricing rule, then send a small signed
   webhook set with `npm run load:smoke` as described below. Infrastructure startup
   alone does not seed tenants or prove ingestion works. The full burst/soak
   harness is not implemented yet.

Never set mock variables in staging or production: startup rejects them outside
`APP_ENV=load`. Load mode rejects a missing mock URL/token, avoiding fall-through
to Shopify. Mock URLs must be HTTP(S) origins without paths, credentials, query
strings or hashes. The transport refuses Shopify hosts and real tenant domains,
times out after 30 seconds, rejects redirects, and sends only the mock token.

For a local run export the mock variables above, then run `npm run load:mock`.
Use `SHOPIFY_ADMIN_MOCK_URL=http://127.0.0.1:4010` on local web/worker processes.
The scripts do not load `.env` automatically; export variables or use Node's
`--env-file` option with a separate ignored load-only file.

## Quick smoke test against the deployed environment

Run this from your local repository, with Node 22.12 or later and dependencies
installed. The smoke command automatically reads the root `.env.load-smoke` file;
it does not read `.env`. No access to Railway's private mock URL is needed from
your laptop: the deployed worker makes that request.

1. Set the mock service to `MOCK_SHOPS=1`, `MOCK_ORDERS_PER_SHOP=20`, and all three
   fault settings to `0`. Deploy those settings. Orders 1, 2, and 10 must exist.
2. Copy the example and fill in the **load** values:

   ```sh
   cp scripts/load/smoke.env.example .env.load-smoke
   ```

   Set `DATABASE_URL` to the isolated Supabase Session pooler URL; the example
   uses just one additional connection for the local harness. Set
   `LOAD_SUPABASE_PROJECT_REF` to that same project's reference (the identifier
   used in the pooler username `postgres.<reference>`). Set `SHOPIFY_APP_URL` to
   the load web's public HTTPS origin and `SHOPIFY_API_SECRET` to the **exact same
   dummy secret** as deployed web/worker. Keep `LOAD_SMOKE_CONFIRM=load-only`
   only after verifying those targets. Leave the file ignored; never commit it.
3. Generate your local Prisma client if you have just installed dependencies,
   then run:

   ```sh
   npx prisma generate
   npm run load:smoke
   ```

The command checks web health, refuses a database containing non-load shops,
then seeds `load-1.myshopify.com`, its dummy offline session, and its pricing
rule in one transaction. For a newly seeded shop it initializes the reconciliation
watermark to now, so this smoke test does not start a full historical backfill.
Existing fake-shop data is preserved; reruns create fresh webhook IDs and check
the same three order records. An existing fake shop with a pending backfill,
partial window, or watermark older than ten minutes is refused. Do not run it
during an active large campaign.

It sends eight signed HTTP deliveries for orders 1, 2, and 10: six unique events
plus two exact duplicate deliveries, with updated/refund topics arriving before
paid/create topics. It waits up to 180 seconds for the **deployed worker**, then
checks the three paid orders, two attributed and correctly priced AUD 2 purchases,
and one confirmed AUD 2 refund. It reads only these orders when checking financial
totals, so other reconciled mock orders do not affect the result. Success prints:

```text
PASS: 3 paid orders, 2 purchases totaling AUD 4, 1 refund totaling AUD 2; 6 unique deliveries processed.
```

This leaves the fake merchant and records in the isolated database for inspection;
it does not delete them. It does not test Shopify OAuth, browser dashboard login,
or the full reconciliation backfill. To test the latter later, deliberately reset
the fake shop's reconciliation watermark/cursor after verifying dataset dates.

If the command fails:

- HTTP 401: check the web URL and matching dummy Shopify secret.
- HTTP 500 on receipt: check web logs and migrated tables/database configuration.
- Worker timeout: check `worker_started`, worker retry logs, the offline session,
  mock private hostname/port/token, and mock order count. The public web health
  check alone does not prove worker or mock connectivity.
- Incorrect purchase/refund result: check that the deployed mock uses the current
  fixture version and the fake pricing rule still matches it.

`APP_ENV=load` in the local file gates the harness; it does not change Railway's
environment. Web and worker must already be deployed with their load settings.

## Dataset and seed contract

`dataset.js` exports `shopDomain`, `orderId`, `generatedOrder`, and the protection
product/variant/rule identifiers shared by the smoke test and future load scripts. Orders are
generated on demand, so a 200,000-order dataset does not occupy server memory.
Set the same start timestamp and interval for every replica and harness process.
Choose dates inside the worker's initial 60-day reconciliation window; the final
timestamp is `MOCK_START_AT + (MOCK_ORDERS_PER_SHOP - 1) * MOCK_INTERVAL_MS` and
must be in the past if you want all orders included in reconciliation.

Seed each `load-1.myshopify.com` through `load-N.myshopify.com` with:

- A `Shop` row with `installationState=INSTALLED`.
- An offline `Session`: `id=offline_<shop domain>`, `shop=<shop domain>`,
  `isOnline=false`, `state=load`, `accessToken=load-dummy-token`, `expires=null`,
  `refreshToken=null`, `refreshTokenExpires=null`, and matching configured scopes.
  These are synthetic sessions; the worker still loads them through the SDK.
  Expired sessions would exercise token refresh outside this mock's scope.
- A tenant-owned `PricingRule` with `ruleId=load-protection`, `version=1`,
  `productId=gid://shopify/Product/9001`, `variantId=gid://shopify/ProductVariant/9001`,
  `rateBasisPoints=200`, `basis=SHIPPABLE_PRE_DISCOUNT`, `state=ACTIVE`, and effective,
  published, and activated timestamps preceding the generated orders. Link the
  shop's active pricing rule using the rule ID and shop ID.

Each tenant intentionally reuses order IDs `gid://shopify/Order/1` through the
configured count. Names include the tenant, allowing later checks to catch
cross-tenant writes. Every order has one AUD 100 shippable line. Even IDs have a
shipping protection line charged AUD 2 with pricing contract version 2. Every
tenth ID refunds that protection line with a successful AUD 2 refund transaction.
Orders have `test=false` so the app counts them in its financial metrics; only use
this dataset in the isolated load database. Paid timestamps and refunded amounts
come from generated transactions, never from webhook delivery order.

## Protocol and faults

`POST /shops/<load-N.myshopify.com>/graphql.json` accepts `{query, variables}`
with `Authorization: Bearer <SHOPIFY_ADMIN_MOCK_TOKEN>`. It supports the app's
`AnalyticsOrder`, `OrderVersion`, `ReconcileOrders`, and `AnalyticsShop` operations.
Shop metadata uses AUD and Australia/Sydney for Overview reads. Reconciliation
returns `nodes`/`pageInfo`, honors inclusive `updated_at` window bounds, and uses
tenant/window-bound cursors. Unknown tenants return 404, missing orders return
`order:null`, and unsupported queries/search filters return GraphQL errors.
This is a fixture server for these operations, not a general GraphQL interpreter.
All order child connections currently fit in one page. OAuth, merchant onboarding,
product/settings mutations, and large multi-page order snapshots are not modeled.

Latency is base milliseconds plus uniform jitter. Fault settings inject failures
on every Nth request **per tenant**; 0 disables a fault. HTTP 500 takes priority
over HTTP 429, then GraphQL `THROTTLED`. Counters reset on mock restart and are
local to each replica. Use one replica for predictable fault schedules.
`GET /stats` (same bearer token) reports per-tenant request counts;
`GET /healthz` is unauthenticated and excluded from fault injection.

HTTP errors reach the worker's existing durable backoff. GraphQL throttles reach
the existing three-retry cost-aware handler. The override uses HTTP fetch directly,
so it does **not** exercise the Shopify SDK's internal HTTP retries. The mock's
cost metadata is synthetic, shaped after [Shopify's rate-limit contract](https://shopify.dev/docs/api/usage/limits),
and is not a measured cost or an accurate per-shop bucket simulator. A live pilot
is still required to validate real Shopify behavior.

## Verification

```sh
npm test -- app/shopify/admin-graphql.server.test.js app/shopify/mock-admin.server.test.js
```

The tests bind a local HTTP port and exercise the existing fetch/normalization path,
window pagination, tenant separation, mock authentication, and injected failures.
