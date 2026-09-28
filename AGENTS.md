# AGENTS.md

## Project Overview

This repository contains a Shopify app for merchant-provided shipping/order protection.

The product allows customers to add paid protection to eligible orders and gives merchants a way to generate additional revenue while minimizing the operational work involved in handling claims.

The intended end-to-end flow is:

1. Customer sees a shipping/order protection offer in the Shopify storefront or checkout.
2. Customer opts in and pays the protection fee.
3. Shopify remains the source of truth for the completed order and financial transaction.
4. The app records the protection purchase and associated order metadata.
5. A customer can later submit a claim for a covered issue such as loss, theft, or damage.
6. The claims engine evaluates the claim using deterministic rules, Shopify/order data, tracking/carrier data, submitted evidence, and optionally AI-assisted analysis.
7. High-confidence valid claims can be approved and resolved automatically.
8. Uncertain, suspicious, or potentially invalid claims are escalated to the merchant for review.
9. The system should not automatically deny customer claims. The default model is:
   - auto-approve when rules clearly allow it
   - otherwise escalate for human review

The product should feel like an automated shipping-protection platform rather than only a checkout checkbox.

---

## Core Product Principles

### 1. Shopify is the source of truth

Do not treat frontend events as authoritative financial records.

Frontend events are useful for funnel analytics such as:

- protection viewed
- protection selected
- protection removed

Completed Shopify orders, refunds, cancellations, and related webhook data are the source of truth for:

- protection purchases
- protection revenue
- refunds
- order state
- claim eligibility where applicable

---

### 2. Keep the extension thin

The storefront or checkout extension should primarily handle:

- rendering the protection offer
- displaying price
- collecting customer selection
- calling safe backend endpoints when necessary
- emitting non-authoritative analytics events

Do not place secrets, privileged Shopify Admin API logic, claim decision logic, or sensitive business rules in the extension.

---

### 3. Backend owns business logic

The backend should handle:

- Shopify authentication
- merchant configuration
- protection pricing rules
- protection purchase persistence
- analytics aggregation
- claim creation
- claim validation
- claims decision logic
- Shopify Admin GraphQL API calls
- refunds
- replacement workflows
- merchant review queues
- webhook processing
- AI-assisted claim analysis
- fraud/risk checks
- audit history

---

### 4. Never auto-deny claims by default

The automated decision model should be:

- `AUTO_APPROVE`
- `REVIEW_REQUIRED`

Avoid implementing automatic rejection unless the product direction explicitly changes after legal/product review.

When the system believes a claim may be invalid, suspicious, contradictory, or unsupported, create a merchant review task instead of denying it automatically.

---

## Expected Technology Stack

Prefer the existing project stack when present.

Expected stack:

- Shopify CLI
- Shopify app
- React
- TypeScript
- Shopify Checkout UI Extension and/or Theme App Extension
- Embedded Shopify Admin app
- Shopify Admin GraphQL API
- Node.js / TypeScript backend
- PostgreSQL
- Prisma ORM
- Shopify webhooks

Optional infrastructure if needed:

- Redis
- BullMQ or another job queue
- Sentry
- structured application logging
- managed background workers
- CI/CD
- managed PostgreSQL hosting

Do not introduce major infrastructure without a concrete need.

---

## High-Level Architecture

```text
Shopify Storefront / Checkout
        |
        v
Protection Extension
        |
        v
Backend API
        |
        +-------------------+
        |                   |
        v                   v
PostgreSQL          Shopify Admin GraphQL API
        |
        v
Claims / Analytics / Merchant Settings

Shopify Webhooks
        |
        v
Webhook Handler
        |
        v
Database + Background Jobs
```

---

## Shopify Extension

The customer-facing protection offer should communicate:

- what protection covers
- protection price
- that the customer is opting in
- any concise legal/disclosure text required by the merchant or jurisdiction

Do not rely on a pre-checked opt-in unless there is a clear legal and Shopify-platform basis for doing so.

Prefer explicit customer opt-in.

Possible implementation approaches include:

- Checkout UI Extension
- Theme App Extension
- cart-level protection UI

Exact placement may depend on Shopify plan and available extension capabilities.

The current project previously created a Checkout UI Extension named:

```text
insurance_ext
```

---

## Protection Pricing

Protection pricing may be:

- percentage of cart/order value
- fixed fee
- merchant-configured rate
- tiered by order value

The pricing system should be deterministic and auditable.

Store enough information with each protection purchase to reconstruct how the price was calculated.

Recommended fields include:

- pricing rule ID
- pricing version
- protection rate
- calculated protection amount
- order/cart value at calculation time
- currency
- experiment ID if A/B testing is enabled

Never rely only on current merchant settings to explain historical protection prices.

---

## Data Model

