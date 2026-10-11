# App Store listing draft

Copy for the Partner Dashboard submission form (**Distribution → Shopify App Store listing**). Character limits come from Shopify's [listing best practices](https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices); the form enforces them too. Wording follows [Legal/product boundary](agents/legal-product.md): it says "shipping protection", never "insurance", and has no legal sign-off yet.

Listing rules that shaped it: no statistics or guarantees anywhere, no pricing outside the Pricing section, no Shopify logos in images, and the requirements (Shopify Plus, US) must be stated ([App Store requirements 4.2–4.4](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)).

## Before submitting

- **Pick a brand name.** Requirement 4.1.2 needs a unique name that leads with a distinctive identifier, so "Protection" on its own is likely to be rejected. Use the same name in `shopify.app.production.toml` (`name`), because requirement 4.1.1 needs the two to match. `[Brand]` below marks where it goes.
- **Host the privacy policy** at a public URL on a dedicated page, not a shared cloud document.
- **Get the checkout and listing wording legally reviewed**, as the product roadmap requires before a public listing.

## Basic details

| Field | Copy |
| --- | --- |
| App name (30) | [Brand] Shipping Protection |
| App card subtitle | Sell optional shipping protection at checkout, keep the fees |
| App introduction (100) | Offer buyers optional shipping protection at checkout, and earn revenue from orders that add it. |
| Pricing | Free |
| Languages | English |
| Integrations | None |
| Support email | kreissjason@gmail.com |
| Privacy policy URL | [hosted policy URL] |

## App details (500)

> Add a shipping protection checkbox to your Shopify checkout. Buyers who want protection for stolen, damaged, or undelivered packages tick the box, and the fee is added to their order. Nothing is preselected, and the price is shown beside the checkbox. You set the rate as a percentage of the order and can change the checkbox wording. The fee is your revenue, and you decide how to handle claims with your customers. A dashboard shows protection revenue, attach rate, protected orders, and refunds.

## Feature list (80 each)

1. Optional checkbox in checkout with the price shown and nothing preselected
2. Set your own rate as a percentage of the order's shippable items
3. Edit the checkbox label and supporting text to match your store
4. Dashboard with protection revenue, attach rate, and protected orders
5. Refunds and cancellations of the protection fee are tracked for you

## Requirements and discovery

- **Plan requirement:** select the Shopify Plus requirement if the form offers it, and state it in the details if not. The checkout block and Cart Transform price updates only work on Plus and development stores.
- **Geography:** United States stores.
- **Sales channel:** don't select "Merchant must have online store". The app runs in Shopify checkout, not the theme.
- **Category:** the closest shipping or orders category the form lists.
- **Search terms (up to five, one idea each):** shipping protection, package protection, checkout protection, stolen package, damaged package.
- **Visibility:** limited visibility, so the app is installed by link and not shown in search.

## Media

- **App icon:** 1200 × 1200 px, no Shopify logo and no pricing.
- **Screenshots:** 3–6 at 1600 × 900 px, cropped to the app with no browser chrome, using test data only, each with alt text:
  1. Checkout with the protection checkbox and price (alt: "Shipping protection checkbox in checkout with its price")
  2. Overview dashboard (alt: "Dashboard showing protection revenue and protected orders")
  3. Settings with rate and checkbox wording (alt: "Settings for protection rate and checkout wording")
  4. An order in Shopify admin with the protection line (alt: "Order with a shipping protection line item")
- **Demo screencast (for reviewers):** install, run setup in Settings, add the block in the checkout editor, tick the box at checkout, place a test order, and show it on the dashboard.

## Testing instructions for the reviewer

> The app needs a store with checkout extensibility: a development store or a Shopify Plus store.
>
> 1. Install the app. It opens on the Overview page.
> 2. Open **Settings** in the app and click **Set up protection**. This creates the shipping protection product and pricing rule and turns protection on. The status changes to **Ready**.
> 3. In Shopify admin, open **Settings → Checkout → Configure → Edit**, add the **Shipping protection** app block (we suggest under the shipping method), and save.
> 4. Add a physical product to the cart and go to checkout. Tick **Add shipping protection**. The fee appears as a line in the order summary. Untick it to remove it. Nothing is added unless the buyer ticks the box.
> 5. Complete the order with Shopify's Bogus Gateway or a test payment method.
> 6. Back in the app, **Overview** shows the protected order and the fee. Turn on "Include test orders" to see test orders in the figures.
> 7. In **Settings**, change the rate or the checkbox wording, reload checkout, and the new price and wording appear.
>
> No login or account beyond Shopify is needed. The app has no paid plans.
