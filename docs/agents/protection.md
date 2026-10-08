# Protection extensions, pricing, and purchases

Read when changing the checkout offer, Cart Transform, protection setup, pricing, or purchase records.

[Back to root instructions](../../AGENTS.md). Related: [Capability resolution](merchant-configuration.md); [order ingestion and idempotency](orders-webhooks.md); [legal benefit boundaries](legal-product.md).

## Keep Shopify extensions thin

Customer-facing and Admin UI extensions should mainly handle:

- rendering
- collecting user input
- displaying already-resolved configuration
- calling authenticated backend routes where supported
- executing Shopify Function logic where execution must occur on Shopify infrastructure
- emitting non-authoritative analytics events

Do not place the following in browser/extension code:

- secrets
- Admin API access tokens
- privileged Shopify mutations
- claim decision logic
- sensitive merchant rules
- cross-tenant logic
- direct database access

Shopify Functions are a special case: logic that must execute inside Shopify Functions should remain there.

Do not incorrectly move Function-runtime logic into the web backend.

## Shopify Protection Strategies

The application must support more than one way of attaching or presenting protection.

Current extension directories include:

```text
extensions/
├── insurance-ext
└── shipping-protection-transform
```

Keep these as separate Shopify extensions when they represent genuinely different Shopify extension/function environments.

Do not create an artificial generalized extension framework.

Common logic should be shared only where Shopify execution constraints allow it.

### Implemented: Checkout UI + Cart Transform (`CHECKOUT_UI_CART_TRANSFORM`)

