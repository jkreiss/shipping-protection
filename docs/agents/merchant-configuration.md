# Tenant identity, configuration, and capabilities

Read when accessing merchant-owned data or changing settings, feature eligibility, or attachment strategies.

[Back to root instructions](../../AGENTS.md). Related: [Database and tenant security](data-security.md); [protection setup and runtime constraints](protection.md).

## This is a multi-tenant application

All merchant-owned data must be tenant-scoped.

A merchant must never be able to read or mutate another merchant's:

- configuration
- orders
- protection purchases
- claims
- returns
- analytics
- customer references
- audit history
- integrations

Use an authenticated Shopify installation/session to establish tenant identity.

Never trust a `shopId`, shop domain, claim ID, order ID, return ID, or other tenant-sensitive identifier supplied by a client without verifying ownership.

Prefer database access patterns that make tenant scoping explicit.

## Configuration drives behavior

Do not create separate application versions for different merchants.

Merchant behavior should be derived from:

```text
Shopify/platform capability
        ∩
capability supported by this application
        ∩
merchant-enabled configuration
        =
effective merchant capability
```

The implementation may expose a concept such as:

- `MerchantConfiguration`
- `MerchantCapabilities`
- `ResolvedMerchantConfiguration`
- `ResolvedCapabilities`

Use terminology that fits the existing codebase.

Do not model all platform behavior around a single boolean such as:

```ts
isShopifyPlus
```

Different Shopify capabilities have different eligibility requirements.

Check the actual capability required for a feature.

## Merchant Configuration

Merchant configuration should be capable of representing the merchant's desired product behavior.

Potential configuration areas include:

### Protection benefits

Benefits must be things customers do not already have under Australian Consumer Law (see [Legal / Product Boundary](legal-product.md#legal--product-boundary)):

- theft protection (stolen after delivery)
- free change-of-mind returns
- lost-in-transit protection: pending legal review, because it may already be the merchant's responsibility
- damaged, faulty, or not-as-described: never offered as a protection benefit

Merchants choose which benefits their store offers (for example, theft only, or theft plus free returns).

`ShopConfiguration` currently has `stolen`, `lost`, and `damaged` coverage flags, and setup enables all three. That predates this direction; revisit it before claims work begins.

### Returns

- returns enabled
- free returns enabled
- return window
- return rules
- return label behavior

### Pricing

`ShopConfiguration.protectionRateEditable` is an operator-controlled permission
that defaults to true. `resolveConfiguration` exposes it, Settings hides the rate
form when false, and `activatePricingRule` enforces it on the server before any
Shopify pricing publication. Merchant form fields must never change this
permission. `npm run merchant:rate-editing -- store.myshopify.com locked|editable`
sets access for one installed store from a trusted operator shell with database
credentials. Operator access changes use the same per-shop settings lock as rate
publishing. Setup updates preserve the permission and the existing rate.

### Checkout offer

`ShopConfiguration.protectionCopyEditable` is an operator-controlled permission,
defaulting true. `protectionCheckboxLabel` and `protectionSupportingText` are
nullable plain text, where null uses the checkout defaults. Resolve the
copy editor permission in `resolveConfiguration` and enforce it in
`updateCheckoutOffer` before Shopify publication. Merchant form fields cannot
grant editing access.

`npm run merchant:checkout-editing -- store.myshopify.com pricing|copy locked|editable`
sets one editing permission using the per-shop settings lock. It preserves all
saved offer settings and rejects unknown or uninstalled stores.

Offer updates use that same lock and Shopify compare-and-set to publish the
separate `$app.shipping_protection_offer` Shop JSON metafield, then mirror the
accepted values locally. A valid published offer is used when reading Settings
and when merging subsequent updates, so an interrupted local save does not
revert what customers see. Pricing/setup publication does not touch this
metafield. Authorized editors can use any wording, punctuation, and line breaks
as literal plain text (label up to 120 characters, supporting text up to 500).
There is no required phrase or blocked-word list. Blank fields restore defaults;
unsupported control characters are rejected. The fee cannot be removed by
copy editing. Follow
[legal copy rules](legal-product.md#changing-customer-facing-copy).

Potential pricing models for future work:

- fixed fee
- percentage
- order-value tiers
- min/max fee
- currency-specific configuration
- pricing version

Pricing likely needs to differ by benefit set. Free returns cost far more per order than theft protection (a return label can cost as much as dozens of orders' fees at a low percentage), and customers who expect to return items are more likely to opt in.

### Claim intake

Possible methods:

```text
EMAIL
FORM
SHOPIFY_ADMIN
API
```

Configuration may include:

- email intake enabled
- form intake enabled
- Admin-created claims enabled

### Automation

Possible settings include:

- auto-approval enabled
- maximum automatic resolution value
- eligible claim types
- claim-window configuration
- evidence requirements
- risk thresholds
- AI-assisted review enabled

### Protection attachment/storefront strategy

The `ProtectionAttachmentStrategy` enum currently has:

```text
CHECKOUT_UI_CART_TRANSFORM   implemented
THEME_CART                   not implemented
NONE
```

Add new strategies with names that match the mechanism actually implemented.

Do not assume strategies have identical Shopify eligibility requirements.

## Resolved Capabilities

Raw merchant configuration is not necessarily equivalent to what the application can execute.

The one trusted place that resolves effective capabilities is `resolveConfiguration` in `app/merchant/resolve-configuration.js`.

It combines:

- merchant settings (`ShopConfiguration`)
- observed Shopify capabilities (`observedShopifyCapabilities`: checkout UI support and Cart Transform update eligibility)
- what the app implements (`IMPLEMENTED_CAPABILITIES`)
- protection setup health checks

It returns the effective strategy, whether protection is enabled, rate-editing permission, human-readable reasons when it is not enabled, coverage flags, and returns/claim-intake/auto-approval availability.

Extend that function rather than duplicating capability resolution in routes or extensions.
