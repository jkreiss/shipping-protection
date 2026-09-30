# AGENTS.md

## Project Overview

This repository contains a multi-tenant Shopify app for merchant-provided shipping/order protection, returns, and claims management.

The product is intended to support multiple unrelated Shopify merchants from one codebase, deployment, and database. Different merchants may enable different combinations of protection, returns, claim intake, checkout/storefront integration, automation, and Shopify Admin workflows.

The application should not be designed as separate code variants per merchant.

Instead:

```text
Shopify merchant
    ->
Authenticated tenant/shop
    ->
Merchant configuration
    +
Shopify/platform capabilities
    +
App-supported capabilities
    ->
Resolved merchant capabilities
    ->
Appropriate protection / returns / claims behavior
```

The product should evolve into an automated merchant operations platform for shipping protection and returns, not merely a checkout checkbox.

---

## Current Focus

Shipping protection comes first.

Until the shipping protection offer, pricing, order ingestion, and merchant dashboard are reliable and scalable on a live, high-volume store, do not build claims, returns, or claim intake beyond what already exists. Claims and returns sections below describe the intended direction, not current work.

The first production merchant is expected to be a live store with roughly $20M in annual revenue, run as a pilot:

- the merchant keeps protection revenue and pays claims directly
- the goal is to learn real attach rates, claim rates, and payout costs so a profitable price can be set
- design and test for that scale (see Scale and Reliability)

The default rate of 25 basis points (0.25%) is a placeholder, not a considered price.

How the app provider gets paid (revenue share, profit share, or taking a larger share and paying claims directly) is undecided. Record data so that any of these can be calculated later; do not build billing for one model yet.

---

## Product Goals

The system should eventually support merchants with configurations such as:

### Example A

- theft (stolen-after-delivery) protection
- free change-of-mind returns
- Cart Transform where supported
- claims created from forwarded customer emails
- automated claim evaluation
- merchant review inside Shopify Admin

### Example B

- stolen-package protection only
- no free returns
- customer claim intake through a small form
- storefront/theme-based protection flow rather than Cart Transform

### Example C

- theft protection and free returns
- another supported protection attachment strategy
- claims created manually through Shopify Admin
- different pricing, automation, and resolution rules

These are examples only.

Do not hardcode merchant-specific branches such as:

```ts
if (shop === "merchant-a.myshopify.com") {
  // merchant A behavior
}
```

Behavior must be driven by tenant-aware configuration and capability resolution.

---

# Core Product Principles

## 1. Shopify remains the commerce source of truth

Do not treat frontend events as authoritative financial records.

Frontend or extension events may be used for funnel analytics such as:

- protection viewed
- protection selected
- protection removed
- claim started
- return started

Completed Shopify orders, refunds, cancellations, fulfillments, and verified webhook data are authoritative for:

- completed orders
- protection purchases
- protection revenue
- refunds
- order state
- fulfillment state
- claim eligibility where applicable
- return eligibility where applicable

The local application database is the source of truth for application-owned state such as:

- merchant configuration
- resolved application settings
- protection records
- claims
- claim decisions
- return workflows
- merchant review state
- audit events
- automation state

---

## 2. This is a multi-tenant application

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

---

## 3. Configuration drives behavior

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

---

## 4. Keep Shopify extensions thin

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

---

## 5. Backend owns application business logic

The trusted backend should own:

- Shopify authentication
- tenant resolution
- merchant configuration
- capability resolution
- protection configuration
- protection pricing
- protection purchase persistence
- claim creation
- claim normalization
- claim eligibility
- claim decision rules
- returns workflows
- merchant review workflows
- Shopify Admin GraphQL operations
- refund workflows
- replacement workflows
- webhook processing
- analytics aggregation
- AI-assisted analysis
- fraud/risk signals
- audit history
- integration callbacks

Route handlers should remain thin.

Do not embed substantial domain logic directly in route modules.

---

## 6. Customer requests should normalize into one model

Customer requests (claims, return requests, and problems the store must handle itself) may enter the application from multiple sources.

Possible sources include:

```text
EMAIL
FORM
SHOPIFY_ADMIN
AUTOMATED
API
```

All supported sources should normalize into the same underlying case model (see Cases, Claims, and Returns).

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

---

## 7. The application owns claims and tickets

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

---

## 8. Never auto-deny claims by default

The intended automated decision model is:

```text
AUTO_APPROVE
REVIEW_REQUIRED
```

If a claim appears unsupported, suspicious, contradictory, or uncertain, escalate it to merchant review.

Do not implement automatic rejection unless product/legal direction explicitly changes.

Merchant users may still manually reject claims during review.

---

# Technology Stack

Prefer the existing project stack.

Current stack:

- Node.js, JavaScript ES modules; `tsc` type-checks JS/JSX (JSDoc types where useful), and new files should match the surrounding language
- React 18 with React Router 7 via `@shopify/shopify-app-react-router`
- Embedded Shopify Admin app using Polaris web components (`s-page`, `s-section`, …) and App Bridge
- Shopify CLI
- Shopify Functions (Cart Transform) and a Checkout UI extension
- Shopify Admin GraphQL API and Shopify webhooks
- PostgreSQL on Supabase, via Prisma ORM
- Railway hosting: a public web service and a private worker service
- Sentry and structured JSON logging (`app/observability.server.js`)
- Vitest; GitHub Actions CI