- Setup creates an unlisted Shipping Protection product with one $0.00 variant.
- The checkout block (`insurance-ext`) lets the customer add that variant.
- The block offers protection before an address or delivery option is selected and while shipping rates reload. Eligible buyer selections survive those reloads. Disabled configuration, subscriptions, no shippable merchandise, zero fees, and direct store pickup require removal even while delivery is pending. Add, update, and remove permissions are checked separately; losing add or update permission does not remove eligible selected protection.
- The block shows the fee as the order summary lists it, before discounts. Without an order-level discount it adds each line's listed discounts back to its total. Checkout takes each line's share of an order-level discount off the line total without listing it on the line (seen live 2026-10-08), so with one the block reads variant prices for the buyer's country from the Storefront API (`api_access`) and multiplies by quantity; B2B price lists and prices changed by another app's Cart Transform are not reflected. A failed lookup is retried after 250 ms and 1 second. Until prices load, or once those attempts fail, no new offer is shown and a selected protection line stays, labelled "Shipping protection unavailable", so the buyer can still remove it. A selected line then shows the quote only when it falls between the line's total and that total plus the order discount.
- Existing protection stays visible at its actual cart fee until removal is confirmed. Ineligible carts show a removal control and status instead of the purchase offer; when Shopify disallows removal, the control is disabled with an explanation. Selection and reconciliation share a serialized mutation runner, which reads current cart IDs for each operation. Unchecking removes every protection line sequentially. Failed actions get three automatic attempts (immediate, then 250 ms and 1 second after failures) and a localized Retry control. Relevant contract/cart/capability changes reset the budget; obsolete timers are cancelled. Successful calls wait for cart updates before further cleanup. These failures never block checkout.
- The Cart Transform Function (`shipping-protection-transform`) prices it from the `function-configuration` metafield: rate in basis points, applied to shippable merchandise before discounts. The fee is charged once per cart, on the first single-unit protection line, and any other protection line is priced at zero. When no line has a single unit, the first line is charged the fee per unit rounded up at the currency's precision, so increasing protection quantity through the Cart API cannot reduce the total below the fee (decided 2026-10-07). For example, a $0.25 fee over three units becomes $0.09 each, totalling $0.27. The checkout block resets the quantity to one before payment, so this only reaches an order through a path that skips the block, such as an express checkout. Ingestion compares the total charged across protection lines with the single-unit fee and flags a rounding difference as unmatched.
- A cart or order line is protection only when its variant is the protection variant (on one of the shop's `PricingRule` rows, for ingestion). The `_yasas_protection_*` line properties are customer-editable: use them to attribute a protection line to its rule, never to decide that a line is protection. Setup publishes a new rule version whenever repair replaces the product or variant.
- The checkout block needs Shopify Plus; Cart Transform price updates need the shop's `updateOperation` eligibility (Plus or development stores).
- Checkout requires manual opt-in. Displayed selection follows the actual cart line. Settings can customize checkout copy; see [checkout offer configuration](merchant-configuration.md#checkout-offer).
- The merchant must still place the block in the checkout editor. The app cannot verify placement, so "Active" in the Admin means setup checks pass, not that customers see the block.

Remember:

- Function execution occurs on Shopify infrastructure
- do not assume arbitrary runtime access to the backend
- provide Function-required configuration using Shopify-supported inputs/metafields
- the Function runs on every cart, including carts without protection; the Cart Transform goes live when setup runs, not when the block is placed

`blockOnFailure` is `false` (decided 2026-09-30): a Function error never blocks checkout. The protection line then keeps the variant's own price, $0.00 by design: a failure gives protection away free rather than charging the customer a price they weren't shown. The safeguard is the alert below, since a Function failure is usually repeated (a bad deploy or config affects every cart) rather than one-off; if it fires, fix or roll back the Shopify app version. The Function still sets price 0 explicitly whenever a protection line shouldn't be charged (protection disabled, no shippable merchandise, mixed currencies), and leaves the line unchanged only when its configuration is unreadable. Ingestion records `ProtectionPurchase.pricingCheck` (`MATCHED` when the fee equals the attributed rule's rate in the customer's currency) and emits `protection_price_unmatched` for paid orders that weren't charged the live price; the Overview shows the count. When the order has a selling plan (subscription), Shopify skips the Cart Transform, so protection is never charged: the order gets no `ProtectionPurchase` and does not count as protected, with no alert (decided 2026-10-06; the checkout block already hides the offer then). A good-faith transform failure on other orders still counts as protected (decided 2026-10-01). Setup replaces an existing blocking transform, because Shopify cannot update the flag in place.

### Theme/storefront strategy

Provide a non-Cart-Transform path when needed.

Possible mechanisms depend on the final product implementation.

Keep this adapter separate from core protection business logic.

## Protection Pricing

Protection pricing may be:

- percentage of order/cart value
- fixed fee
- merchant-configured rate
- tiered by order value

Pricing must be deterministic and auditable.

Store enough information with each completed protection purchase to reconstruct how the price was calculated.

Recommended historical information includes:

- pricing rule ID
- pricing version
- protection rate
- calculated protection amount
- order/cart basis
- currency
- experiment identifier where applicable

Never rely solely on current merchant settings to explain a historical charge.

Current conventions:

- Rates are stored as integer basis points (`PricingRule.rateBasisPoints`, the Function configuration, and `ProtectionPurchase`), so fees stay integer-exact.
- Merchants enter and see rates as plain percentages ("1" means 1%, at most two decimal places). Convert only at the Admin UI boundary with `percentToBasisPoints` / `basisPointsToPercent` in `app/pricing-contract.js`; never show basis points to merchants.
- Changing the rate publishes a new `PricingRule` version. It applies to new checkouts only; past orders keep the rule they were charged under.
- Setup, rate changes, and turning protection off run one at a time per shop (`withShopSettingsLock`, a lease on `Shop.settingsLockedUntil`), because each publishes configuration to Shopify and then records it locally.
- Turning protection off sets `enabled: false` on both Shopify configurations in one atomic write before saving the merchant setting. The block hides the offer and removes protection lines where allowed; the Function prices remaining protection lines at zero. Preserve the product and historical pricing rules. Turning protection back on runs setup at the saved rate. Matching published pricing rules are reconciled even while off, so an interrupted rate save does not restore an older rate.

## Protection Purchase Model

A `ProtectionPurchase` or equivalent should represent protection successfully purchased for an order.

Potential fields include:

- id
- tenant/shop ID
- local order reference
- Shopify order ID
- protected amount
- protection fee
- currency
- pricing rule/version
- protection type(s)
- purchase timestamp
- status
- refunded amount
- strategy/source
- metadata where justified

Use database constraints to prevent accidental duplicates.

Do not infer completed protection purchases solely from frontend analytics.
