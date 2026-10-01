# Claim validation, AI, decisions, and resolution

Future direction only: read when planning claim policy, automation, review escalation, or financial resolutions.

[Back to root instructions](../../AGENTS.md). Related: [Case/return model](claims-returns.md); [financial idempotency](orders-webhooks.md); [audit records](data-security.md); [legal boundaries](legal-product.md).

## Never auto-deny claims by default

The intended automated decision model is:

```text
AUTO_APPROVE
REVIEW_REQUIRED
```

If a claim appears unsupported, suspicious, contradictory, or uncertain, escalate it to merchant review.

Do not implement automatic rejection unless product/legal direction explicitly changes.

Merchant users may still manually reject claims during review.

## Claim Validation

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

## Claim Decision Model

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

## AI Usage

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

## Claim Resolution

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