Exact schema may evolve, but the system will likely need entities similar to the following.

### Shop

Represents an installed merchant.

Potential fields:

- id
- shopifyShopId
- shopDomain
- access token or secure auth reference
- installation status
- protection enabled
- pricing configuration
- auto-approval settings
- claim rules
- createdAt
- updatedAt

---

### Order

Stores app-relevant Shopify order state.

Potential fields:

- id
- shopId
- shopifyOrderId
- orderName
- customer reference where appropriate
- subtotal
- total
- currency
- fulfillment status
- financial status
- createdAt
- updatedAt

Avoid copying excessive Shopify data into the local database.

Store only what is necessary for the product.

---

### ProtectionPurchase

Represents protection purchased for an order.

Potential fields:

- id
- shopId
- orderId
- shopifyOrderId
- protected amount
- protection fee
- currency
- pricing rule/version
- protection status
- purchase timestamp
- refunded amount
- metadata

There should normally be a unique relationship between the intended protection record and the Shopify transaction/order context.

---

### AnalyticsEvent

Used for funnel analytics.

Potential event types:

```text
PROTECTION_VIEWED
PROTECTION_SELECTED
PROTECTION_REMOVED
CLAIM_STARTED
CLAIM_SUBMITTED
```

These events are useful for behavior analysis but should not be used as the authoritative source for revenue.

---

### Claim

Potential fields:

- id
- shopId
- orderId
- protectionPurchaseId
- claim type
- description
- submitted evidence
- tracking snapshot
- claim status
- decision status
- decision reasons
- risk flags
- AI analysis
- merchant decision
- resolution type
- refund amount
- replacement reference
- createdAt
- updatedAt
- resolvedAt

Suggested claim states may include:

```text
SUBMITTED
VALIDATING
AUTO_APPROVED
REVIEW_REQUIRED
MERCHANT_APPROVED
MERCHANT_REJECTED
REFUND_PENDING
REFUNDED
REPLACEMENT_PENDING
REPLACED
RESOLVED
```

Do not assume these exact enums already exist. Match the repository implementation.

---

## Webhooks

Expected Shopify webhook topics may include:

```text
orders/create
orders/paid
orders/cancelled
refunds/create
app/uninstalled
```

Additional fulfillment or delivery-related topics may be added if required.

Webhook handlers must:

1. verify Shopify authenticity/HMAC
2. validate payload structure
3. be idempotent
4. persist required changes
5. return quickly
6. move slow work to a background job when appropriate

Shopify may retry webhook deliveries.

Never assume a webhook runs exactly once.

Use stable Shopify IDs and/or webhook event IDs to prevent duplicate processing.

---

## Idempotency Requirements

Idempotency is critical.

The system must prevent accidental duplication of:

- protection purchase records
- claim resolutions
- refunds
- replacement orders
- webhook side effects

Any operation that moves money or creates Shopify resources should have an idempotency strategy.

Before issuing a refund or replacement, check whether the action has already completed or is already in progress.

---

## Analytics

The merchant dashboard should eventually support metrics such as:

### Attach Rate

```text
protected eligible orders / total eligible orders
```

### Protection Revenue

Total protection fees collected.

### Protection Refunds

Protection fees refunded.

### Claim Rate

```text
claims submitted / protected orders
```

### Approval Rate

Track separately for:

- auto-approved claims
- merchant-approved claims

### Claims Cost

Total value of refunds, replacements, store credit, or other claim resolution costs.

### Loss Ratio

```text
claims cost / protection revenue
```

### Net Protection Revenue

Exact accounting definition must be explicit.

Potentially:

```text
protection revenue
- protection refunds
- claim costs
- app/provider fees
= net protection contribution
```

Do not label a metric "profit" unless all relevant costs are actually included.

---

## Claims Flow

The intended claim flow is:

```text
Customer submits claim
        |
        v
Verify protection exists
        |
        v
Verify claim window
        |
        v
Validate order + fulfillment + tracking data
        |
        v
Check duplicate claims / prior resolutions
        |
        v
Evaluate deterministic claim rules
        |
        v
Optional AI-assisted evidence analysis
        |
        +---------------------+
        |                     |
        v                     v
AUTO_APPROVE          REVIEW_REQUIRED
        |                     |
        v                     v
Resolve claim         Merchant review queue
```

---

## Claim Validation

Before making any decision, verify at minimum:

- the Shopify order exists
- protection was actually purchased
- protection is still valid
- claim is within the permitted claim window
- the claim has not already been resolved
- the same order/issue is not already covered by another open claim
- submitted evidence meets any applicable requirements
- tracking/fulfillment data is consistent with the claim type

Potential risk signals may include:

