# Analytics and payout accounting

Read when changing Overview metrics, financial reporting, or planning payout recording. Payout recording is future work that may ship ahead of the claims MVP.

[Back to root instructions](../../AGENTS.md). Related: [Pricing history](protection.md); [commerce source of truth](orders-webhooks.md); [scale/performance](operations.md).

## Payouts

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

## Analytics

The Overview currently shows a fixed 30-day window of the metrics below (`app/analytics.js`, `app/analytics.server.js`).

Conventions:

- dates use the shop's time zone
- revenue is dated by completed payment; refunds by successful refund transaction
- test orders are excluded unless the merchant chooses to include them
- only shop-currency records count; others are reported as data-quality notices

### Attach Rate

```text
protected eligible paid orders / eligible paid orders
```

Eligibility is an order-based estimate, because checkout exposure is unknown.

### Protection Revenue

Total completed protection fees.

### Protection Refunds

Protection fees refunded.

A refund counts once its money has settled (successful refund transactions cover the refund's total) and has no unsettled refund transaction. Attribution:

- A restock-only refund that moved no money is ignored.
- If protection is the only refunded line, the amount is the smaller of the protection line subtotal and the money refunded.
- If other lines were refunded too, the full protection subtotal counts only when the money refunded covers every refunded line. A smaller refund can't be split between lines, so it is left unattributed rather than prorated.

### Claims Paid

Total covered payouts (theft, and free-return shipping/handling). Always zero until payouts are recorded (see [Payouts](#payouts)).

### Net Protection Revenue

```text
protection revenue - protection refunds - claims paid
```

### Claim Rate

```text
protected orders with a covered payout / protected orders
```

Together with attach rate and average payout, this is the main input for finding a profitable price. Raising the fee usually lowers attach rate, so watch both when the rate changes.

### Approval Rate

Track separately where useful:

- auto-approved
- merchant-approved

### Loss Ratio

```text
claims paid / protection revenue
```

Store-responsibility costs never enter claims paid or loss ratio.

### Net Protection Contribution

A later extension of net protection revenue that also subtracts provider/app costs. Define the accounting explicitly before showing it.

Do not label a metric `profit` unless all relevant costs are included.

All analytics must be tenant-scoped.