Optional infrastructure when justified:

- Theme/storefront integration where needed
- Shopify Admin UI extensions where useful
- Redis, BullMQ, or another queue (only if the PostgreSQL-backed webhook inbox stops being sufficient)
- managed object storage

Do not introduce major infrastructure without a concrete operational need.

Do not migrate the backend to Python unless product requirements change materially.

---

# Current Repository Direction

The repository currently looks like:

```text
.
├── app
│   ├── claims                  # tenant-scoped claim listing (read-only)
│   ├── merchant                # merchant configuration and capability resolution
│   ├── shopify                 # Admin GraphQL helper, protection product/transform setup
│   ├── routes                  # Admin pages (app.*), webhooks.*, auth, healthz
│   ├── analytics*.js           # Overview metrics (pure aggregation + DB reads)
│   ├── order-*.js              # order normalization, ingestion, Shopify fetch, reconciliation
│   ├── pricing-*.js            # pricing contract (basis points) and versioned pricing rules
│   ├── protection-refunds.js
│   ├── shipping-protection.server.js   # setup/repair and protection state
│   └── webhook-*.server.js     # webhook inbox and worker processing
├── extensions
│   ├── insurance-ext                   # Checkout UI block (protection offer)
│   └── shipping-protection-transform   # Cart Transform Function (prices protection)
├── prisma                      # schema.prisma and migrations
├── scripts                     # worker entry point, Postgres verification scripts
├── supabase
└── test-fixtures
```

Most protection and order code currently lives flat in `app/`. Moving it into domain folders (for example `app/protection`) is fine when it improves a concrete boundary, not for its own sake.

Preserve the general direction of separating:

```text
routes
merchant concerns
Shopify integration
extensions
database/migrations
```

Do not reorganize folders merely for aesthetics.

Architecture changes must improve a concrete boundary, testability, tenant safety, or maintainability.

---

# Preferred Application Boundaries

As the codebase grows, prefer domain-oriented boundaries such as:

```text
app/
├── merchant/
├── shopify/
├── protection/
├── claims/
├── returns/
└── routes/
```

Possible responsibilities:

## `app/merchant`

- merchant lookup
- tenant identity
- merchant configuration
- capability resolution
- merchant-specific settings
- configuration validation

## `app/shopify`

- Shopify Admin API adapters
- Shopify authentication helpers
- Shopify order lookup
- Shopify refund/replacement integrations
- webhook-specific helpers
- Shopify capability discovery
- Shopify ID normalization

## `app/protection`

- protection eligibility
- pricing logic
- protection purchase rules
- protection state

## `app/claims`

- claim creation
- claim normalization
- claim eligibility
- claim policy evaluation
- merchant review state
- resolution orchestration

## `app/returns`

- return eligibility
- free-return rules
- return workflows
- labels/integration adapters where later implemented

## `app/routes`

Transport and UI entry points only.

Routes may:

- authenticate
- validate input
- call application/domain functions
- translate results to HTTP/React responses

Routes should not become the primary home for business rules.

Do not introduce generic `services/`, `repositories/`, `use-cases/`, `ports/`, or `adapters/` layers unless the project genuinely benefits from them.

Prefer simple domain modules first.

---

# Merchant Configuration

Merchant configuration should be capable of representing the merchant's desired product behavior.

Potential configuration areas include:

## Protection benefits

Benefits must be things customers do not already have under Australian Consumer Law (see Legal / Product Boundary):

- theft protection (stolen after delivery)
- free change-of-mind returns
- lost-in-transit protection: pending legal review, because it may already be the merchant's responsibility
- damaged, faulty, or not-as-described: never offered as a protection benefit

Merchants choose which benefits their store offers (for example, theft only, or theft plus free returns).

`ShopConfiguration` currently has `stolen`, `lost`, and `damaged` coverage flags, and setup enables all three. That predates this direction; revisit it before claims work begins.

## Returns

- returns enabled
- free returns enabled
- return window
- return rules
- return label behavior

## Pricing

- fixed fee
- percentage
- order-value tiers
- min/max fee
- currency-specific configuration
- pricing version

