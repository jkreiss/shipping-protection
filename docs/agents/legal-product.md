# Legal and product boundaries

Read before changing coverage benefits, customer-facing copy, public listing text, consumer-law remedies, or who carries financial risk.

[Back to root instructions](../../AGENTS.md).

## Legal / Product Boundary

Do not casually describe the commercial product as regulated `insurance` unless legal structure has been confirmed.

Possible legal/product framing may include:

- merchant-provided shipping protection
- warranty-like protection
- contractual protection
- another model determined by legal review

This affects:

- wording
- disclosures
- liability
- licensing
- merchant agreements
- customer rights

Who carries the risk is unresolved:

- If the merchant owns the promise to the customer and pays claims, the app is software and a service provider.
- If the app provider collects fees and pays claims or return labels directly, the product may look like insurance.
- Do not build or word anything that assumes the provider carries the risk until legal advice confirms a structure.

The repository, the dev app, and the checkout extension (`insurance-ext`) use "insurance" as a working name. Customer-facing and public listing copy should say "shipping protection" unless legal review confirms otherwise.

Agents working on code must not invent legal wording or compliance guarantees.

Use neutral placeholders where product/legal decisions are unresolved.

## Markets

The initial release is for US stores (product owner decision, 2026-10-07; no legal sign-off). The default copy offers protection for stolen, damaged, and undelivered packages.

Australian stores come later and need their own wording and settings before launch there. The Australian Consumer Law rules below apply to them. They don't restrict US copy.

Setup still turns on only theft coverage (`stolenCoverageEnabled`); `lostCoverageEnabled` and `damagedCoverageEnabled` default off. Those flags don't change anything customers see yet. Align them with the copy before claims are built.

## Australian stores (later)

Australian Consumer Law rights must not be represented as being removed or replaced by paid protection.

Product rules that follow from this (legal review still required):

- Only sell benefits customers do not already have. Theft after delivery and free change-of-mind returns qualify. Loss and damage in transit, faulty goods, and not-as-described items are the merchant's existing obligation and must not be sold as protection (loss in transit confirmed 2026-10-06). Australian copy must therefore not use the US default wording.
- Customers without protection who have a consumer-law problem must be treated exactly like protected customers. Never gate those remedies behind protection, and never tell an unprotected customer they are not covered for them.
- Protection fees are the merchant's revenue, and the merchant may spend them on anything, including consumer-law remedies. Merchant-only reporting may show those costs next to protection revenue. Customer-facing wording must never suggest the fee is what funds those remedies.

## Changing customer-facing copy

Current wording (chosen by the product owner 2026-10-07 for the US release; no legal sign-off): protection covers stolen, damaged, and undelivered packages. Add free returns to the copy only once they are built (setting, claim flow, return labels), and only for stores that offer them.

Keep every surface saying the same thing. When the wording changes, update all of these together:

1. Checkout block: `extensions/insurance-ext/locales/en.default.json` (`supportingText`; `checkboxLabel` names the product).
2. Settings defaults: `DEFAULT_CHECKBOX_LABEL` and `DEFAULT_SUPPORTING_TEXT` in `app/merchant/checkout-offer.js` must match the checkout locale.
3. Protection product description: `PRODUCT_DESCRIPTION` in `app/shopify/protection-admin.server.js`. Add the outgoing text, exactly as it was, to `RETIRED_DESCRIPTIONS` so setup repair replaces it on stores that already have the product. Setup never overwrites a description the merchant wrote.
4. The repair test in `app/shopify/protection-admin.server.test.js`: add the outgoing text to the `test.each` cases and update the assertions about what the description contains.
5. The "Coverage offer" row in `docs/production-readiness.md`, and the "Current wording" paragraph above.

Wording rules:

- Say "shipping protection", not "insurance" or "coverage" as a noun for the product.
- Name only benefits the store can honour.
- For Australian stores, name only benefits customers don't already have (see [Australian stores](#australian-stores-later)). Theft is "stolen after delivery", because loss before delivery is the merchant's obligation. Return shipping is "if you change your mind", because return costs for faulty or not-as-described items are already owed under Australian Consumer Law. Never say or imply that loss, damage, faulty goods, or consumer-law remedies need protection, or that customers without it aren't covered.
- Keep the copy aligned with what the merchant has enabled. Settings allows store-specific label and supporting text through `$app.shipping_protection_offer`, subject to an independent operator editing permission. Blank fields use the defaults. Custom text is plain text (label up to 120 characters, supporting text up to 500) and applies to every checkout language. The price is always rendered beside the label. Authorized copy editors can use any wording, punctuation, and line breaks; the server does not require a phrase or block benefit terms. Markup is displayed as literal text. This editing freedom does not change the enabled benefits or establish that the custom copy is accurate. The protection product description uses the same wording as the checkout default, and setup preserves merchant-authored descriptions.

Checkout locale changes only reach customers after `shopify app deploy`; the product description changes on each store the next time setup or repair runs.

Run `npm test`, `npm run lint`, and `npm run typecheck` after changing copy.
