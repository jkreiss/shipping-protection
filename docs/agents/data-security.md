# Authentication, database, privacy, and auditability

Read when changing authentication, external-input handling, Prisma schema/migrations, customer data, evidence storage, or audit records.

[Back to root instructions](../../AGENTS.md). Related: [Tenant configuration](merchant-configuration.md); [external-side-effect idempotency](orders-webhooks.md); [AI output](claim-automation.md).

## Authentication and Security

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

## Data Model and Database

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

1. inspect the current Prisma schema and existing migrations
2. reuse existing concepts
3. avoid duplicate merchant/shop entities
4. preserve migration history
5. add only what the current feature needs

## Privacy and Data Minimization

Avoid storing unnecessary customer personal information.

Prefer Shopify references over duplicated customer profiles where practical.

The app uses Level 1 protected customer data only: order records keyed by order ID, with no customer names, emails, phones, addresses, or customer IDs. Requesting any of those fields needs a Level 2 access request first. Compliance webhooks (`app/routes/webhooks.privacy.jsx`):

- `customers/redact` deletes the listed orders and their purchases, refunds, lines, claims, and webhook deliveries in that shop.
- `shop/redact` deletes all of the shop's data.
- `customers/data_request` is acknowledged; stored order records hold no customer details to return.

Order records are kept for at most 24 months from when the order was placed (`retentionCutoff` in `app/order-retention.js`; 29 February maps to 28 February), the ceiling the privacy policy states. `persistNormalizedOrder` skips any order already past it, so a late webhook or reconciliation can't recreate a purged record; its deliveries still complete. The worker's reconciliation loop runs the purge (`app/order-retention.server.js`) on start and then daily, through the same deletion path as `customers/redact`. Each transaction deletes up to 500 orders from one shop; each turn stops after a minute or on shutdown and continues on the next pass. A completed run also removes finished webhook deliveries received before the cutoff. Any new table holding order-derived data must be added to `deleteOrderRecords` in `app/shop.server.js`.

If evidence uploads are implemented:

- use private storage
- use signed/short-lived access URLs
- validate file types and sizes
- define retention rules
- never expose evidence publicly by default

Logs should not contain secrets or unnecessary personal information.

Email ingestion must avoid retaining unrelated inbox content.

## Auditability

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
