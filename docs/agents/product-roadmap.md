# Product direction and current scope

Read when planning features, changing product scope, or discussing pilot economics. Phases 3–5 describe future direction, not authorization to build them now.

[Back to root instructions](../../AGENTS.md).

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

## Current Focus

Shipping protection comes first.

Until the shipping protection offer, pricing, order ingestion, and merchant dashboard are reliable and scalable on a live, high-volume store, do not build claims, returns, or claim intake beyond what already exists. Claims and returns sections below describe the intended direction, not current work.

The first production merchant is expected to be a live store with roughly $20M in annual revenue, run as a pilot:

- the merchant keeps protection revenue and pays claims directly
- the goal is to learn real attach rates, claim rates, and payout costs so a profitable price can be set
- design and test for that scale (see [Scale and Reliability](operations.md#scale-and-reliability))

The default rate of 25 basis points (0.25%) is a placeholder, not a considered price.

How the app provider gets paid (revenue share, profit share, or taking a larger share and paying claims directly) is undecided. Record data so that any of these can be calculated later; do not build billing for one model yet.

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

## Product Direction

The broad product direction is:

### Phase 1 — Reliable protection purchase (current)

- protection offer
- pricing
- customer selection
- completed-order verification
- protection purchase persistence
- webhook reliability
- tenant-safe merchant configuration
- scale hardening for the pilot store (see [Scale and Reliability](operations.md#scale-and-reliability))

### Phase 2 — Merchant analytics/configuration (current)

- attach rate
- revenue
- protected orders
- merchant settings
- capability resolution
- Overview dashboard and Settings

### Phase 3 — Claims and returns MVP

One complete, manually operated loop from customer request to resolution. Claims and returns ship together, because a free return is a protection benefit and is not usable without a label.

- payout recording; this can ship ahead of the rest, because pilot pricing depends on it
- per-store benefit configuration (theft, free returns), return window, and pricing per benefit set
- Case model with covered / store-responsibility classification
- intake: email forwarding is the first product (see [Email intake](claims-intake.md#email-first-intake-channel)). Merchants keep handling customer requests by email; the app automates what happens after the email arrives. Merchant-created cases in Admin cover anything forwarding misses.
- structured extraction from forwarded emails (AI-assisted, validated) into a Case; unclear requests and missing order references go to review, never to rejection
- Claims & Returns queue, case detail, and order-linked context (Admin block/action on the order page)
- one-click review: the app prepares everything (extracted facts, matched order, coverage label, proposed resolution and label), and staff such as warehouse workers approve it, change it, reject it, or ask for more information. Nothing executes without a person approving. Record which Shopify staff member approved each case.
- resolutions executed through Shopify exactly once: refund, replacement order, store credit, exchange
- returns: Shopify Returns, return label integration, label delivered to the customer, item tracked back, refund or exchange on receipt
- customer status updates by email for the steps they act on (label issued, return received, resolved)
- payouts recorded automatically from resolutions; claims paid, claim rate, and loss ratio on the Overview

### Phase 4 — Automation

- deterministic eligibility and approval rules
- carrier/tracking integration
- AI-assisted analysis and review summaries
- auto-approval within merchant-configured limits
- automated resolutions and labels for auto-approved cases
- fraud/risk signals that route to review

### Phase 5 — Optimization

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

## Definition of a Good Implementation

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
