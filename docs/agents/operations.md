# Distribution, deployment, workers, and reliability

Read when changing app distribution, Railway deployment, service responsibilities, error handling, workers, reconciliation throughput, or live-store performance.

[Back to root instructions](../../AGENTS.md). Related: [Webhook ingestion](orders-webhooks.md); [Cart Transform failure behavior](protection.md); [verification workflow](development.md).

## Shopify Distribution

The intended production product is a multi-merchant application serving unrelated merchants.

Production architecture should therefore be compatible with Shopify public app distribution, potentially with limited visibility rather than broad App Store discovery.

Development may still use a separate single-merchant/custom development app.

Do not bake `SingleMerchant` assumptions into business logic.

Prefer environment-specific Shopify app configuration:

```text
development Shopify app
    ->
development credentials/configuration

production Shopify app
    ->
production credentials/configuration
```

Use one source codebase.

Do not maintain separate product forks for custom and public distribution.

## Deployment Architecture

Before changing deployment architecture, identify what each existing Railway service actually does.

Prefer one primary public application origin unless there is a concrete reason to expose more.

Conceptually:

```text
Shopify / storefront / merchant admin
                |
                v
       Public Railway service (web)
                |
     +----------+----------+
     |                     |
     v                     v
 PostgreSQL  <------  private worker
 (Supabase)          (scripts/worker.js)
```

Current services:

- **Web** (`npm run start`): Admin UI, OAuth, webhook receipt, health check at `/healthz`. Webhooks are verified and written to the `WebhookDelivery` inbox, then acknowledged.
- **Worker** (`npm run worker`): runs `WORKER_CONCURRENCY` loops that each claim all queued deliveries for one order, fetch that order from Shopify once, persist it, and retry with backoff. A separate loop runs periodic order reconciliation. No public domain.

Deploys:

- Railway services should have **Wait for CI** enabled; Railway waits for the commit’s GitHub workflows before deploying. GitHub’s required `verify` job aggregates the `checks` and `docker` jobs, failing if either fails, is skipped, or is cancelled. Deployment branches: staging from `main`, production from the `production` branch. Production releases are fast-forward pushes of a commit already tested on staging ([README → Release to production](../../README.md#release-to-production)). Do not commit to `production` directly.
- CI uses Node `22.18.0` and disposable PostgreSQL 17. Every application run uses `npm ci` with npm's download cache, then generates Prisma, deploys migrations, and runs `verify:schema` to detect an unmigrated datamodel change. The Docker job loads and tests the final Alpine image against its own PostgreSQL 17, including both database verifiers, `/healthz`, and worker startup/shutdown.
- `verify:postgres`, `verify:webhook-postgres`, and `verify:merchant-auth-postgres` require `VERIFY_ISOLATED_DB=1` and an empty `Shop` table. They roll back or redact their fixtures, attempt all cleanup, and disconnect even after a failure. They are unsuitable for development databases containing installed shops.
- Merchant authentication verification uses independent Prisma connections and PostgreSQL lock-wait observations to exercise session/uninstall transaction orderings, stale reinstall saves, and lease takeover. CI runs it through both `npm test` integration coverage and its explicit verification command.
- GraphQL throttle backoff is coordinated per shop within one process. Returned/thrown `THROTTLED` responses publish a shared deadline even after retry exhaustion; stale successful responses cannot shorten another request's deadline. Waits recheck extensions, with requested-cost refill, fallback delay, three retries, and a 30-second cap per wait. Separate web/worker processes still have separate in-memory pacing maps.
- Job dependency behavior: [GitHub `needs`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds). Railway waiting behavior: [Wait for CI](https://docs.railway.com/deployments/github-autodeploys#wait-for-ci). Confirm service settings externally; repository configuration alone does not enable them.
- The pre-deploy command runs `npx prisma migrate deploy`.
- Shopify extensions and app configuration deploy separately with `npx shopify app deploy --config production`. Shopify app versions do not deploy the hosted web app, and backend deploys do not update extensions.
- The [README](../../README.md) has the full Railway and migration procedure.

The primary public application may handle routes for:

- Shopify OAuth/authentication
- embedded Admin UI
- webhooks
- claim APIs
- return APIs
- app proxy routes
- merchant settings
- integration callbacks

One public service does not mean one source file or one monolithic module.

Keep internal code boundaries clear.

A second Railway service is justified when it has a clear job such as:

- background processing
- AI evaluation
- email ingestion/processing
- retry queues
- scheduled reconciliation

If a second service does not need inbound internet traffic, prefer Railway private networking rather than exposing another public endpoint.

Do not merge services blindly.

Understand their existing responsibilities first.

## Error Handling

Errors should be:

- structured
- logged with useful tenant/request context
- safe to retry where appropriate
- visible to merchants when they need to act

Do not swallow Shopify API failures.

Do not treat HTTP 200 as proof that a GraphQL mutation succeeded.

Check GraphQL user errors.

For external services:

- distinguish retryable and permanent failures
- use bounded retry strategies
- avoid infinite loops
- preserve enough state to diagnose failures

## Background Jobs

Use background jobs only when synchronous execution becomes inappropriate.

Good candidates include:

- email parsing
- carrier/tracking lookups
- AI analysis
- slow webhook follow-up work
- retries
- notifications
- analytics aggregation
- long-running Shopify operations

Do not add a queue solely for architectural purity. The PostgreSQL `WebhookDelivery` inbox (claimed with `FOR UPDATE SKIP LOCKED`) is the current queue.

If a worker exists on Railway and does not need inbound public internet traffic, prefer private service-to-service networking.

## Scale and Reliability

Design for the pilot store, a rough estimate that should be updated with real data:

- about 200,000 orders a year (about 550 a day), with peak sale days 5–10× higher
- several webhooks per order, so thousands of deliveries a day normally and 20,000+ on peak days
- every order is ingested, not just protected ones, because attach rate needs all eligible orders

Requirements:

- a checkout failure must never be a side effect of this app (see [`blockOnFailure` under Shopify Protection Strategies](protection.md#implemented-checkout-ui--cart-transform-checkout_ui_cart_transform))
- webhook backlogs may delay the dashboard but must never lose or double-count orders
- order reconciliation must be able to finish its initial 60-day backfill and keep up with daily order updates
- Admin page loads must not do unbounded or slow Shopify work
- the Shopify API calls per order should stay small and predictable

Known gaps (2026-09-29), to fix before installing on a live high-volume store:

1. ~~`blockOnFailure: true` blocks every checkout if the Cart Transform errors.~~ Fixed: the transform no longer blocks checkout; a failure charges $0.00 and alerts (`protection_price_unmatched`).
2. ~~The worker processes one delivery at a time, and each delivery fetches the full order.~~ Fixed: queued deliveries for one order are claimed together and fetched once (one Admin API call for a single-page order), `WORKER_CONCURRENCY` loops (default 4) run in parallel, and Serializable conflicts between them are retried and requeued without spending attempts.
3. ~~Worker reconciliation processes 10 orders per 15 minutes (about 960 a day).~~ Fixed: the worker reconciles continuously in 60-second turns per shop, lists 250 orders per page, fetches only orders missing locally or newer in Shopify, stores each order in its own transaction, and starts each window 10 minutes before the last one ended. Caught-up shops are rechecked every 10 minutes; a failing shop backs off for 5 minutes. An order that can't be fetched or stored is logged (`reconciliation_order_failed`), queued in the `WebhookDelivery` inbox as a `RECONCILE` delivery for the worker's retries, and skipped so the window keeps moving; three failures in a row stop the turn and keep the cursor, since that means Shopify or the database is down. After each turn, up to 20 orders with `PENDING` protection refunds are refetched, least recently checked first and at most once per 10 minutes each; `UNATTRIBUTED` refunds are not polled, because they change only when the order does. Page size is still to be confirmed against measured query cost (`shopify_graphql_cost`).
4. ~~The Overview triggers a 30-order reconciliation on every page load.~~ Fixed: reconciliation runs only in the worker (the Overview sync action and the `/app/reconcile` route are gone). "Refresh" re-reads stored data, and the Overview warns "Order sync is behind" when the last completed sync is over an hour old. Single-order failures are an operator alert (`webhook_terminal`), not a merchant warning.
5. The Overview aggregates 30 days of orders in memory. That is acceptable at pilot scale; `overview_loaded` logs its duration and row counts, so move it into SQL aggregates if that gets slow.

Reconciliation claims a new window before fetching its first page and writes
progress only if the tenant's observed watermark, cursor, and window end still
match. A reset supersedes that turn; it returns `complete: false` and
`superseded: true`, logs `reconciliation_superseded`, and retries without failure
backoff or an error alert. Stored authoritative order snapshots remain safe to
re-read through the normal idempotency rules.