- package marked delivered while claim says never delivered
- repeated claims by the same customer
- duplicate evidence
- inconsistent timestamps
- multiple claims against the same fulfillment
- unusually high order value
- suspiciously repeated addresses or identifiers

Risk signals should trigger review, not automatic denial.

---

## AI Usage

AI may assist with claims, but it should not be the sole decision-maker.

Appropriate AI tasks include:

- summarizing claim descriptions
- extracting structured facts from submitted text
- classifying claim type
- comparing descriptions with tracking/order data
- identifying inconsistencies
- analyzing uploaded images for visible evidence
- producing a confidence score
- generating merchant review summaries

Do not ask an LLM a vague question such as:

```text
Should this claim be accepted?
```

Instead, combine:

- deterministic eligibility rules
- Shopify data
- carrier/tracking data
- evidence
- risk flags
- AI-assisted analysis

The final automation should be explainable.

Store decision reasons and important inputs.

---

## Auto-Approval

A claim should only be auto-approved when the relevant rules are satisfied.

An example policy could require:

- valid protection purchase
- claim is inside the claim window
- order value is under merchant auto-approval threshold
- claim type is eligible
- tracking/evidence supports the claim
- no duplicate claim
- no relevant fraud/risk flags
- confidence exceeds configured threshold

This is only an example.

Merchant-specific rules should be configurable.

---

## Merchant Review Queue

Claims that cannot be safely auto-approved should appear in an embedded Shopify Admin claims interface.

A review item should expose enough context for a merchant to make a decision quickly.

Example:

```text
Claim #1837
Order #10492

Reason:
Package not received

Tracking:
Marked delivered

Risk / review flags:
- Delivered scan exists
- Customer had another claim within 60 days

Suggested action:
Review required
```

Merchant actions may include:

- approve refund
- approve replacement
- issue store credit
- reject claim

Merchant review decisions must be persisted with:

- actor
- timestamp
- decision
- reason if provided
- resulting Shopify action

---

## Claim Resolution

Approved claims should be resolvable with minimal merchant involvement.

Potential resolution types:

- refund
- replacement order
- store credit

Shopify Admin GraphQL should be used for privileged actions.

For refunds, use the appropriate Shopify Admin GraphQL mutation such as `refundCreate` where supported.

Any refund or replacement workflow must be idempotent.

The app should track:

- requested resolution
- Shopify operation ID
- status
- errors
- retry count if relevant
- completed timestamp

Never retry a financial action blindly.

---

## Shopify Admin Experience

The app should eventually provide:

- overview dashboard
- attach rate
- protection revenue
- claims statistics
- loss ratio
- merchant configuration
- claims review queue
- individual claim detail
- order-linked protection information

Useful Shopify-native integrations may include:

- order tags
- metafields
- Admin blocks
- Admin actions

Do not misuse Shopify Returns as a generic claim-ticketing system.

The app should own its own claims model.

External support integrations such as Gorgias or Zendesk may be added later.

---

## Authentication and Security

All privileged Shopify API calls must originate from trusted backend code.

Never expose:

- Shopify Admin access tokens
- API secrets
- webhook secrets
- database credentials
- AI provider secrets

Frontend/extension requests to the backend should be authenticated using Shopify-supported mechanisms such as session tokens where appropriate.

Validate:

- shop identity
- user/session identity where required
- request payloads
- authorization for every merchant-scoped operation

Never trust a `shopId`, order ID, claim ID, or similar identifier provided by the frontend without checking ownership.

---

## Multi-Tenancy

This is a multi-merchant Shopify app.

Every merchant-scoped database query must be tenant-safe.

A merchant must never be able to retrieve or mutate another merchant's:

- orders
- settings
- protection purchases
- claims
- analytics
- customer information

Prefer query patterns that always scope by `shopId`.

---

## Privacy and Data Minimization

Avoid storing unnecessary customer personal information.

Where possible, store Shopify references instead of duplicating full customer records.

If evidence uploads are implemented:

- use private storage
- use signed URLs
- define retention policies
- validate file type and size
- do not make evidence publicly accessible

Logs should never contain secrets and should avoid unnecessary personal information.

---

## Error Handling

Errors should be:

- structured
- logged with useful context
- safe to retry where appropriate
- visible to merchants when action is required

Do not swallow webhook or Shopify API failures.

For external API failures:

- classify retryable vs non-retryable errors
- use exponential backoff when appropriate
- avoid infinite retry loops
- preserve enough state to investigate failures

---

## Background Jobs

Use background processing for slow or retryable work such as:

- tracking/carrier lookups
- AI claim evaluation
- large webhook follow-up processing
- sending notifications
- asynchronous Shopify operations
- analytics aggregation

Do not introduce a queue solely for architectural purity.

Add one when synchronous processing becomes unreliable or too slow.

---

## Testing Expectations

