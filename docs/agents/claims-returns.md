# Cases, claims, and returns

Future direction only: read when maintaining existing claims or planning later case/return work. Follow the current shipping-protection scope in the root AGENTS.md.

[Back to root instructions](../../AGENTS.md). Related: [Intake](claims-intake.md); [decisions and resolution](claim-automation.md); [payout accounting](analytics-payouts.md); [legal boundaries](legal-product.md).

## Customer requests should normalize into one model

Customer requests (claims, return requests, and problems the store must handle itself) may enter the application from multiple sources.

Possible sources include:

```text
EMAIL
FORM
SHOPIFY_ADMIN
AUTOMATED
API
```

All supported sources should normalize into the same underlying case model (see [Cases, Claims, and Returns](#cases-claims-and-returns)).

Do not implement separate incompatible models for:

- email requests
- form requests
- Shopify Admin requests
- automated requests

Prefer:

```text
Email intake --------\
Form intake ----------\
Shopify Admin ---------> normalize -> Case -> claim and/or return, or store responsibility
Other integration ----/
```

Intake must not force a claim-or-return choice up front. The request's reason is often unknown until it is read.

Source-specific parsing belongs at the edge.

Claim eligibility and decision logic belongs in shared application/domain code.

## The application owns claims and tickets

Do not treat Shopify itself as the canonical claims-ticket database.

The app database should remain the source of truth for:

- claim identity
- status
- evidence references
- decision history
- review state
- resolution state
- audit history

Shopify should be integrated through references and Admin UI surfaces.

Useful Shopify-native integrations may include:

- Admin blocks
- Admin actions
- order-linked claim information
- app pages
- metafields where appropriate
- order tags where appropriate

Do not misuse Shopify Returns as a generic claim-ticket system.

## Cases, Claims, and Returns

Direction only; not current work (see [Current Focus](product-roadmap.md#current-focus)).

From the customer's side, every problem is one request. The merchant should see one queue and one record per problem, each clearly labelled:

- **Covered by protection:** the request matches a benefit this store sells, and the protection was purchased
- **Store's responsibility:** damaged in transit, faulty, not as described, or change of mind at a store without free returns. The merchant handles it under their own policy and Australian Consumer Law; the app records it and helps, but does not decide it or pay for it.

```text
Case  (every incoming request: source, order, customer message, reason, status)
 ├─ Protection claim     only when the order is protected and the reason matches a sold benefit
 │   ├─ Theft            -> reship or refund; nothing comes back
 │   └─ Free return      -> approved claim creates a return (item comes back at no cost)
 └─ Store responsibility -> merchant handles; excluded from protection costs
```

Keep these distinct:

- a **Case** is intake and tracking. It must not require a protection purchase: unprotected orders with problems still need a record.
- a **claim** is the entitlement decision: did this customer's protection entitle them to this?
- a **return** is logistics: label, in transit, received, refunded or exchanged. It can map to Shopify Returns. An approved theft claim needs no return.

One Admin page with a filter on covered / store responsibility is preferred over separate pages.

The current schema predates this direction: `Claim` requires `protectionPurchaseId`, and `ClaimType` is `LOST | STOLEN | DAMAGED`. Revisit both before building intake.

### Claim fields

Potential claim fields include:

- id
- tenant/shop ID
- order reference
- Shopify order ID
- fulfillment reference where relevant
- protection purchase reference
- claim source
- claim type
- description
- evidence references
- tracking snapshot/reference
- status
- decision status
- decision reason
- risk flags
- AI analysis summary
- merchant decision
- resolution type
- resolution amount
- replacement reference
- createdAt
- updatedAt
- resolvedAt

Claim types should follow the benefits a store can sell (for example theft and free return), not every reason a customer might write in.

Possible claim workflow states may include:

```text
SUBMITTED
VALIDATING
AUTO_APPROVED
REVIEW_REQUIRED
MERCHANT_APPROVED
MERCHANT_REJECTED
RESOLUTION_PENDING
RESOLVED
```

Do not create enums merely because they appear in this document.

Use only states required by actual workflows.

## Returns

Returns are logistics, and they have two origins:

- a free change-of-mind return is a protection benefit: an approved claim creates the return
- any other return (paid returns, faulty items) is the store's responsibility and must not be gated behind protection

The system may eventually support:

- merchant-configured return windows
- free returns
- paid returns
- return eligibility
- return labels
- return status
- return-related customer intake
- return-linked Shopify actions

Avoid designing return rules around one merchant's process.

Use configuration.

Do not assume Shopify's native Returns data model alone represents all app-owned workflow state.
