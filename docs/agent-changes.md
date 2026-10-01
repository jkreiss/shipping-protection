# Agent changes: security and reliability audit (2026-10-01)

A handoff for the next agent session. It records what one Claude Code session changed, why, what's still open, and what a human must do outside the code.

## Where the work is

- **Branch:** `fix/audit-reliability`, 10 commits on top of `main` at `6b49619`, pushed to `origin`.
- **Worktree:** `/Users/jasonkreiss/PycharmProjects/yasas/insurance-audit-fixes`. It's a separate git worktree because **Codex works in the main folder** (`/Users/jasonkreiss/PycharmProjects/yasas/insurance`, branch `codex/staging-playwright`, with uncommitted Playwright work). Don't edit or switch branches in Codex's folder.
- **Pull request:** not opened yet; the `gh` CLI isn't installed. Open it from https://github.com/jkreiss/shipping-protection/pull/new/fix/audit-reliability. A ready description was drafted in the previous session's scratchpad (`pr-body.md`); the commit messages below carry the same content.
- **Not merged or deployed.** Merging to `main` auto-deploys staging. Production is a later fast-forward of `production` (README → Release to production).
- **Checks at every commit:** `npm test` (212 passing), `npm run lint`, `npm run typecheck` and `npm run build` all pass. Each new regression test was confirmed to fail on the old code.
- **Postgres checks:** migrations, `verify:postgres` and `verify:webhook-postgres` pass against a throwaway Postgres 17 container (port 55432, since removed).

## Commits

### 1. `ab65d68` Identify protection lines by variant, not customer-editable properties

**Problem:** ingestion (`app/order-ingestion.server.js`) treated any line carrying a `_yasas_protection_*` property as protection. Customers can set line properties (theme forms, `/cart/add.js`), so a tagged $500 product was recorded as a $500 protection fee on a "protected" order. The checkout block could also remove that product from the cart.

**Changes:**
- Ingestion: a line is protection only if its variant is on one of the shop's `PricingRule` rows. The properties are used only to attribute a protection line to its rule (`protectionAttribution`, unchanged).
- Checkout block (`extensions/insurance-ext/src/shipping-protection.js`): `protectionLines` and `eligibleMerchandiseLines` match on the configured variant only. `hasProtectionProvenance` was removed.
- `setupShippingProtection`: if repair replaced the protection product or variant, it publishes a **new rule version at the same rate** instead of republishing the old rule (whose `variantId` would no longer match orders).
- New health check `pricing-rule` ("Pricing is linked to the current protection product") in `readShippingProtectionState`. It fails when there's no active rule, or the rule's product or variant differs from the live config. **Repair setup** fixes it.
- **Behaviour change:** the legacy-metafield adoption path is retired. A shop with a schemaVersion 1 metafield and no `PricingRule` row is no longer auto-enabled; it shows the failing check until Repair setup. `getShopConfiguration` lost its `legacyReady` option.
- Docs: README (setup section) and AGENTS.md (Implemented strategy) updated.

### 2. `814725f` Keep reconciling when a single order can't be stored

**Problem:** in `reconcileOrders`, any error on one order aborted its page before the cursor saved. The shop then retried the same page forever and stopped reconciling every later order.

**Changes:**
- Each order is handled in its own try/catch. A failure is logged (`reconciliation_order_failed`, with `shopifyOrderId`), queued with the new `queueOrderRefresh` (`app/webhook-inbox.server.js`), and skipped.
- `queueOrderRefresh` upserts a `WebhookDelivery` with topic `RECONCILE` and `webhookId = reconcile:<orderId>:<updatedAt>`. That makes it deduplicated, and the worker retries it with backoff. The worker doesn't check topics.
- Three consecutive failures (`MAX_CONSECUTIVE_ORDER_FAILURES`) rethrow and keep the cursor, since that means Shopify or the database is down. A failing queue write also rethrows.
- The result object and the worker's `reconciliation_completed` log gain `ordersFailed`.

### 3. `3dcab61` Recheck only pending refunds, rotating through them

**Problem:** every reconciliation turn refetched the same 20 orders with `PENDING` or `UNATTRIBUTED` refunds. `UNATTRIBUTED` is often permanent (for example a shipping-only refund on a protected order), so genuinely pending refunds were never rechecked.