Important logic should have automated tests.

Prioritize tests around:

- protection price calculations
- claim eligibility
- auto-approval rules
- escalation rules
- tenant isolation
- webhook verification
- webhook idempotency
- refund idempotency
- duplicate claim detection
- analytics calculations

When fixing a production bug, add a regression test when practical.

Do not mock away the business logic being tested.

---

## Coding Guidelines

### TypeScript

Prefer strict types.

Avoid `any` unless there is a specific reason.

Validate all external input.

Examples of external input include:

- Shopify webhook payloads
- extension requests
- claim forms
- Admin UI forms
- AI model output
- carrier APIs

Use schemas where appropriate.

---

### Database

Prefer:

- migrations
- explicit constraints
- unique indexes
- foreign keys
- transactions for related financial/state changes

Do not rely solely on application logic to prevent duplicate financial records.

---

### Shopify GraphQL

Prefer Shopify Admin GraphQL over legacy REST for new functionality.

When adding queries or mutations:

- request only required fields
- respect Shopify API cost limits
- handle pagination correctly
- use Shopify global resource IDs correctly
- log GraphQL user errors
- do not treat HTTP 200 as automatic mutation success

---

## Auditability

Claims and financial operations must be explainable after the fact.

Preserve important state transitions such as:

```text
claim submitted
eligibility verified
rule evaluation completed
AI analysis completed
claim auto-approved
merchant review requested
merchant approved/rejected
refund requested
refund completed
```

For automated decisions, retain:

- rule version
- decision reason
- confidence if used
- relevant risk flags
- input references

Avoid storing unnecessary raw AI chain-of-thought.

Store concise decision summaries instead.

---

## Legal / Product Boundary

The commercial product must not casually describe itself as regulated "insurance" without confirming the legal structure.

There is an unresolved legal/product question around whether the service is:

- insurance
- merchant-provided shipping protection
- a warranty-like product
- another form of contractual protection

This affects:

- wording
- disclosures
- claims liability
- licensing
- merchant agreements
- customer rights

In Australia, consumer rights under Australian Consumer Law must not be represented as being removed or replaced by paid protection.

Agents working on code should not invent legal wording.

Use neutral placeholders until product/legal decisions are confirmed.

---

## Product Direction

The product should evolve in this order unless repository state suggests otherwise:

### Phase 1 — Protection Purchase

- display protection offer
- calculate protection fee
- record customer opt-in
- persist completed protected orders
- handle relevant webhooks

### Phase 2 — Merchant Analytics

- attach rate
- protection revenue
- refunds
- protected orders
- basic dashboard

### Phase 3 — Claims

- customer claim submission
- claim validation
- merchant claim management
- manual resolutions

### Phase 4 — Claims Automation

- deterministic rules engine
- carrier/tracking integration
- AI-assisted evaluation
- auto-approval
- review escalation
- automated refunds/replacements

### Phase 5 — Optimization

- merchant-specific rule tuning
- pricing experiments
- advanced analytics
- support platform integrations
- fraud/risk improvements

Do not overbuild later phases before the underlying purchase and order data is reliable.

---

## Agent Working Rules

When making changes to this repository:

1. Inspect the existing codebase before proposing architecture changes.
2. Follow the current framework and project conventions.
3. Do not replace working infrastructure without a clear reason.
4. Preserve tenant isolation.
5. Preserve webhook idempotency.
6. Treat refunds and replacements as financial operations requiring strong safeguards.
7. Keep the Shopify extension lightweight.
8. Keep privileged logic server-side.
9. Use Shopify GraphQL for new Admin API work unless there is a specific reason not to.
10. Do not auto-deny claims.
11. Do not treat AI output as trusted input.
12. Validate all model output before acting on it.
13. Avoid storing unnecessary customer data.
14. Prefer incremental, testable changes.
15. Add tests for important business rules.
16. Document new environment variables.
17. Never commit secrets.
18. Do not invent legal claims or compliance guarantees.
19. When requirements are ambiguous, prefer the safer reversible implementation.
20. Explain any change that could affect merchant money, customer refunds, or claim decisions.

---

## Definition of a Good Implementation

A good implementation should make the following flow reliable:

```text
Merchant installs app
    ->
Merchant configures protection
    ->
Customer opts into protection
    ->
Shopify order completes
    ->
Protection purchase is recorded exactly once
    ->
Merchant sees accurate analytics
    ->
Customer submits claim
    ->
System validates eligibility
    ->
Clear valid claim resolves automatically
    OR
    ->
Uncertain claim reaches merchant review
    ->
Merchant selects resolution
    ->
Shopify action executes exactly once
    ->
Claim history remains auditable
```

Reliability, auditability, merchant trust, and safe automation are more important than unnecessary architectural complexity.
