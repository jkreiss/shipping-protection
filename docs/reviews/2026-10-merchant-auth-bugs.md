# Merchant configuration, shop, and authentication findings

Disposition on branch `fix/merchant-auth-bugs`, based on section 5 of
`docs/bug-review` branch’s `docs/reviews/2026-10-bug-review.md`.
The source worktree and its notes/CI changes are preserved.

### 5. Merchant config, shop, auth
- HIGH shopify.server.js:21 — storeSession always resets shop to INSTALLED; a token refresh finishing after app/uninstalled resurrects the shop with a revoked token.
  → FIXED: token-verified, generation-checked persistence and atomic uninstall; loaders/setup/pricing cannot resurrect installations. Disposable PostgreSQL exercises both transaction orderings.
- MED checkout-offer.js:4 — DEFAULT_CHECKBOX_LABEL ends "for " (recent commit): Settings shows dangling "for "; a merchant copying it gets "…for — $4.00"; help text promises a third format.
  → ALREADY FIXED on main: retain current Settings/checkout formatting tests.
- MED configuration.server.js:28 — DUPLICATE of §3 coverage flags (already a launch blocker in docs/production-readiness.md).
  → ALREADY FIXED under section 3: retain coverage migration and setup tests.
- MED shop.server.js:127 — settings-lock 5-min lease never renewed during long setup; release error in finally masks the real error.
  → FIXED: UUID owner token, 60-second renewal of five-minute lease, transaction guards, nested API cancellation, and separately reported release failures.
- MED admin-graphql.server.js:74 — THROTTLED replies don't set shopReadyAt, so sibling loops keep hitting the throttle and burn retries.
  → FIXED: both throttle shapes, terminal retries, monotonic deadlines and sibling rechecks are covered.
- LOW checkout-offer.js:15 — validCopy allows C1 controls and bidi/zero-width chars (U+202E can visually reorder the fee text).
  → ALREADY FIXED on main: retain shared server/extension copy fixtures.
- LOW shop.server.js:5 — ensureInstalledShop upserts on every admin page load (needless writes, row-lock contention).
  → FIXED: installed reads avoid writes; only changed Shopify IDs are saved with installation guards.
- NIT checkout-offer.server.js:37 — always-true guard.
  → ALREADY FIXED on main: redundant permission guard removed.
- NIT resolve-configuration.js:17 — duplicated capability reason strings.
  → FIXED: shared capability-reason helper preserves wording and ordering.
- NIT admin-graphql.server.js:64 — loadAdminConfig re-parsed per call.
  → NO CHANGE: production returns before URL parsing; parsing only occurs for synthetic load configuration.



### PR #21 OCR follow-up

All three findings were confirmed and corrected: bounded PostgreSQL barrier
waits with guaranteed release/drain, pre-fetch installation generation carried
through pricing recovery, and one shared server Admin API version. Seven added
regression cases bring the full suite to 810 passing tests. Existing publication
recovery remains supported when the snapshot was fetched in the current
installation generation.

### PR #21 code-review follow-up

- Session storage keeps a refreshed token when verification fails transiently for an installed shop; access-lost answers, non-installed shops, and generation changes still refuse the save.
- Removed the unused `SHOP_CUSTOM_DOMAIN` option (verification only accepts `*.myshopify.com`) from `shopify.server.js`, `.env.example`, and `scripts/load/README.md`.
- Setup's rollback of a partial enable runs outside the settings lease, so it still disables the offer after the lease is lost.
- Concurrent token exchanges after one reinstall both succeed: a save one generation ahead of an uninstalled read is accepted without a second increment; any other mismatch still fails.
- `waitForShop` waits at most 30 seconds per call and only clears a deadline that has passed.
- `adminGraphql` throws the lease's error instead of a generic AbortError when the lease aborts, without reporting `shopify_graphql_failed`.
- An uninstall racing the Shopify ID update returns 401 (`InstallationAccessLostError`), not a server error.
- Session saves upsert directly instead of building a `PrismaSessionStorage` (and its table poll) inside the shop-row lock; the `delegateFactory` option is now `delegate`.
- The installation-generation migration note moved from `README.md` to `docs/production-readiness.md` section 5.3.
- Dropped: a settings-lock message after uninstall (uninstall deletes sessions, so merchants cannot reach it); `loadSession` reading the session row twice (deliberate, see its comment).