**Changes:** only `PENDING` refunds are polled, `updatedAt` ascending, each at most once per 10 minutes (`RECONCILIATION_INTERVAL_MS`). Re-storing an order bumps `ProtectionRefund.updatedAt`, which rotates the queue. A failing recheck logs `refund_recheck_failed`, bumps `updatedAt`, and continues.

### 4. `68a7e28` Stop fetching and storing checkout-token hashes

**Problem:** nothing read `Order.checkoutTokenHash`, yet a missing or short `CHECKOUT_TOKEN_HASH_SECRET` made every order fail ingestion.

**Changes:**
- Removed `hashCheckoutToken`, all `hashSecret` parameters, and `checkoutToken` from `ORDER_FIELDS`.
- Updated the verify scripts, CI env, `.env.example`, README and the runbook.
- Migration `20261002000000_clear_checkout_token_hash` sets existing hashes to NULL. The column stays for now (marked unused in `schema.prisma`) so old containers keep working during the deploy.
- The user chose removal; it can be re-added if checkout-funnel analytics is built.

### 5. `47964e5` Warn merchants only when order sync stalls; note Sentry alert rules

- The Overview's "Order sync is behind" now means only that the last completed sync is over 1 hour old (`app/analytics.server.js`). The count of failed deliveries was removed. The user decided single-order failures are an operator problem, not the merchant's.
- `docs/production-readiness.md` section 7 gained rows for `reconciliation_order_failed` and `refund_recheck_failed`, plus a **to-do for Sentry alert rules**. Each event name groups into one Sentry issue, and the default rule fires only on new issues, so frequency-based rules are needed. The user will set up all Sentry rules in a final monitoring pass.

### 6. `1faa611` Drop unused metaobject access scopes

`write_metaobjects` and `write_metaobject_definitions` were removed from `shopify.app.toml`, `shopify.app.staging.toml`, `shopify.app.production.toml`, `shopify.app.staging.toml.example` and `.env.example`. Nothing used them; the config is an app-owned `$app` metafield. The runbook has the rollout steps.

### 7. `5e06f70` Handle app/scopes_update payloads without a scope list

`webhooks.app.scopes_update.jsx` crashed on `payload.current.toString()` when the payload had no `current` list, returning 500 so Shopify retried. The logic moved to `recordGrantedScopes` in `app/shop.server.js`, with tests in `app/shop.server.test.js`. It ignores and reports a malformed payload (`scopes_update_invalid`), and uses `updateMany` scoped to `{ id, shop }`.

### 8. `4b0ef3a` Show merchants only errors written for them on Settings

- New `app/user-facing-error.js` (`UserFacingError`).
- Merchant-facing errors in `shipping-protection.server.js` and the rate parser `percentToBasisPoints` throw it, with messages reworded in plain language.
- The Settings action shows only those messages. Anything else gets "Something went wrong and your settings weren't saved…" and is reported as `settings_action_failed`.
- Test: `app/settings-route.test.jsx`. Test files must not go in `app/routes/`, because `flatRoutes()` turns every file there into a route and breaks the build.

### 9. `fc03222` Run protection setup and rate changes one at a time per shop

**Problem:** two concurrent rate changes could leave Settings showing a rate other than the one Shopify charges.

**Changes:**
- New `withShopSettingsLock` in `app/shop.server.js`: a 5-minute lease on the new `Shop.settingsLockedUntil` column (migration `20261002000001_shop_settings_lock`, additive). It wraps `activatePricingRule` and `setupShippingProtection`.
- A concurrent change gets `UserFacingError("Another settings change is still saving…")`.
- A database advisory lock was avoided because it would hold a pooled connection across the Shopify calls.
- Checked against real Postgres: the same shop is refused, other shops aren't affected, and the lease is released afterwards.

### 10. `2646240` Apply non-breaking dependency security fixes

- `npm audit fix`, lockfile only: `qs`/`express`/`body-parser` (a `qs` denial of service reachable through `react-router-serve`), `morgan`, and dev-only `brace-expansion`/`js-yaml`.
- The remaining production advisories (`deepmerge-ts` via `prisma` → `@prisma/config`) run only in the Prisma CLI while it loads this repo's config. The Prisma client runtime doesn't include that code, which was verified. npm's suggested fix is a downgrade, so it was left alone.
- The assessment is in README and the runbook.

