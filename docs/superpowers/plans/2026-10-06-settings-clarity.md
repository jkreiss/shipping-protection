# Settings clarity and rate editing implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement these tasks inline. The user has authorized implementation; preserve the separate audit worktree.

**Goal:** Simplify merchant settings and let the app operator control rate editing per store.

**Architecture:** Add a default-true permission to `ShopConfiguration`, expose it through the existing configuration resolver, and enforce it inside the rate publishing service. A private operator CLI changes this permission using the same per-shop settings lock as rate publishing.

**Tech stack:** JavaScript/JSX, React Router, Polaris web components, Prisma/PostgreSQL.

**Spec:** The user requested clearer setup wording, checkout block placement help, removal of product editing and Requirements, and operator-controlled rate editing for individual stores.

## Constraints and review focus

- Tenant identity for merchant actions comes from the authenticated Shopify session.
- The permission must be enforced on the server; merchant form fields cannot override it.
- Preserve current editing access by default and historical pricing records.
- Setup updates must preserve an operator's restriction and the current rate.
- Operator changes and rate publishing must serialize through the same shop lock.
- Healthy setup should have no update button; setup readiness does not verify block placement.
- Unknown stores and invalid CLI arguments must cause no configuration writes.

## Task 1: Per-store permission

Files: `prisma/schema.prisma`, `prisma/migrations/20261006010000_merchant_rate_editing/migration.sql`, `app/merchant/resolve-configuration.js`, `app/shipping-protection.server.js`, and their tests.

Interface: `ShopConfiguration.protectionRateEditable` is a required boolean defaulting to true. `resolveConfiguration` exposes it; `activatePricingRule` rejects restricted stores before publishing to Shopify.

- [x] Add and run failing tests for restricted and allowed rate changes, missing permission, and configuration resolution.
- [x] Add the column/migration and server authorization check.
- [x] Verify setup preserves the restriction and existing rate.
- [x] Run the focused tests and generate the worktree's Prisma client.

## Task 2: Operator command

Files: `scripts/set-rate-editing.js`, `app/merchant/rate-editing.server.js`, `app/merchant/rate-editing.server.test.js`, `package.json`, `README.md`, `docs/agents/merchant-configuration.md`.

Interfaces: `setProtectionRateEditing(shopDomain, editable, { database })` scopes the write to an installed store and uses `withShopSettingsLock`. `npm run merchant:rate-editing -- store.myshopify.com locked|editable` runs with trusted operator database credentials.

- [x] Add failing tests for store isolation, invalid input, unknown stores, lock contention, and existing configuration preservation.
- [x] Implement the setter and CLI; document deployment migration and usage.
- [x] Run the focused tests and CLI invalid-input check without database access.

## Task 3: Merchant settings

Files: `app/routes/app.settings.jsx`, `docs/agents/admin-ui.md`, neutral setup messages in the existing service/resolver.

- [x] Remove product editing and Requirements; show checkout placement help.
- [x] Hide healthy setup actions; label existing setup recovery "Update protection setup".
- [x] Render the current rate as text for restricted stores, with no rate form.
- [x] Validate Polaris markup and run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build`.
- [x] Review the complete diff and leave the branch isolated for the user's review.


## Verification record

- Full suite: 291 tests passed across 30 files; lint and required app/extension/E2E type checks passed.
- Production build passed; Polaris components validated on the extracted Settings component. The full-route validator could not resolve the server SDK, so repository type checking verified that route integration.
- PostgreSQL 16: applied the previous schema, seeded two existing stores, applied the new migration, and verified their default editing access. The actual operator CLI passed isolation, lock contention, lock/unlock, unknown-store, and pre-setup checks without changing the active pricing rule. The disposable container was removed.
- Independent read-only review found no critical, important, or minor issues. Its missing-rule recovery observation led to one fix: setup now preserves the validated published rate when a database pricing rule needs recovery. The regression test failed at 25 basis points before the fix and passed at the existing 40 afterward; the full suite passed again.
- Permission changes reach already-open pages on reload or the next settings response; every rate submission checks the current server permission. The existing settings lease is reused. Actual Shopify checkout appearance was not tested in a live browser.
- Implementation was developed on `chore/settings-clarity`; no live database configuration was changed during verification.

## Integration verification

- Integrated the already-merged security and protection-scope changes from main (`e2934e7`). Preserved the coverage restriction test and the distinction between setup readiness and block placement.
- Recovery now prefers the live Cart Transform rate when the database rule is missing and the published copies differ. The regression reproduced a reset from 80 to 40 basis points before the fix and passes at 80 afterward.
- Combined suite: 321 tests passed; lint, the Settings no-nested-ternary check, and required type checks passed. Independent integration review found no meaningful regressions.
