# Shipping Protection checkout extension

This checkout block offers optional Shipping Protection at the active configured rate for eligible,
shippable merchandise before discounts. It requires Shopify Plus because it
uses checkout UI extensions and a Cart Transform line-price update.

The extension reads the app-owned Shop JSON metafield
`$app.shipping_protection_config`. The app home setup flow creates and enables
that configuration together with the unlisted product and the Cart Transform,
created with `blockOnFailure: false` so a Function error never blocks checkout.

The offer appears as checkout loads, before an address or delivery option is
selected. It stays visible while shipping rates reload after address changes.
Choosing direct store pickup hides the offer and removes any protection line
where cart-line removal is available.

The offer requires manual opt-in. Per-store Settings can customize the label
and supporting text through the separate app-owned Shop JSON metafield
`$app.shipping_protection_offer`. Setup repair, rate changes, and turning
protection off preserve these settings. The fee always appears beside the
label. Blank text uses the defaults in `locales/en.default.json`.

The offer is hidden for digital-only carts, subscriptions, direct store pickup,
zero-rounded fees, invalid configuration, or checkouts that cannot mutate cart
lines. Existing protection lines determine selection state and are reconciled
to one unit.

After deploying an app version, open Settings → Checkout → Configure → Edit,
add the block, and save. Place it directly under the block labeled
“Shipping method”. Shop Pay activation is configured separately.