## Human actions after merging

From `docs/production-readiness.md`, for staging and then production:

1. Merging to `main` deploys staging; the pre-deploy step runs both migrations.
2. `npx shopify app deploy --config staging`, then `--config production`. This ships the checkout block fix (commit 1) and the narrower scopes (commit 6).
3. Set the Railway `SCOPES` variable on web and worker to `write_products,read_orders,write_publications,write_cart_transforms`.
4. Delete `CHECKOUT_TOKEN_HASH_SECRET` from Railway once the release is live on both environments. Drop the `checkoutTokenHash` column in a later release.
5. Run **Repair setup** on any shop whose Settings shows "Pricing is linked to the current protection product" failing.
6. Staging test: add a normal product with `properties[_yasas_protection_rule_id]` via `/cart/add.js` and check out. The Overview must not count it as protected, and the block must not remove it. This is a candidate for Codex's Playwright suite.
7. Sentry: frequency-based alert rules in the final monitoring pass (runbook section 7 to-do).
8. Still open from before this session: `DATABASE_URL` `connection_limit` on Railway (runbook section 3).

**Merge conflicts to expect with Codex's branch:** `package-lock.json`, `README.md` and `.github/workflows/ci.yml`. For the lockfile, keep either side, then rerun `npm install` and `npm audit fix`.

## Open: audit item 7, $0.00 protection (needs product decisions)

**Facts established:**
- The protection variant's own price is $0.00, and the Cart Transform sets the real fee. If it can't, the customer pays $0.
  - **(a) Transform failure.** This is by design (`blockOnFailure: false`). The customer saw the fee and opted in in good faith.
  - **(b) Subscription item in the cart.** Shopify's docs (Cart Transform API, "Invalid scenarios") say Shopify rejects every lineExpand, linesMerge and lineUpdate operation when a selling plan is present. That's why `cart_transform_run.js` returns no operations for those carts. The checkout block removes the protection line there (`containsSellingPlan`), but a customer can add the variant through `/cart/add.js` and check out where the block doesn't run. That could be a checkout profile without the block, and possibly Shop Pay express (unconfirmed).
- **Today** such an order is recorded as protected with fee $0, `pricingCheck: UNMATCHED`, and fires `protection_price_unmatched`. Revenue is correct, but the attach rate counts it as protected. Case (b) can also make the transform-failure alert fire falsely, and once claims exist the order would look covered.
- **Can't prevent at checkout:** Functions can't remove lines, and a validation function would block checkout, which AGENTS.md forbids.

**Decided 2026-10-01:**
1. A $0 order still counts as protected. A good-faith transform failure (a) is honoured as covered.
2. Subscription orders (b) are told apart and are not failures: `$0.00` is the intended outcome, with no alert.

**Implemented (commit 11):** `sellingPlan { sellingPlanId }` is fetched on order lines (`ORDER_FIELDS`, `LINE_FIELDS`) and normalized to `hasSellingPlan`. `livePriceCheck` returns the new `ProtectionPricingCheck.SUBSCRIPTION` (migration `20261003000000_pricing_check_subscription`, additive) when the fee doesn't match and any line has a selling plan, mirroring the Function, which skips every cart with a selling plan. `protection_price_unmatched` and the Overview's unmatched count only see `UNMATCHED`, so they stay a transform-failure signal. Tests in `order-ingestion.server.test.js` and `order-normalization.test.js`.

**Still open:** claim handling for $0 orders is deferred until claims work begins (record: entitlement wording is a product/legal question).

## Other open items

- **Optional 11:** encrypt Shopify access tokens (`Session.accessToken`) at rest in the app. This was offered but not decided. Note the trade-off: it adds a key whose loss would require every shop to reinstall, the same failure pattern commit 4 removed.
- **Audit findings judged fine:** webhook signature checks, tenant scoping via `session.shop`, idempotent webhook inbox, workers re-fetching orders from Shopify, logs and Sentry without error messages or PII, no secrets in git history.
