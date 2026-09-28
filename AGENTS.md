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

## Product Goals

The system should eventually support merchants with configurations such as:

### Example A

- shipping/stolen-package protection
- free returns
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

- shipping protection and returns
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

## 6. Claims should normalize into one model

Claims may enter the application from multiple sources.

Possible sources include:

```text
EMAIL
FORM
SHOPIFY_ADMIN
AUTOMATED
API
```

All supported sources should normalize into the same underlying claim/case model.

Do not implement separate incompatible claim models for:

- email claims
- form claims
- Shopify Admin claims
- automated claims

Prefer:

```text
Email intake --------\
Form intake ----------\
Shopify Admin ---------> normalize -> Claim
Other integration ----/
```

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

# Expected Technology Stack

Prefer the existing project stack.

Expected stack:

- Shopify CLI
- Shopify app
- React
- TypeScript
- Node.js
- Shopify Functions where appropriate
- Checkout UI Extension where supported and appropriate
- Theme/storefront integration where needed
- Embedded Shopify Admin app
- Shopify Admin UI extensions where useful
- Shopify Admin GraphQL API
- PostgreSQL
- Prisma ORM
- Shopify webhooks
- Railway hosting
- Supabase/PostgreSQL where already used by the repository

Optional infrastructure when justified:

- Railway private worker service
- Redis
- BullMQ or another queue
- Sentry
- structured logging
- managed object storage
- CI/CD

Do not introduce major infrastructure without a concrete operational need.

Do not migrate the backend to Python unless product requirements change materially.

---

# Current Repository Direction

The repository currently follows a structure similar to:

```text
.
├── app
│   ├── merchant
│   ├── routes
│   │   ├── _index
│   │   └── auth.login
│   └── shopify
├── extensions
│   ├── insurance-ext
│   │   ├── locales
│   │   ├── src
│   │   └── tests
│   └── shipping-protection-transform
│       ├── locales
│       ├── src
│       └── tests
│           └── fixtures
├── prisma
│   └── migrations
│       ├── 20260923000000_postgresql_baseline
│       ├── 20260924000000_merchant_analytics
│       └── 20260928000000_merchant_configuration_tenant_keys
├── public
├── scripts
├── supabase
└── test-fixtures
```

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

## Protection products

- shipping protection enabled
- stolen package protection
- lost package protection
- damaged package protection

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

Possible strategies may include:

```text
CART_TRANSFORM
CHECKOUT_UI
THEME
STOREFRONT
NONE
```

Use exact names that match the implemented mechanisms.

Do not assume these strategies have identical Shopify eligibility requirements.

---

# Resolved Capabilities

Raw merchant configuration is not necessarily equivalent to what the application can execute.

Create one trusted place that resolves effective capabilities.

Conceptually:

```ts
type ResolvedMerchantCapabilities = {
  protection: {
    enabled: boolean;
    stolenPackage: boolean;
    lostPackage: boolean;
    damagedPackage: boolean;
  };

  returns: {
    enabled: boolean;
    freeReturns: boolean;
  };

  intake: {
    email: boolean;
    form: boolean;
    shopifyAdmin: boolean;
  };

  automation: {
    autoApprove: boolean;
  };

  protectionStrategy:
    | "CART_TRANSFORM"
    | "CHECKOUT_UI"
    | "THEME"
    | "STOREFRONT"
    | "NONE";
};
```

This example is illustrative.

Match real repository types and Shopify capabilities.

Do not duplicate capability resolution across extensions and routes.

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
       Public Railway service
                |
     +----------+----------+
     |                     |
     v                     v
 PostgreSQL          private worker
                     if needed
```

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

Potential strategies include:

## Cart Transform

Use where Shopify capabilities permit and where the implementation fits the merchant.

Remember:

- Function execution occurs on Shopify infrastructure
- do not assume arbitrary runtime access to the backend
- provide Function-required configuration using Shopify-supported inputs/metafields

## Checkout UI

Use only where the desired checkout placement and merchant eligibility permit it.

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

# Claims Model

Claims should be first-class application entities.

Potential fields include:

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

Possible claim types include:

```text
STOLEN
LOST
DAMAGED
RETURN
```

Do not force `RETURN` into Claim if the implemented domain proves that returns need a distinct entity.

Use the repository state and product semantics.

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

## Email

Email ingestion may later:

- parse forwarded customer requests
- identify merchant/shop
- resolve customer/order references
- extract claim details
- create a normalized claim
- flag ambiguity for review

Email parsing must not itself decide whether the claim is valid.

## Small customer form

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

Returns should be designed as a product capability rather than bolted onto claims.

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

# Webhooks

Likely Shopify webhook topics include:

```text
orders/create
orders/paid
orders/cancelled
refunds/create
app/uninstalled
```

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

The merchant dashboard should eventually support metrics such as:

## Attach Rate

```text
protected eligible orders / total eligible orders
```

## Protection Revenue

Total completed protection fees.

## Protection Refunds

Protection fees refunded.

## Claim Rate

```text
claims submitted / protected orders
```

## Approval Rate

Track separately where useful:

- auto-approved
- merchant-approved

## Claims Cost

Total economic cost of claim resolutions.

## Loss Ratio

```text
claims cost / protection revenue
```

## Net Protection Contribution

Define accounting explicitly.

Potentially:

```text
protection revenue
- protection refunds
- claim costs
- provider/app costs
= net protection contribution
```

Do not label a metric `profit` unless all relevant costs are included.

All analytics must be tenant-scoped.

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

Do not add a queue solely for architectural purity.

If a worker exists on Railway and does not need inbound public internet traffic, prefer private service-to-service networking.

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

---

# Coding Guidelines

## TypeScript

Prefer strict types.

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

Agents working on code must not invent legal wording or compliance guarantees.

Use neutral placeholders where product/legal decisions are unresolved.

---

# Product Direction

The broad product direction is:

## Phase 1 — Reliable protection purchase

- protection offer
- pricing
- customer selection
- completed-order verification
- protection purchase persistence
- webhook reliability
- tenant-safe merchant configuration

## Phase 2 — Merchant analytics/configuration

- attach rate
- revenue
- protected orders
- merchant settings
- capability resolution

## Phase 3 — Claims foundation

- normalized Claim model
- customer claim form
- merchant-created claims
- manual review
- manual resolutions

## Phase 4 — Shopify Admin claims experience

- claims queue
- order-linked claim context
- Admin block/action
- claim detail
- approve/reject/escalate workflows

## Phase 5 — Additional claim intake

- email forwarding/intake
- structured email extraction
- other integrations

## Phase 6 — Claims automation

- deterministic rules
- carrier/tracking integration
- AI-assisted analysis
- auto-approval
- review escalation
- automated resolutions

## Phase 7 — Returns

- configurable returns
- free-return capability
- return workflows
- label integrations
- Admin visibility

## Phase 8 — Optimization

- pricing experiments
- merchant-specific rule tuning
- advanced analytics
- support platform integrations
- fraud/risk improvements

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
Claim arrives from form/email/Admin/etc.
    ->
Input is normalized into one Claim model
    ->
System validates eligibility
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