Pricing likely needs to differ by benefit set. Free returns cost far more per order than theft protection (a return label can cost as much as dozens of orders' fees at a low percentage), and customers who expect to return items are more likely to opt in.

## Claim intake

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

## Automation

Possible settings include:

- auto-approval enabled
- maximum automatic resolution value
- eligible claim types
- claim-window configuration
- evidence requirements
- risk thresholds
- AI-assisted review enabled

## Protection attachment/storefront strategy

The `ProtectionAttachmentStrategy` enum currently has:

```text
CHECKOUT_UI_CART_TRANSFORM   implemented
THEME_CART                   not implemented
NONE
```

Add new strategies with names that match the mechanism actually implemented.

Do not assume strategies have identical Shopify eligibility requirements.

---

# Resolved Capabilities

Raw merchant configuration is not necessarily equivalent to what the application can execute.

The one trusted place that resolves effective capabilities is `resolveConfiguration` in `app/merchant/resolve-configuration.js`.

It combines:

- merchant settings (`ShopConfiguration`)
- observed Shopify capabilities (`observedShopifyCapabilities`: checkout UI support and Cart Transform update eligibility)
- what the app implements (`IMPLEMENTED_CAPABILITIES`)
- protection setup health checks

It returns the effective strategy, whether protection is enabled, human-readable reasons when it is not, coverage flags, and returns/claim-intake/auto-approval availability.

Extend that function rather than duplicating capability resolution in routes or extensions.

---

# Shopify Distribution

The intended production product is a multi-merchant application serving unrelated merchants.

Production architecture should therefore be compatible with Shopify public app distribution, potentially with limited visibility rather than broad App Store discovery.

Development may still use a separate single-merchant/custom development app.

Do not bake `SingleMerchant` assumptions into business logic.

Prefer environment-specific Shopify app configuration:

```text
development Shopify app
    ->
development credentials/configuration

production Shopify app
    ->
production credentials/configuration
```

Use one source codebase.

Do not maintain separate product forks for custom and public distribution.

---

# Deployment Architecture

Prefer one primary public application origin unless there is a concrete reason to expose more.

Conceptually:

```text
Shopify / storefront / merchant admin
                |
                v
       Public Railway service (web)
                |
     +----------+----------+
     |                     |
     v                     v
 PostgreSQL  <------  private worker
 (Supabase)          (scripts/worker.js)
```

Current services:

- **Web** (`npm run start`): Admin UI, OAuth, webhook receipt, health check at `/healthz`. Webhooks are verified and written to the `WebhookDelivery` inbox, then acknowledged.
- **Worker** (`npm run worker`): polls the inbox, fetches each order from Shopify, persists it, and retries with backoff. It also runs periodic order reconciliation. No public domain.

Deploys:

- Railway auto-deploys both services from `main` after the GitHub `CI / verify` check passes.
- The pre-deploy command runs `npx prisma migrate deploy`.
- Shopify extensions and app configuration deploy separately with `npx shopify app deploy --config production`. Shopify app versions do not deploy the hosted web app, and backend deploys do not update extensions.
- The README has the full Railway and migration procedure.

The primary public application may handle routes for:

- Shopify OAuth/authentication
- embedded Admin UI
- webhooks
- claim APIs
- return APIs
- app proxy routes
- merchant settings
- integration callbacks

One public service does not mean one source file or one monolithic module.

Keep internal code boundaries clear.

A second Railway service is justified when it has a clear job such as:

- background processing
- AI evaluation
- email ingestion/processing
- retry queues
- scheduled reconciliation

If a second service does not need inbound internet traffic, prefer Railway private networking rather than exposing another public endpoint.

Do not merge services blindly.

Understand their existing responsibilities first.

---

# Shopify Protection Strategies

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

## Implemented: Checkout UI + Cart Transform (`CHECKOUT_UI_CART_TRANSFORM`)

- Setup creates an unlisted Shipping Protection product with one $0.00 variant.
- The checkout block (`insurance-ext`) lets the customer add that variant.
- The Cart Transform Function (`shipping-protection-transform`) prices it from the `function-configuration` metafield: rate in basis points, applied to shippable merchandise before discounts.
- The checkout block needs Shopify Plus; Cart Transform price updates need the shop's `updateOperation` eligibility (Plus or development stores).
- The merchant must still place the block in the checkout editor. The app cannot verify placement, so "Active" in the Admin means setup checks pass, not that customers see the block.

Remember:

- Function execution occurs on Shopify infrastructure
- do not assume arbitrary runtime access to the backend
- provide Function-required configuration using Shopify-supported inputs/metafields
- the Function runs on every cart, including carts without protection; the Cart Transform goes live when setup runs, not when the block is placed

`blockOnFailure` is currently `true`: if the Function errors, cart and checkout are blocked for every customer. The alternative is that a failure leaves protection at $0.00. On a live high-volume store, prefer not blocking checkout, and alert on paid orders with a $0 protection line. Decide this explicitly before installing on a live store.

## Theme/storefront strategy

Provide a non-Cart-Transform path when needed.

Possible mechanisms depend on the final product implementation.

Keep this adapter separate from core protection business logic.

---

# Protection Pricing

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

---

# Protection Purchase Model

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

---

# Cases, Claims, and Returns

Direction only; not current work (see Current Focus).

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

## Claim fields

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

---

# Claims Intake

Different intake mechanisms should be adapters into shared claim creation.

## Email (first intake channel)

Email forwarding is the first product. The pilot merchant handles all customer requests by email and does not want that process changed, only automated. Customers keep emailing the store as they do today.

Flow:

```text
Customer emails the store
    ->
Merchant forwards it (manually or with an inbox rule) to the store's app address
    ->
Inbound email provider webhook -> web route (store raw message, return quickly)
    ->
Worker: parse, extract, resolve order -> Case
    ->
Merchant reviews in Admin -> resolution, label, customer update
```

Requirements:

- Give each store its own unguessable forwarding address. Establish the tenant from the receiving address, never from the email's content.
- Accept mail only from senders the merchant has registered, and check sender authentication (SPF/DKIM/DMARC results), so no one can inject cases into another store.
- Keep the original customer email address and thread so later updates reach the right person in the same conversation.
- Resolve the order from references in the email (order number, customer email) and verify it belongs to the tenant. If no order matches, the case goes to review.
- Store only the forwarded message and the extracted fields; never pull or retain other inbox content.
- Make processing idempotent on the message ID, so a double-forwarded email creates one case.

Extraction is AI-assisted and untrusted:

- validate extracted fields against Shopify data before use
- record a short summary and the structured result, not raw model reasoning
- email parsing must not decide whether a claim is valid

Customer updates (decided):

- **Sent from the store's own address** (for example `support@store.com`) through a transactional email provider that the merchant authorizes with DNS records (SPF, DKIM, DMARC alignment). The customer sees an email from the store.
- **Reply-To is the store's app address with a case token** (for example `store-token+case-123@<app domain>`). Customer replies thread back into the case automatically.
- **Every customer reply is also copied to the merchant's inbox,** so their team never loses sight of a conversation.
- **Never connect to the merchant's mailbox** (Gmail/Microsoft OAuth or IMAP credentials). Reading a mailbox through Google's API requires restricted scopes and a paid third-party security assessment; forwarding in and DNS-authorized sending out avoid that entirely.
- **Treat send authority as a credential.** The app can send as the store's domain, so keep provider keys server-side, send only case-related templates to that case's customer, and log every send.

## Small customer form (later, for merchants who want it)

The form should collect only what is necessary.

Authenticate or validate order/customer context appropriately.

Do not trust order IDs supplied without ownership/tenant validation.

## Shopify Admin

Merchant users should eventually be able to:

- create claims
- see claims associated with an order
- review claims
- approve
- reject
- request additional review/information
- trigger allowed resolutions

All paths should use shared claim services.

---

# Merchant Review in Shopify Admin

Claims that cannot be automatically resolved should appear naturally within Shopify Admin.

Potential surfaces include:

- embedded app claims queue
- order-detail Admin block
- Admin action
- claim detail page

Example order context:

```text
Order #1048

Shipping Protection
-------------------
Claim: Stolen package
Status: Review required
Protected amount: $142.00

[Review claim]
```

The Admin UI is a presentation/integration layer.

The canonical claim record remains in the application database.

---

# Returns

Returns are logistics, and they have two origins:

- a free change-of-mind return is a protection benefit: an approved claim creates the return, and the app provider may pay the return label
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

---

# Payouts

Direction only; likely the first claims-adjacent piece, because pilot pricing depends on real payout costs.

Until payouts are recorded, "Claims paid" on the Overview is always zero, and net protection revenue equals revenue minus protection refunds.

A payout record (manual entry at first, attached to an order and later to a case) should capture:

- shop and order (ownership verified)
- coverage: `THEFT`, `FREE_RETURN`, or `STORE_RESPONSIBILITY`
- kind: replacement, refund, store credit, or return label
- amount and currency: what it cost the business
- `paidBy`: merchant or app provider; this is what lets any billing model be calculated
- when the money moved, and which staff member recorded it
- an optional Shopify refund or replacement-order ID, unique per shop, to prevent duplicates
- corrections are voids with a reason, never edits or deletes

Accounting rules:

- theft payouts count their full cost
- free-return payouts count only return shipping and handling; the item refund is not a protection cost, because the merchant gets the item back
- `STORE_RESPONSIBILITY` entries never count against protection revenue. They may appear in merchant-only reporting ("costs you handled").

Open decision: whether a reshipped order is valued at cost to the merchant (product cost plus shipping) or at retail. Pick one and apply it consistently.

---

# Webhooks

Subscribed topics (`shopify.app.toml`):

```text
orders/create
orders/paid
orders/updated
orders/cancelled
refunds/create
app/uninstalled
app/scopes_update
customers/data_request, customers/redact, shop/redact   (compliance)
```

Order and refund webhooks are stored in the `WebhookDelivery` inbox. The worker then fetches the full order from Shopify, rather than trusting the webhook payload, and persists it.

Additional fulfillment/delivery topics may be added when required.

Webhook handlers must:

1. verify Shopify authenticity
2. validate payload structure
3. establish tenant identity
4. be idempotent
5. persist required state
6. return quickly
7. move slow/retryable work to a worker when appropriate

Never assume a webhook runs exactly once.

Use stable Shopify IDs, event IDs, or equivalent idempotency keys.

---

# Idempotency

Idempotency is mandatory for operations that can create duplicate money movement or Shopify resources.

Protect against duplicate:

- protection purchases
- claims where appropriate
- claim resolutions
- refunds
- store credit
- replacement orders
- webhook side effects
- label generation
- integration actions

Before executing a financial or irreversible Shopify action, determine whether the operation:

- already completed
- is currently in progress
- previously failed safely
- can be retried

Never retry financial actions blindly.

---

# Claim Validation

Before making a claim decision, verify as applicable:

- authenticated tenant
- Shopify order exists
- order belongs to tenant
- protection was purchased where required
- protection type covers the claim
- protection remains valid
- claim is inside the configured window
- claim is not already resolved
- duplicate/open claims are handled
- evidence requirements are met
- tracking/fulfillment data is consistent enough to evaluate

Potential risk signals include:

- delivered scan conflicts with claim
- repeated claims
- duplicate evidence
- inconsistent timestamps
- repeated claims against one fulfillment
- unusually high order value
- repeated addresses or identifiers where lawfully and appropriately used

Risk signals trigger review.

They do not automatically justify rejection.

---

# Claim Decision Model

The default automated decision model is:

```text
AUTO_APPROVE
REVIEW_REQUIRED
```

A claim may auto-approve only where configured rules support it.

An example rule set might require:

- valid protection
- valid claim window
- eligible claim type
- amount below merchant threshold
- evidence/tracking supports claim
- no duplicate resolution
- no material risk flags
- configured automation enabled

This is illustrative.

Merchant-specific rules must be configuration-driven.

---

# AI Usage

AI may assist but should not be the sole authority for financial or claim decisions.

Appropriate AI tasks include:

- summarizing claim descriptions
- extracting structured facts
- classifying claim type
- parsing email intake
- comparing claim text with order/tracking information
- identifying inconsistencies
- analyzing submitted images where supported
- generating review summaries
- assigning structured confidence/risk signals

Do not ask a model only:

```text
Should this claim be accepted?
```

Prefer deterministic policy plus structured AI assistance.

All model output is untrusted input.

Validate it before acting.

Store concise decision summaries and relevant structured outputs.

Do not store unnecessary chain-of-thought.

---

# Claim Resolution

Approved claims may eventually resolve through:

- refund
- replacement
- store credit
- another merchant-supported remedy

Use Shopify Admin GraphQL for privileged Shopify actions where applicable.

Resolution records should track:

- requested action
- tenant
- claim
- Shopify operation ID
- idempotency key
- state
- errors
- retry metadata where needed
- completed timestamp

Never issue duplicate financial resolutions.

---

# Analytics

The Overview currently shows a fixed 30-day window of the metrics below (`app/analytics.js`, `app/analytics.server.js`).

Conventions:

- dates use the shop's time zone
- revenue is dated by completed payment; refunds by successful refund transaction
- test orders are excluded unless the merchant chooses to include them
- only shop-currency records count; others are reported as data-quality notices

## Attach Rate

```text
protected eligible paid orders / eligible paid orders
```

Eligibility is an order-based estimate, because checkout exposure is unknown.

## Protection Revenue

Total completed protection fees.

## Protection Refunds

Protection fees refunded.

## Claims Paid

Total covered payouts (theft, and free-return shipping/handling). Always zero until payouts are recorded (see Payouts).

## Net Protection Revenue

```text
protection revenue - protection refunds - claims paid
```

## Claim Rate

```text
protected orders with a covered payout / protected orders
```

Together with attach rate and average payout, this is the main input for finding a profitable price. Raising the fee usually lowers attach rate, so watch both when the rate changes.

## Approval Rate

Track separately where useful:

- auto-approved
- merchant-approved

## Loss Ratio

```text
claims paid / protection revenue
```

Store-responsibility costs never enter claims paid or loss ratio.

## Net Protection Contribution

A later extension of net protection revenue that also subtracts provider/app costs. Define the accounting explicitly before showing it.

Do not label a metric `profit` unless all relevant costs are included.

All analytics must be tenant-scoped.

---

# Merchant Admin UI

Navigation under the app:

```text
Overview            /app/overview  (dashboard; /app redirects here)
Claims & Returns    /app/claims
Settings            /app/settings
```

App Bridge hides the `rel="home"` link from the sidebar. That is why the dashboard has its own `/app/overview` route: so "Overview" appears as a menu item.

Overview:

- a clean operational dashboard, not a dense reporting tool
- answers: Is protection active? What revenue is it generating? What share of customers choose it? What has been paid in claims? What is net protection revenue?
- shows status and rate, five metric tiles, a 30-day revenue chart, recent activity, and a short data-quality warning only when there are issues
- do not add date-range pickers, breakdowns, exports, or a separate Analytics page until deeper reporting is actually needed

Settings: setup/repair, pricing rate, protection product, and checkout activation steps. Show only failing setup checks; when all pass, say so in one line.

Copy:

- plain language merchants understand, with no basis points or internal jargon
- never imply protection covers what Australian Consumer Law already requires

Components:

- use Polaris web components, and check their props against `@shopify/polaris-types`
- `s-button` does not submit `name`/`value`: send form intents with a hidden `<input>`
- `s-empty-state` is not available in the installed types

---

# Authentication and Security

All privileged Shopify API calls must originate from trusted server code.

Never expose:

- Shopify Admin tokens
- API secrets
- webhook secrets
- database credentials
- AI provider secrets
- private integration credentials

Frontend/extension requests must use Shopify-supported authentication mechanisms where applicable.

Validate:

- tenant
- session/user when required
- request payloads
- authorization
- ownership of referenced resources

External input includes:

- Shopify webhooks
- extension requests
- claim forms
- Admin UI forms
- email ingestion
- AI model output
- carrier APIs
- integration callbacks

Treat all external input as untrusted.

---

# Data Model and Database

Use Prisma migrations.

Prefer:

- explicit foreign keys
- unique constraints
- database constraints
- transactions
- tenant-aware compound indexes
- stable external identifiers

Avoid relying exclusively on application logic to prevent duplicate financial records.

Do not create one giant JSON blob for all merchant configuration.

Use typed relational fields/tables for important business-critical settings.

JSON is acceptable for genuinely flexible data that does not need strong relational querying or constraints.

Before adding schema:

1. inspect the current Prisma schema
2. reuse existing concepts
3. avoid duplicate merchant/shop entities
4. preserve migration history
5. add only what the current feature needs

---

# Privacy and Data Minimization

Avoid storing unnecessary customer personal information.

Prefer Shopify references over duplicated customer profiles where practical.

If evidence uploads are implemented:

- use private storage
- use signed/short-lived access URLs
- validate file types and sizes
- define retention rules
- never expose evidence publicly by default

Logs should not contain secrets or unnecessary personal information.

Email ingestion must avoid retaining unrelated inbox content.

---

# Error Handling

Errors should be:

- structured
- logged with useful tenant/request context
- safe to retry where appropriate
- visible to merchants when they need to act

Do not swallow Shopify API failures.

Do not treat HTTP 200 as proof that a GraphQL mutation succeeded.

Check GraphQL user errors.

For external services:

- distinguish retryable and permanent failures
- use bounded retry strategies
- avoid infinite loops
- preserve enough state to diagnose failures

---

# Background Jobs

Use background jobs only when synchronous execution becomes inappropriate.

Good candidates include:

- email parsing
- carrier/tracking lookups
- AI analysis
- slow webhook follow-up work
- retries
- notifications
- analytics aggregation
- long-running Shopify operations

Do not add a queue solely for architectural purity. The PostgreSQL `WebhookDelivery` inbox (claimed with `FOR UPDATE SKIP LOCKED`) is the current queue.

If a worker exists on Railway and does not need inbound public internet traffic, prefer private service-to-service networking.

---

# Scale and Reliability

Design for the pilot store, a rough estimate that should be updated with real data:

- about 200,000 orders a year (about 550 a day), with peak sale days 5–10× higher
- several webhooks per order, so thousands of deliveries a day normally and 20,000+ on peak days
- every order is ingested, not just protected ones, because attach rate needs all eligible orders

Requirements:

- a checkout failure must never be a side effect of this app (see `blockOnFailure` under Shopify Protection Strategies)
- webhook backlogs may delay the dashboard but must never lose or double-count orders
- order reconciliation must be able to finish its initial 60-day backfill and keep up with daily order updates
- Admin page loads must not do unbounded or slow Shopify work
- the Shopify API calls per order should stay small and predictable

Known gaps (2026-09-29), to fix before installing on a live high-volume store:

1. `blockOnFailure: true` blocks every checkout if the Cart Transform errors.
2. The worker processes one delivery at a time, and each delivery fetches the full order (about three Admin API calls). Coalesce queued deliveries for the same order into one fetch, then allow a few concurrent processing loops.
3. Worker reconciliation processes 10 orders per 15 minutes (about 960 a day). That can never finish the backfill or keep up with this store.
4. The Overview triggers a 30-order reconciliation on every page load. This is slow at volume and can collide with the worker's reconciliation of the same shop. Reconciliation should run only in the worker.
5. The Overview aggregates 30 days of orders in memory. That is acceptable at pilot scale; move it into SQL aggregates if it becomes slow.

---

# Shopify GraphQL

Prefer Shopify Admin GraphQL for new privileged Admin API functionality.

When adding queries/mutations:

- request only required fields
- respect API cost limits
- paginate correctly
- use Shopify global IDs correctly
- handle user errors
- tenant-scope all operations
- log actionable failures safely

Always put a newline after the `#graphql` tag. In GraphQL, `#` starts a comment that runs to the end of the line, so `` `#graphql query X { … }` `` on one line sends Shopify an empty document ("syntax error, unexpected end of file"). This once broke every order sync.

Do not introduce REST for new work unless there is a concrete API limitation requiring it.

---

# Testing Expectations

Prioritize automated tests for:

- merchant configuration resolution
- Shopify capability resolution
- tenant isolation
- protection price calculations
- protection purchase idempotency
- claim normalization
- claim eligibility
- auto-approval rules
- review escalation
- webhook verification
- webhook idempotency
- refund idempotency
- replacement idempotency
- duplicate claim handling
- analytics calculations

When fixing a production bug, add a regression test where practical.

Do not mock away the business logic being tested.

Test doubles for the Admin GraphQL client should reject malformed queries (at minimum, comment-only queries), so query syntax bugs fail in tests rather than in production.

Run `npm test`, `npm run lint`, and `npm run typecheck` before pushing. Local runs need dependencies installed with `npm install`, including `@sentry/node`, which `app/observability.server.js` imports.

---

# Coding Guidelines

## Types

Code must pass `npm run typecheck` (`tsc` over JS/JSX, and both extensions). Add JSDoc types where they clarify money, IDs, or external payloads.

Avoid `any` unless there is a concrete reason.

Validate external input.

Use schemas where useful.

Do not create abstract type systems that are more complicated than the domain itself.

## Server-only code

Mark and organize server-only modules clearly.

Secrets, database access, privileged Shopify API access, and merchant-sensitive business logic must remain server-side.

## Routes

Routes should primarily:

1. authenticate
2. resolve tenant
3. validate input
4. call domain/application code
5. format response

If a route contains large pricing, claim, return, or merchant-policy logic, extract it.

## Imports

Avoid dependency cycles.

Domain logic should not depend on route modules.

Shopify integration code should not become the only place business rules can execute.

---

# Auditability

Claims and financial actions must remain explainable.

Preserve important state transitions such as:

```text
claim submitted
claim normalized
eligibility checked
policy evaluated
AI assistance completed
auto-approved
merchant review requested
merchant approved/rejected
resolution requested
resolution completed
```

For automated decisions retain, where applicable:

- rule version
- decision reason
- configured policy snapshot/reference
- risk flags
- AI summary/confidence
- relevant external references

Do not store unnecessary raw AI reasoning.

---

# Legal / Product Boundary

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

Australian Consumer Law rights must not be represented as being removed or replaced by paid protection.

Product rules that follow from this (legal review still required):

- Only sell benefits customers do not already have. Theft after delivery and free change-of-mind returns qualify. Damage in transit, faulty goods, and not-as-described items are the merchant's existing obligation and must not be sold as protection. Lost in transit is pending legal review.
- Customers without protection who have a consumer-law problem must be treated exactly like protected customers. Never gate those remedies behind protection, and never tell an unprotected customer they are not covered for them.
- Protection fees are the merchant's revenue, and the merchant may spend them on anything, including consumer-law remedies. Merchant-only reporting may show those costs next to protection revenue. Customer-facing wording must never suggest the fee is what funds those remedies.

Who carries the risk is unresolved:

- If the merchant owns the promise to the customer and pays claims, the app is software and a service provider.
- If the app provider collects fees and pays claims or return labels directly, the product may look like insurance.
- Do not build or word anything that assumes the provider carries the risk until legal advice confirms a structure.

The repository, the dev app, and the checkout extension (`insurance-ext`) use "insurance" as a working name. Customer-facing and public listing copy should say "shipping protection" unless legal review confirms otherwise.

Agents working on code must not invent legal wording or compliance guarantees.

Use neutral placeholders where product/legal decisions are unresolved.

---

# Product Direction

The broad product direction is:

## Phase 1 — Reliable protection purchase (current)

- protection offer
- pricing
- customer selection
- completed-order verification
- protection purchase persistence
- webhook reliability
- tenant-safe merchant configuration
- scale hardening for the pilot store (see Scale and Reliability)

## Phase 2 — Merchant analytics/configuration (current)

- attach rate
- revenue
- protected orders
- merchant settings
- capability resolution
- Overview dashboard and Settings

## Phase 3 — Claims and returns MVP

One complete, manually operated loop from customer request to resolution. Claims and returns ship together, because a free return is a protection benefit and is not usable without a label.

- payout recording; this can ship ahead of the rest, because pilot pricing depends on it
- per-store benefit configuration (theft, free returns), return window, and pricing per benefit set
- Case model with covered / store-responsibility classification
- intake: email forwarding is the first product (see Claims Intake → Email). Merchants keep handling customer requests by email; the app automates what happens after the email arrives. Merchant-created cases in Admin cover anything forwarding misses.
- structured extraction from forwarded emails (AI-assisted, validated) into a Case; unclear requests and missing order references go to review, never to rejection
- Claims & Returns queue, case detail, and order-linked context (Admin block/action on the order page)
- one-click review: the app prepares everything (extracted facts, matched order, coverage label, proposed resolution and label), and staff such as warehouse workers approve it, change it, reject it, or ask for more information. Nothing executes without a person approving. Record which Shopify staff member approved each case.
- resolutions executed through Shopify exactly once: refund, replacement order, store credit, exchange
- returns: Shopify Returns, return label integration (provider-paid for free returns), label delivered to the customer, item tracked back, refund or exchange on receipt
- customer status updates by email for the steps they act on (label issued, return received, resolved)
- payouts recorded automatically from resolutions; claims paid, claim rate, and loss ratio on the Overview

## Phase 4 — Automation

- deterministic eligibility and approval rules
- carrier/tracking integration
- AI-assisted analysis and review summaries
- auto-approval within merchant-configured limits
- automated resolutions and labels for auto-approved cases
- fraud/risk signals that route to review

## Phase 5 — Optimization

- pricing experiments
- merchant-specific rule tuning
- a separate Analytics page for deeper reporting (date ranges, breakdowns, loss ratio over time, exports)
- additional intake channels for merchants who want them (customer form, API)
- support platform integrations (for example, helpdesk tools)

Outside the phase order, but required before the milestones they gate:

- before charging any merchant: decide the payment model, and add Shopify app billing calculated from recorded revenue and payouts
- before public listing or live customer-facing copy: legal review of benefit wording and of who carries the risk

Each phase should leave merchants with something complete they can use. Do not build pieces that only pay off in a later phase, such as a model without an Admin screen, or intake without resolution.

This order is not absolute.

Do not implement later phases prematurely when current data integrity or tenant boundaries are incomplete.

---

# Agent Working Rules

When making changes to this repository:

1. Inspect the repository before proposing architectural changes.
2. Follow current framework and project conventions.
3. Do not rewrite working functionality without a clear reason.
4. Treat the application as multi-tenant.
5. Never introduce merchant-specific code branches when configuration can represent the behavior.
6. Resolve tenant identity from trusted Shopify/session context.
7. Scope every merchant-owned query.
8. Preserve webhook idempotency.
9. Treat refunds, replacements, credits, labels, and other side effects as idempotent operations.
10. Keep Shopify extensions thin.
11. Keep privileged logic server-side.
12. Keep Shopify Function-runtime logic inside the appropriate Function where required.
13. Use Shopify GraphQL for new Admin API work unless a concrete limitation requires otherwise.
14. Do not auto-deny claims by default.
15. Treat AI output as untrusted.
16. Validate model output before acting.
17. Minimize stored customer data.
18. Prefer incremental, testable changes.
19. Add tests for important business rules.
20. Document new environment variables.
21. Never commit secrets.
22. Do not invent legal or compliance claims.
23. Prefer reversible implementations when requirements remain uncertain.
24. Explain changes that affect merchant money, customer refunds, or claim decisions.
25. Do not add microservices merely for future scalability.
26. Prefer one public Railway application origin unless another public service is concretely necessary.
27. Prefer private workers for internal asynchronous workloads.
28. Do not encode Shopify plan assumptions when specific capability checks are available.
29. Preserve historical pricing and decision auditability.
30. Keep app-owned claims/returns state in the application database.
31. Do not use frontend analytics as financial truth.
32. Avoid giant configuration JSON blobs for core business settings.
33. Do not create abstraction layers without at least one concrete current use.
34. Before schema changes, inspect existing Prisma models and migrations.
35. Before changing deployment architecture, identify what each existing Railway service actually does.
36. When adding new intake channels, normalize them into shared domain models.
37. Do not fork the codebase per merchant.
38. Development and production Shopify apps may have different distribution configuration while sharing one codebase.
39. Finish and harden shipping protection before building claims or returns.
40. Never sell, word, or gate protection in a way that overlaps Australian Consumer Law obligations.
41. Show merchants percentages, not basis points.
42. Put a newline after every `#graphql` tag.
43. Assume live-store volume: no unbounded work on Admin page loads, and no change that can block checkout.

---

# Before Significant Refactors

Before making a significant architecture change:

1. summarize the existing implementation
2. identify the concrete problem
3. identify current tenant boundaries
4. identify existing merchant assumptions
5. inspect the Prisma schema
6. inspect Shopify app configuration
7. inspect extension/runtime constraints
8. identify public vs private service responsibilities
9. propose the smallest useful target structure
10. list files to change
11. identify migrations required
12. identify backwards-compatibility risk
13. identify tests required
14. distinguish:
   - necessary now
   - useful now
   - defer

Do not begin a large rewrite until the existing behavior is understood.

---

# Definition of a Good Implementation

A good implementation should eventually support:

```text
Merchant installs app
    ->
Tenant is established securely
    ->
Merchant configuration is loaded
    ->
Shopify/platform capabilities are resolved
    ->
Effective capabilities are determined
    ->
Appropriate protection experience is shown
    ->
Customer purchases protection
    ->
Shopify order completes
    ->
Protection purchase is persisted exactly once
    ->
Merchant sees accurate analytics
    ->
Request arrives from form/email/Admin/etc.
    ->
Input is normalized into one Case, labelled covered or store responsibility
    ->
For covered requests, system validates claim eligibility
    ->
Clear valid claim may auto-approve
    OR
    ->
Uncertain claim enters Shopify Admin review
    ->
Merchant selects resolution
    ->
Shopify action executes exactly once
    ->
Claim and financial history remain auditable
```

The same codebase should also support merchants with different configurations, including merchants that:

- do not use Cart Transform
- do not offer returns
- offer free returns
- offer only stolen-package protection
- use email-based claims
- use form-based claims
- create claims through Shopify Admin
- enable or disable automation

Reliability, tenant isolation, auditability, merchant configurability, and safe automation are more important than speculative architectural complexity.
