# Commerce truth, webhooks, and idempotency

Read when changing order ingestion, reconciliation, webhook processing, refunds, or other external side effects.

[Back to root instructions](../../AGENTS.md). Related: [Worker/reconciliation behavior](operations.md); [database constraints and auditability](data-security.md).

## Shopify remains the commerce source of truth

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

## Webhooks

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

## Idempotency

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
