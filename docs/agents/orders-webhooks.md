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

Receipt status codes:

- A delivery that can never be stored (invalid shop domain, missing delivery ID, unsupported topic, no valid order ID, a shop with no installation record, or a delivery ID reused for a different event) throws `PermanentWebhookError`. The route reports `webhook_rejected` and returns 200, because Shopify's retries cannot change the outcome and repeated failures can remove the subscription. Reconciliation backfills 60 days of orders, so a real order dropped this way is recovered.
- Database and other errors still return 500 so Shopify retries.

Worker retries:

- A claim coalesces every queued delivery for the order, but a delivery still in backoff keeps its attempt count; only due deliveries spend an attempt. If that batch then loses a serialization conflict, a delivery that rode along from backoff returns unchanged.
- A serialization conflict (`P2034`) gives back the attempt the claim spent, once. If the delivery's previous error was also `P2034`, it takes the normal path instead: backoff, a `webhook_retry` report, and `FAILED` with `webhook_terminal` after the attempt budget.

Reconciliation failures: an order Shopify will never return complete (`PermanentOrderError`, including `OrderUnavailableError`) is reported as `reconciliation_order_failed`, counted in `ordersFailed`, and queued as a `RECONCILE` delivery, which the worker fails at once so a durable record exists. It does not count toward the three-in-a-row stop, so adjacent bad orders cannot hold back the cursor. Any other error is queued the same way and does count toward that stop.

Order edits: Shopify's line `quantity` includes refunded and removed units; `currentQuantity` excludes both. Normalization derives `removedQuantity` per line (`quantity - currentQuantity - refunded units`), and ingestion treats removed units as absent when deciding eligibility and whether protection was purchased, and leaves a fully removed merchandise line out of the covered amounts. The single-unit test and the charge check stay on the original quantities, because the Cart Transform priced the cart as it was at checkout. A protection line deleted by an order edit before payment records no purchase and no fee. The snapshot cannot say when an edit happened, so a protection line removed after payment but before the order is first stored is also read as not purchased; this needs ingestion to lag the payment webhook past a merchant edit. Refunds, removal from a cart before checkout, and purchases already confirmed are unchanged: the confirmed purchase stays immutable.

Recorded amounts: a line's `finalAmount` is what the buyer paid for it after every discount. Shopify's `discountedTotalSet` leaves out order-level discounts (and code-based ones unless asked), so normalization subtracts the line's `discountAllocations` too, taking the larger of the two discounts; a line without allocations, or with one that isn't in the shop currency, keeps `discountedTotalSet` rather than failing the order. `feeAmount`, `paidProtectionFee` and the covered merchandise therefore reflect what was collected. The live price check is separate: it compares list unit prices (`originalUnitPriceSet`, before every discount), because the Cart Transform prices the protection line before an order-level discount takes its share. Protection refund amounts come from refund line `subtotalSet`, not from these fields.

Refund rows: a refund on a protected order that now classifies as ignored (for example, its transaction failed and nothing was refunded) moves any earlier `PENDING` or `UNATTRIBUTED` row for it to `IGNORED`, which keeps the record but takes it out of the recheck queue and every total; a `CONFIRMED` row is never touched. Ignored refunds that were never stored are still not stored. The reconciliation recheck of pending refunds treats `OrderUnavailableError` as terminal, as the worker does: it marks that order's pending rows `UNATTRIBUTED` (amount kept, never counted as refunded), logs `refund_recheck_order_unavailable`, and does not report `refund_recheck_failed`. Unresolved (`PENDING` and `UNATTRIBUTED`) refunds appear in the Overview's review notice whatever the selected range, until they settle or retention removes them.

Purchases confirmed before 2026-10-09 recorded `feeAmount` and covered merchandise before order-level discounts; confirmed purchases are immutable, so those rows keep that definition.

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
