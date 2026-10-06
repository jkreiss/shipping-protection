# Production readiness and pilot operations

Reviewed on 2026-09-30 against commit `3b5144ef2911988add02bfa686fd977133e6b1a6`.
This is a repository audit and an operator runbook. Railway, GitHub, Supabase,
Shopify, and Sentry settings have not been inspected live. Recheck this document
against the exact release commit before each launch.

The pilot covers shipping protection purchases, pricing, order ingestion, and
merchant reporting. The merchant handles customer requests and pays claims
manually. Claims intake, returns, automated resolutions, billing, and automatic
transfers to another business are outside this release.

## 1. Start here

Before enabling customer charges:

1. Resolve the launch blockers in the audit below.
2. Verify the production settings and assign the operators.
3. Complete the staging acceptance checks and a recovery rehearsal.
4. Record the tested commit, Shopify version, migration state, and backup.
5. Release that commit using section 5.
6. Activate the pilot during a staffed trading period and follow section 8.

Existing deployment instructions remain in the
[README](../README.md#release-to-production). This document supplies the evidence
and recovery steps needed to use that release process on a live store.

## 2. Readiness audit

**Confirmed in repository** means the implementation or configuration exists.
It does not establish that the production service has deployed it.
**Needs live verification** means an operator must attach evidence from the
named system. **Launch blocker** means the stated issue must be resolved before
the offer takes real customer money.

### Repository findings

| Area | Finding and evidence | Status / next action |
| --- | --- | --- |
| Environment separation | [Production](../shopify.app.production.toml) and [staging](../shopify.app.staging.toml) use different Shopify client IDs and HTTPS origins. | Confirmed in repository. Verify separate databases and credentials live. |
| CI | [CI](../.github/workflows/ci.yml) checks tests, isolated PostgreSQL migrations and ingestion, lint, types, web build, and Docker build. | Confirmed in repository. Attach the successful run for the release SHA. |
| Runtime | [Dockerfile](../Dockerfile) supports the web service and private worker from the same source. Migration/start/health settings are documented in README rather than a checked-in Railway deployment file. | Needs live verification on both Railway services. |
| Checkout failure behavior | [Protection setup](../app/shopify/protection-admin.server.js) creates transforms with `blockOnFailure: false`, requires that value for health, and replaces an existing blocking transform during setup. | Confirmed in repository. Deploying code alone does not replace a store's existing transform; verify the installed resource after setup. |
| Pricing failure detection | [Order ingestion](../app/order-ingestion.server.js) records `pricingCheck` and emits `protection_price_unmatched` for a detected mismatch on a newly confirmed payment. | Confirmed in repository. Verify delivery of the alert. A missing or null check is not proof of correct pricing. |
| Webhook processing | [Worker](../app/webhook-worker.server.js) coalesces up to 100 queued deliveries for one order, has 4 loops by default, 15-minute leases, and at most 16 attempts (about 6.4 hours of backoff) for temporary errors. An order Shopify won't return or that can't be normalized fails at once; a shop the app has no access to keeps its deliveries retrying without alerts, so a reinstall processes them, and they fail as `SHOP_UNINSTALLED` after the same budget. | Confirmed in repository. Measure real throughput and restart recovery in staging. |
| Reconciliation | [Reconciliation](../app/order-reconciliation.server.js) backfills a 60-day window, lists up to 250 orders per page, fetches missing/newer orders, and overlaps successive windows by 10 minutes. | Confirmed in repository. Measure page cost and backfill completion. A 60-second turn is checked between pages; a slow page can take longer. |
| Dashboard | [Overview reads](../app/analytics.server.js) use stored orders and refunds; they still make a bounded Shopify shop currency/timezone query. `overview_loaded` records duration and row counts. | Confirmed in repository. Measure latency with pilot-sized data. |
| Health | [/healthz](../app/routes/healthz.jsx) runs `SELECT 1`. | Confirmed in repository. It proves web/database connectivity, not worker progress (the worker has its own Sentry Cron heartbeat), correct schema, webhook subscriptions, or working checkout. |
| Coverage offer | [Merchant setup](../app/merchant/configuration.server.js) still enables theft, loss, and damage flags. [English](../extensions/insurance-ext/locales/en.default.json) and [French](../extensions/insurance-ext/locales/fr.json) checkout copy and the product description now use neutral placeholder wording that names no benefits; it has no legal sign-off. | **Launch blocker.** Align configuration and all customer copy with the benefits approved for the pilot and the product/legal boundary in [AGENTS.md](../AGENTS.md). |
| Emergency shutdown | [Settings](../app/routes/app.settings.jsx) supports setup and rate changes, with no disable action. Transform deletion exists only inside setup repair. | **Launch blocker until a full shutdown procedure is rehearsed.** Use section 6; do not assume a disable button exists. |
| Dependency risk | Non-breaking fixes applied 2026-10-01 (`qs`/`express`, `morgan`). The remaining production advisories are in the Prisma CLI's config loader only; README records the assessment. | Re-run `npm audit --omit=dev` for the release SHA and record any new findings. |

### Settings that need live verification

| System | Required evidence | Owner |
| --- | --- | --- |
| GitHub | `production` requires the `verify` status check and linear history; force pushes, deletion, and bypasses are disabled. Its rules permit the documented direct fast-forward release. | Release operator |
| Railway | Staging services track `main`; production services track `production`; deploys wait for CI. Verify the deployed SHA on **both** services. | Release operator |
| Railway | Web: root Dockerfile, `npm run start`, pre-deploy `npx prisma migrate deploy`, `/healthz`, correct domain/port. Worker: `npm run worker`, no public domain, one running worker instance. | Release operator |
| Railway | Worker deployment is controlled so it starts after the migration and web verification. Separate autodeploys alone do not establish this ordering. | Release operator |
| Supabase | Separate production project/database; Data API disabled; sufficient connections, compute, and disk; backup retention and restore method recorded. | Release operator |
| Shopify | Production app identity, URLs, scopes, API versions, review/distribution status, and installation access verified. Merchant has the capabilities required by the implemented strategy. | Release operator + merchant |
| Shopify | Correct checkout profile has the block; Shop Pay placement is verified separately. Setup health cannot verify placement. Installed transform has `blockOnFailure: false`. | Merchant + release operator |
| Sentry / monitoring | Production environment is identifiable; required alerts reach the named operator; a staging notification rehearsal succeeds. | Release operator |
| Merchant | Price, benefit set, customer terms, manual claims contact/process, and payout accounting decisions are recorded. | Merchant owner |

The backend uses public app distribution. Public distribution requires Shopify
approval; limited visibility still requires an App Store listing. Record approval
before relying on installation on the live merchant. A custom app identity for
a pilot is a separate distribution decision and must match backend authentication
configuration. Distribution cannot be changed after selection.
[Shopify distribution](https://shopify.dev/docs/apps/launch/distribution),
[listing visibility](https://shopify.dev/docs/apps/launch/distribution/visibility).

## 3. Operator and environment worksheet

Keep secrets in the platform's secret storage, not in this document or a release
ticket. Record resource names and dashboard links only.

| Item | Production value / evidence |
| --- | --- |
| Release operator and backup operator | To assign |
| Merchant launch contact and claims contact | To assign |
| Incident contact method and staffed hours | To agree |
| Railway project/environment, web service, worker service | To record |
| Supabase project reference and backup access | To record |
| Shopify app, distribution approval, pilot shop domain | To record |
| Sentry project/environment and notification destination | To record |
| Maximum acceptable app downtime and data loss | To agree; measure against restore rehearsal |

Confirm these values without copying their contents into logs:

| Variable | Check |
| --- | --- |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | Credentials belong to the production app in `shopify.app.production.toml`. Web and worker use the same production app. |
| `SHOPIFY_APP_URL` | Matches production HTTPS origin and callback configuration; no trailing slash. |
| `SCOPES` | Matches **production** TOML; changes require the matching Shopify app version and granted installation access. |
| `DATABASE_URL` | Correct production database, TLS required, Supabase Session pooler on port 5432. Web/worker pool sizes fit the database budget. |
| `NODE_ENV`, `APP_ENV` | Both `production` in production. Staging uses `NODE_ENV=production`, `APP_ENV=staging`. |
| `PORT` | Matches the web service's domain target; `3000` for the documented setup. |
| `SENTRY_DSN` | Correct environment-specific server monitoring configuration. |
| `WORKER_CONCURRENCY` | Worker only; start at default `4`, then tune from measured API and database capacity. Valid range is 1–16. |

With 4 delivery loops, use at least 6 worker Prisma connections; README suggests
8. Count web connections, worker connections, deployment overlap, and operator
sessions against Supabase's available pool. Keep one worker instance initially:
API pacing is shared inside a process, and reconciliation has no cross-process
shop lease. Adding replicas is a separate reliability change.

**To do: database connection limits (not yet set, noted 2026-09-30).** Without
`connection_limit`, Prisma sizes each service's pool from the machine's CPU
count; staging already hit `EMAXCONNSESSION ... pool_size: 15` during a deploy.
Append to the existing `DATABASE_URL` (it already has `?`, so start with `&`):

- [ ] **Staging** (pool size 15): web `&connection_limit=3`; worker
  `&connection_limit=4` and `WORKER_CONCURRENCY=2`. That is 7 connections
  normally and 14 while old and new containers overlap during a deploy.
  Afterwards, confirm there are no `EMAXCONNSESSION` errors across a deploy and
  check `webhook_processed` `durationMs` to confirm 2 loops keep up.
- [ ] **Production:** check the Supabase plan's pool size (**Database →
  Settings**) and raise it if needed, rather than cutting worker loops. Then set
  web `&connection_limit=3`–`4` and worker `&connection_limit=8` with the default
  4 loops, keeping twice the combined limits within the pool size.

**To do: retire the checkout-token hash (noted 2026-10-01).** The app no longer
reads, fetches, or stores checkout tokens; migration
`20261002000000_clear_checkout_token_hash` cleared existing hashes but kept the
nullable `Order.checkoutTokenHash` column, so containers still running the old
code during that deploy keep working.

- [ ] After that release is live on **both** staging and production, delete
  `CHECKOUT_TOKEN_HASH_SECRET` from the web and worker Railway variables.
- [ ] In a later release, remove `checkoutTokenHash` from `prisma/schema.prisma`
  and add a migration that drops the column.

**To do: narrower access scopes (noted 2026-10-01).** The unused
`write_metaobjects` and `write_metaobject_definitions` scopes were removed from
every `shopify.app*.toml`. For staging, then production:

- [ ] Run `npx shopify app deploy --config <env>` so installations drop the
  scopes (Shopify sends `app/scopes_update`).
- [ ] Set the Railway `SCOPES` variable on web and worker to
  `write_products,read_orders,write_publications,write_cart_transforms`.
  Removing scopes doesn't require merchants to re-approve the app.

## 4. Staging acceptance and recovery rehearsal

Run against the release candidate, using the staging Shopify app and staging
database. Record the SHA, app version, timestamps, safe order IDs, and outcomes.
CI proves its isolated checks; it does not prove these hosted behaviors.

| Scenario | Evidence required |
| --- | --- |
| Opt in / remove / quantity changes | One protection line of quantity 1 when selected; no line after removal; correct recalculation when merchandise changes. Include checkout reload and Shop Pay if used. |
| Eligibility | Digital-only carts, subscriptions, pickup, zero-rounded fees, and unavailable cart mutation produce the intended offer behavior without checkout errors. |
| Price | Compare final Shopify line amounts with the approved rate and shippable pre-discount basis. Exercise discounts, tax, rounding, and every enabled currency. Old paid purchases retain their pricing snapshot after a rate change. |
| Payment | An unpaid order is not counted as a completed purchase. A paid protected order has exactly one confirmed purchase. A paid unprotected order contributes to eligible order counts. |
| Refunds / cancellations | Partial merchandise, full merchandise, protection-fee refunds, and unpaid cancellations affect the correct metrics exactly once. Do not assume a merchandise refund also refunds protection. |
| Duplicate / overlapping events | Repeated create/paid/update/refund deliveries leave one local order, one purchase, and one protection refund per Shopify refund ID. |
| Worker interruption | Restart while work is leased; the batch is recovered after its lease expires without duplicating the purchase. Allow the documented 15-minute lease interval. |
| Failure / API throttling | A controlled staging failure retries and recovers. An exhausted delivery produces `webhook_terminal`. Confirm the notification and recovery workflow, not just a log entry. |
| Function failure | Controlled staging-only failure leaves checkout usable. If the fallback protection line is charged incorrectly, verify the mismatch record/alert and the shutdown drill. Never inject this failure on the live merchant. |
| Reconciliation | Complete the initial window, then recover a missed order update. Record completion time, cursor progress, fetched/skipped counts, and `shopify_graphql_cost`. `reconciliation_completed` with `complete: false` is only a partial turn. |
| Tenant isolation | Use two staging tenants; configuration, orders, refunds, analytics, and support operations stay scoped to the authenticated shop. |
| Dashboard | Load Overview with 30 days of representative orders while the worker is busy. Record `overview_loaded` durations and row counts; ensure Refresh does not trigger order reconciliation. |
| Uninstall / reinstall | Staging only. Check installation/session state, Shopify resource cleanup, reinstall setup, and subsequent ingestion. |
| Recovery | Rehearse backend rollback, Shopify version rollback, offer shutdown, and database restore before the live launch. |

Use roughly 33,000 orders to represent a 60-day pilot history at 550 orders/day,
plus a representative burst based on the estimated 20,000+ webhook deliveries on
a peak day. Measure arrival rate and processing rate, not only total volume.
Replay/synthetic load belongs in an isolated staging harness; this runbook does
not add one or authorize fabricated deliveries to production. Use a staging
shop to measure real Shopify costs with controlled traffic.

Initial targets to accept or revise before launch:

- No lost or duplicated money records in the acceptance scenarios.
- Initial representative backfill completes within 24 hours while new orders
  continue processing; record actual duration and Shopify query costs.
- Oldest queued delivery stays below 5 minutes in normal operation; a measured
  peak backlog drains within 30 minutes after the burst ends.
- Completed reconciliation normally remains less than 30 minutes behind after
  initial backfill. Investigate any gap approaching the existing 1-hour warning.
- Overview server read duration has a p95 below 2 seconds at representative
  volume; record client experience separately.

These are proposed pilot targets, not measured performance guarantees. If the
candidate misses one, record the cause and change the implementation or obtain
an explicit operational decision before launch.

## 5. Release procedure

### 5.1 Record the release

Create a release record outside the public repository if it contains merchant
details. Include:

- Tested full commit SHA and CI run link.
- Staging web/worker deployment IDs and staging Shopify version.
- Acceptance results, shutdown/restore rehearsal results, operator names.
- Pending migrations and compatibility with the currently running services.
- Backup ID/time, restore target, retention, and measured restore duration.
- Previous production web/worker deployment IDs and Shopify version.
- New production deployment IDs, Shopify version, and activation time.
- Approved percentage, pricing rule/version, benefits/terms reference, and pilot
  shop/resource IDs. No access tokens or database URLs.

### 5.2 Prepare the tested checkout

Use the SHA displayed on the verified staging deployment, not a moving `main`.
Run each step individually and stop on failure. From the repository root:

```sh
RELEASE_SHA='replace-with-the-full-tested-sha'
git fetch origin
git show --no-patch --format='%H %s' "$RELEASE_SHA"
git merge-base --is-ancestor origin/production "$RELEASE_SHA"
```

The ancestry command must exit 0 for an existing production branch. A rejected
fast-forward needs investigation; never force it. For the first release, if the
remote branch does not exist, explicitly record its creation from the tested
SHA instead of treating a missing branch as an ancestry pass.

To deploy extensions without switching a checkout another agent is using, create
a detached worktree. Replace the directory below with a new, unused directory:

```sh
RELEASE_WORKTREE='/tmp/shipping-protection-production-release'
git worktree add --detach "$RELEASE_WORKTREE" "$RELEASE_SHA"
cd "$RELEASE_WORKTREE"
npm ci
npx shopify app config validate --json --config production
```

Inspect the production app identity and origin, and confirm that the CLI's target
is the intended production app. Reuse the pinned CLI. Do not run `app dev` against
the production app or copy local development secrets into the worktree.

### 5.3 Prepare migrations and service ordering

Before promotion, inspect pending migrations against the production database
using an authenticated operator session with credentials supplied securely:

```sh
npx prisma migrate status
```

Pending migrations are expected for a release; failed migrations are not. Take a
verified backup before applying them. A stopped worker and a healthy old web
service are compatible with ordinary additive migrations only if the release
review establishes that compatibility. The durable-protection migration has a
specific maintenance procedure in
[README](../README.md#coordinated-durable-protection-migration); follow it if
that migration is still pending.

For the pilot, pause the production worker and its automatic rollout through the
rehearsed Railway process before promotion. Let the web receive and persist
webhooks while the worker is paused when schema compatibility permits. Resume
the worker with the **new SHA** after the web migration/deployment passes. If
the live environment cannot sequence this safely, resolve that before promotion.
Set a bounded pre-deploy timeout based on observed migration duration. A failed
pre-deploy command prevents the new Railway deployment; it does not prove the
database was unchanged. [Railway pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command).

### 5.4 Promote the backend

From the tested worktree:

```sh
git push origin "$RELEASE_SHA":production
```

This push moves the remote branch and triggers Railway. `git pull` only downloads
commits; it is not the promotion step. Do not create commits directly on
`production`.

Wait for the production web deployment. Confirm migration success and its exact
SHA; then verify:

```sh
curl --fail --silent --show-error --max-time 15 \
  https://insurance-backend-production-82be.up.railway.app/healthz
```

Expect HTTP 200 and `{"ok":true}`. Also open the authenticated embedded Admin
pages. Deploy/resume the private worker at the same SHA, restore its normal CI
autodeploy setting, and inspect `worker_started` for the intended concurrency.
Use an order ingestion or reconciliation result to establish progress: a startup
message by itself is insufficient.

### 5.5 Release Shopify configuration and extensions

Only when this release changes Shopify configuration or extensions, from the
same tested worktree:

```sh
npx shopify app deploy --config production
```

Review the CLI's app target and proposed changes before confirming. Record the
released version from the output and verify it in the Dev Dashboard. The command
releases a snapshot of configuration/extensions; it does not deploy Railway.
[Shopify app deploy](https://shopify.dev/docs/api/shopify-cli/app/app-deploy).

On initial setup, deploy the required Function before running merchant setup.
For an existing installation, rerun setup when needed to replace a blocking
transform, and verify the actual installed flag. Setup enables the offer's
configuration and may repair/create resources: perform this only after the
approved price/benefits and recovery procedure are ready. Keep checkout placement
off until the activation checklist is complete.

### 5.6 Verify and close

Confirm a protected and an unprotected checkout, the final Shopify line price,
webhook receipt, worker completion, one confirmed purchase, and the corresponding
dashboard values. Include removal and Shop Pay if enabled. Record any controlled
live smoke order and its refund so pilot reporting can explain it; do not switch
the merchant's payment gateway into test mode.

Inspect terminal failures, pricing mismatches, pending refund notices, backlog
age, and reconciliation progress. Leave the release open until they have been
reviewed. Remove the temporary worktree later from the original checkout after
checking for files worth retaining:

```sh
git worktree remove "$RELEASE_WORKTREE"
```

If generated files prevent removal, review those files first rather than using
force cleanup.

## 6. Recovery procedures

For every incident, record start time, affected shop(s), deployed versions, safe
order IDs, observed errors, action taken, and the verification result. Freeze
unrelated production releases while recovery is underway.

### 6.1 Incorrect price or checkout trouble

1. Ask the merchant to remove the Shipping Protection block from every published
   checkout configuration where enabled, including Shop Pay, and save/publish.
   This stops presentation in those placements; the transform and existing
   protection cart lines remain. Keep the backend/worker available for ingestion.
2. If a recent Shopify version caused the problem and a compatible known-good
   version exists, restore it using section 6.3 and verify current carts.
3. For a full stop, follow the rehearsed product/transform procedure below.
   Do not assume stopping Railway stops a Shopify Function.
4. Review orders placed since the incident began against Shopify. Decide customer
   handling with the merchant, including $0 protection lines and fee refunds.
   Do not edit immutable paid purchase records or recharge customers blindly.

#### Full protection shutdown: operator prerequisite

There is no supported end-to-end disable action today. Before the live pilot,
assign an operator with a secure, authenticated route using **this app's**
installation and rehearse the following on staging. If such a route is unavailable,
this remains a launch blocker; this document does not create it.

1. Verify the authenticated shop domain against the incident's tenant. Read and
   record this app's product, variant, transform, and configuration identifiers.
   Do not identify a resource by product title alone or use another app's token.
2. Remove the checkout block as above. Where stopping product sales is needed,
   the merchant can archive the identified protection product in Shopify Admin
   under **Products**. This preserves the product record while making it
   unavailable for sale. [Shopify product status](https://help.shopify.com/en/manual/products/details/product-details-page).
3. Through the rehearsed operator route, publish a disabled configuration to both
   this app's shop configuration and Function configuration, and disable the
   tenant's local protection setting. Verify those writes. Editing only the local
   database does not turn off Shopify's offer or Function.
4. Delete only this installation's identified transform through
   `cartTransformDelete`. Check GraphQL errors, `userErrors`, and the returned
   deleted ID; confirm it is absent on a new read. The setup repair helper is
   private and Settings exposes no deletion operation.
   [Shopify transform deletion](https://shopify.dev/docs/api/admin-graphql/latest/mutations/carttransformdelete).
5. Test a fresh cart and a previously protected cart. Archived/unavailable items
   and stale cart state can require removing the protection line before checkout
   succeeds. Establish a working customer removal path in the staging rehearsal;
   hiding the checkbox is not proof that existing carts are safe.
6. Keep ingestion running, reconcile affected orders, and communicate the pause
   to the merchant. Do not run setup during the pause: it reenables configuration
   and repairs/reactivates product resources.

Uninstall is a disruptive last resort, with the merchant's agreement. The
uninstall handler deletes sessions and marks the shop uninstalled, stopping its
normal worker reconciliation. Do not depend on uninstall for preserving ingestion
or indefinitely preserving app data: a later verified `shop/redact` deletes that
tenant's data. Rehearse cleanup/reinstall on staging before relying on it.

To resume, release compatible code/extensions, run setup, apply the approved
rate, confirm the nonblocking transform and pricing, and replace the checkout
block only after the smoke checks pass. Existing orders retain their purchase
history.

### 6.2 Backend or worker regression

Pause automatic rollout and stop a worker that is writing incorrect state. Check
whether the old web/worker code can operate against the **current** schema and
Shopify configuration before rollback. An additive migration does not by itself
prove compatibility with old code.

If compatible, use Railway **Service → Deployments → previous successful
deployment → Rollback** for the affected services. Restore a compatible pair
when their behavior depends on each other. Railway rollback restores the image
and custom variables; inspect restored database URLs, secrets, and pool settings
before starting. Record the temporary difference from the `production` branch.
[Railway rollback](https://docs.railway.com/deployments/deployment-actions).

Verify `/healthz`, Admin pages, worker progress, and checkout. If incompatible,
keep the offer paused and fix forward through `main`, staging, and a new
fast-forward production release. Do not force-reset the production branch to
the old SHA or restore a database merely to undo an application deployment.

### 6.3 Shopify configuration / extension regression

The known-good Shopify version must be compatible with the current backend,
schema, and live pricing contract. From a checkout containing the correct
production app config and installed pinned CLI:

```sh
npx shopify app release --config production \
  --version 'replace-with-the-known-good-production-version'
```

This releases an existing Shopify app version. It also restores that version's
configuration, which can affect URLs, scopes, and webhook subscriptions; inspect
those changes. It does not restore Railway code, merchant placement, pricing
metafields, or transform resources created by setup.
[Shopify app release](https://shopify.dev/docs/api/shopify-cli/app/app-release).

Verify Function pricing, opt in/removal, Shop Pay where enabled, webhook delivery,
and paid purchase ingestion. Do not roll back to a configuration/code path that
recreates a blocking transform. Use a forward fix if no safe version exists.

### 6.4 Backlog or terminal webhook failures

Use the tenant-scoped diagnostics in section 7. Confirm worker SHA, running
instance count, valid concurrency, database connections, Shopify installation
access, and retry logs. Restart a crashed worker after fixing the cause. Processing
batches can remain leased for up to 15 minutes after a hard stop.

`PENDING` rows retry automatically. `FAILED` rows exhausted their attempts, hit
an error a retry can't fix, or belong to an uninstalled shop (`SHOP_UNINSTALLED`),
and do not automatically return to the queue. There is no Settings replay operation.
Do not bulk reset statuses/attempts or delete inbox rows during diagnosis.

Fix the cause, then verify that worker reconciliation fetches and stores each
affected order's latest Shopify state. An old failed row may remain after the
order is recovered; document recovery separately. Orders outside Shopify's
accessible history or updates outside the current scan window need a reviewed,
tenant-scoped recovery operation using appropriate access. Reconciliation cannot
reconstruct missing historical pricing rules or every original paid snapshot.
Close the incident only after comparing affected purchases/refunds with Shopify.

Tune loop concurrency only after checking API query costs and database pool
headroom. Do not add worker replicas as an emergency shortcut; they do not share
the in-process per-shop API budget.

### 6.5 Migration failure

Stop the new worker rollout, preserve logs and a database snapshot, and inspect
`prisma migrate status` against the correct environment from the matching release.
Investigate the failed migration's actual statements; some changes may already
have applied. Never run `prisma migrate reset` or `db push` as hosted recovery.

For the specific PostgreSQL `55P04` failure on
`20260930000000_webhook_inbox_paid_metrics`, use the conditional recovery described
in [README](../README.md#deploy-the-backend-on-railway), only if that migration is
reported failed and the reviewed split migration is safe to retry. Other failures
need their own recovery decision. `migrate resolve` records migration state; it
does not undo SQL. Do not mark a migration applied unless its complete intended
schema change has actually been performed.
[Prisma failed migration recovery](https://www.prisma.io/docs/orm/v6/prisma-migrate/workflows/patching-and-hotfixing).

### 6.6 Backup rehearsal and database restoration

Before launch and before a production migration, record the backup mechanism,
restore point, retention, and operator access. Verify the actual project's plan:
daily backup and PITR availability are plan-dependent. Keep a recovery record
for application secrets and hosted configuration as well as the database.
[Supabase backups](https://supabase.com/docs/guides/platform/backups).

Rehearse restoration into an isolated target using the project's supported
dashboard restore-to-new-project method or the documented logical backup/restore
process. Keep the restored database's Data API disabled and prevent any worker,
Shopify API call, webhook subscription, or outbound action from using copied live
sessions. Backups contain Shopify access tokens and must be protected like
credentials. [Supabase CLI backup and restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).

Validate the restored migration history, tenant counts, sample confirmed purchase
snapshots, refund records, pricing rules, and inbox rows against the backup's
recorded point. Record elapsed restore time and schema/data failures. A successful
download or checksum is not a successful restore rehearsal. Do not point a test
worker at the restored production sessions to prove it boots.

If production restoration is required:

1. Pause the offer and automatic deploys, stop the worker, and stop application
   writes. Preserve the damaged database and incident evidence if possible.
2. Record the selected restore point and the interval of app state at risk. Obtain
   the incident owner's decision for replacing live data.
3. Restore through the rehearsed procedure. The database is unavailable during
   an in-place Supabase restore; verify completion before reconnecting services.
4. Check current installation permissions and any uninstall/redaction requests
   received after the restore point **before** using restored sessions. A backup
   must not silently reinstate revoked access or deleted tenant data.
5. Start code compatible with the restored schema. Apply only reviewed migrations,
   then restore webhook receipt and worker processing in that order.
6. Reconcile the outage/restore interval against Shopify, accounting for delivered
   webhooks lost with the database rewind. If the stored reconciliation cursor
   does not cover it, arrange a reviewed tenant-scoped rescan; restarting does not
   automatically establish full coverage.
7. Recover application-owned settings/pricing history from retained evidence.
   Shopify can recover commerce state, not all app-owned history. Compare live
   metafields/transform with restored rules before resuming protection charges.
8. Verify purchase/refund counts and amounts, alert delivery, and backlog drainage;
   communicate remaining uncertainty to the merchant before relying on analytics.

## 7. Monitoring and tenant-scoped diagnostics

Assign the release operator as primary responder and the backup operator as
secondary. Automated routing below is required configuration, not functionality
this document has enabled. Sentry receives reported failures when `SENTRY_DSN`
is set; informational performance/cost events are JSON logs.

| Signal | Initial pilot trigger | Response / collection |
| --- | --- | --- |
| Checkout blocked or incorrect fee | Any confirmed app-related occurrence | Immediate response; contain the offer and inspect the Function/version/configuration. This needs merchant reports and checkout smoke checks as well as backend alerts. |
| `protection_price_unmatched` | Investigate the first new occurrence; urgent at 3 distinct affected orders in an hour | Sentry alert. Repeated events can result from retries, so group by shop/order and verify Shopify amounts. |
| `webhook_terminal` | Any new terminal failure | Sentry alert; identify affected order and recover/verify it. The merchant is not warned about single-order failures, so this alert is the only signal. |
| `reconciliation_order_failed`, `refund_recheck_failed` | Same order failing on repeated turns | Sentry alert. Reconciliation queued the order as a `RECONCILE` delivery and moved on; its final failure also raises `webhook_terminal`. |
| `worker_loop_failed`, `reconciliation_failed`, `shopify_graphql_failed` | Repeated failures over 10 minutes, or immediately if ingestion stops | Sentry/log alerts; inspect access, API costs, and database resources. |
| Oldest pending/processing delivery | Over 5 minutes normally; over 30 minutes after a peak burst ends | Read-only database polling/manual pilot review. No automatic backlog-age monitor exists in the repo. |
| Reconciliation freshness | Over 30 minutes after backfill; escalate at 60 minutes | `order_sync_behind` (Sentry alert): the worker reports each installed shop whose last completed window is over 30 minutes old, at most every 10 minutes per shop, with `shopId` and `minutesBehind`. Also `Shop.orderReconciliationSince` and completed-window evidence. Dashboard warns the merchant only when the last completed sync is over 1 hour old. A dead worker sends nothing, so pair this with the worker Cron monitor. |
| Worker liveness | Sentry Cron monitor misses check-ins (about 10 minutes) | `SENTRY_WORKER_MONITOR` on the worker service. The worker checks in about once a minute, but only while every delivery loop and the reconciliation loop have ticked in the last 3 minutes, so one hung loop is caught. It cannot see a loop that is running but making no progress; for that use queue/cursor progress below. |
| Web uptime | `/healthz` fails (503 or no response) | Sentry Uptime Monitoring (or another external pinger) on `https://<web domain>/healthz`. Railway's health check only gates deploys and restarts. |
| Overview latency | p95 `overview_loaded.durationMs` over 2 seconds at representative volume | Log aggregation or a recorded staging measurement; inspect row counts/database load. |
| API capacity | Sustained low `currentlyAvailable` with increasing queue age | `shopify_graphql_cost` logs, including requested/actual cost and restore rate; reduce pressure or revise queries. |
| Refund / attribution quality | New unresolved refund or paid purchase attribution issue | Dashboard notices and tenant-scoped records; verify against Shopify before using totals. |

**To do: Sentry alert rules (noted 2026-10-01, for the final monitoring pass).**
Every report of one event name (for example `webhook_terminal`) shares a message,
so Sentry groups them into a single issue. Its default rule notifies only when an
issue is first created, so after the first failed order later ones would go
unnoticed.

- [ ] For each Sentry-alerted signal in the table above, create an alert rule on
  event frequency (for example "more than 0 events in 1 hour", filtered by the
  event's message), not only "a new issue is created".
- [ ] Confirm `SENTRY_WORKER_MONITOR` is set on the production worker service to
  the Cron monitor's slug, then stop the worker in staging and confirm the missed
  check-in alert reaches the operator.
- [ ] Confirm the Sentry Uptime monitor on `/healthz` alerts the operator (for
  example by pointing a staging monitor at a stopped web service).
- [ ] Rehearse in staging: force one terminal delivery failure twice, on two
  different orders, and confirm both notify the operator.

For manual diagnostics, use the production Supabase SQL editor or an approved
read-only connection. Replace the shop domain with the **verified incident
tenant** in every query. The following examples select operational IDs/counts,
not sessions, access tokens, checkout tokens, or customer data. Run them as a
read-only transaction with a timeout; do not schedule them on every request.

```sql
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '5s';

-- Establish the tenant and inspect completed vs. in-progress scan state.
SELECT id, "installationState", "orderHistoryStartAt",
       "orderReconciliationSince", "orderReconciliationUntil",
       ("orderReconciliationCursor" IS NOT NULL) AS scan_in_progress,
       NOW() - "orderReconciliationSince" AS completed_window_age
FROM "Shop"
WHERE "shopDomain" = 'pilot.myshopify.com';

-- A healthy queue is not established by recent web health checks.
WITH tenant AS (
  SELECT id FROM "Shop" WHERE "shopDomain" = 'pilot.myshopify.com'
)
SELECT d.status, COUNT(*) AS deliveries,
       COUNT(*) FILTER (WHERE d.status = 'PENDING'
                        AND d."nextAttemptAt" <= NOW()) AS ready_now,
       COUNT(*) FILTER (WHERE d.status = 'PROCESSING'
                        AND d."leaseUntil" <= NOW()) AS expired_leases,
       MIN(d."receivedAt") AS oldest_received_at,
       NOW() - MIN(d."receivedAt") AS oldest_age
FROM "WebhookDelivery" d
JOIN tenant t ON t.id = d."shopId"
WHERE d.status IN ('PENDING', 'PROCESSING', 'FAILED')
GROUP BY d.status;

-- Recent completed processing: inspect alongside outstanding work.
WITH tenant AS (
  SELECT id FROM "Shop" WHERE "shopDomain" = 'pilot.myshopify.com'
)
SELECT COUNT(*) AS deliveries_processed_last_hour,
       MAX(d."processedAt") AS latest_processed_at
FROM "WebhookDelivery" d
JOIN tenant t ON t.id = d."shopId"
WHERE d.status = 'PROCESSED'
  AND d."processedAt" >= NOW() - INTERVAL '1 hour';

-- New live purchase quality; keep currencies separate.
WITH tenant AS (
  SELECT id FROM "Shop" WHERE "shopDomain" = 'pilot.myshopify.com'
)
SELECT p."currencyCode", COUNT(*) AS confirmed_purchases,
       COUNT(*) FILTER (WHERE p."feeAmount" = 0) AS zero_fee_purchases,
       COUNT(*) FILTER (WHERE p."pricingCheck" = 'UNMATCHED') AS unmatched,
       COUNT(*) FILTER (WHERE p."pricingCheck" IS NULL) AS unchecked,
       COUNT(*) FILTER (WHERE p."attributionStatus" = 'UNATTRIBUTED') AS unattributed,
       SUM(p."feeAmount") AS gross_fees
FROM "ProtectionPurchase" p
JOIN tenant t ON t.id = p."shopId"
JOIN "Order" o ON o.id = p."orderId" AND o."shopId" = p."shopId"
WHERE p."purchasedAt" >= NOW() - INTERVAL '24 hours'
  AND o."isTest" = false
GROUP BY p."currencyCode";

-- Pending refund data quality, bounded to recent records.
WITH tenant AS (
  SELECT id FROM "Shop" WHERE "shopDomain" = 'pilot.myshopify.com'
)
SELECT r.status, r."currencyCode", COUNT(*) AS refunds
FROM "ProtectionRefund" r
JOIN tenant t ON t.id = r."shopId"
JOIN "Order" o ON o.id = r."orderId" AND o."shopId" = r."shopId"
WHERE r.status IN ('PENDING', 'UNATTRIBUTED')
  AND r."updatedAt" >= NOW() - INTERVAL '7 days'
  AND o."isTest" = false
GROUP BY r.status, r."currencyCode";

COMMIT;
```

No tenant row means stop and correct the domain/context. Empty result sets for
other queries can be normal when there is no qualifying activity. Age of
`FAILED` rows describes historical outstanding incidents, not queued work.
The 24-hour purchase query is an operational check in UTC, not the merchant-local
financial report. Recovered historical purchases can have null pricing checks
or attribution; investigate rather than assigning current settings retroactively.

## 8. Pilot activation and first week

### Before activation

- [ ] Repository blockers are resolved against the release SHA; all enabled
  locale copy and actual configured benefits match approved pilot terms.
- [ ] Production installation/distribution and platform capability checks pass.
- [ ] Merchant-approved price replaces the 0.25% placeholder; rule/version is
  recorded and a final Shopify checkout verifies the charge.
- [ ] Merchant owns the customer promise, keeps the agreed revenue, and pays
  claims for this pilot. Any alternative arrangement is reviewed separately.
- [ ] Claims contact, handling window, evidence process, refund policy, and
  customer terms reference are agreed without promising automated intake.
- [ ] Coverage does not sell or restrict remedies customers already have under
  the product/legal boundary; customer wording has appropriate legal review.
- [ ] Manual payout-cost tracking is ready: order, benefit/category, type, amount,
  currency, payer, payment date, staff member, and external reference. Keep store
  responsibility separate; agree replacement valuation before recording it.
- [ ] Restore, shutdown, and compatible version rollback have been rehearsed.
- [ ] Production web/worker versions, migrations, pool limits, and alerts are
  verified; initial reconciliation progress/completeness is known.
- [ ] Merchant and release operator are available during a quiet launch window.

Activate one merchant first. Add/save the checkout block and enable Shop Pay
placement if used. Setup health marked Active does not establish visibility.
Verify the first few protected and unprotected paid orders promptly against
Shopify. Pause the offer if checkout safety or fee correctness is uncertain.

### Daily review during the first week

Record a dated review of backlog age, terminal failures, reconciliation freshness,
pricing quality, database resources, and dashboard latency. Compare a sample of
purchases/refunds to Shopify and follow every unexplained discrepancy through
to resolution. Keep test orders and controlled live smoke orders identifiable.

Review eligible paid orders, protected orders, attach rate, gross fees, protection
refunds, manual claim/payout counts and costs by currency. Current attach rate
uses eligible orders as the denominator; checkout exposure is not measured.
The Overview's Claims paid remains zero until payout recording is implemented,
so its net revenue does not establish profitability. Combine the manual payout
ledger with revenue/refunds before evaluating the pilot price.

At the end of the week, record measured peaks, backlog drain time, API cost,
backfill duration, support incidents, and price/benefit findings. Use these to
revise operational targets and decide whether to continue or expand the pilot.
Do not infer readiness for unrelated merchants from a single successful order.
