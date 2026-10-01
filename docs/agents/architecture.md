# Architecture and application boundaries

Read before changing module boundaries, routes, infrastructure choices, or the project stack.

[Back to root instructions](../../AGENTS.md). Related: [Coding and significant refactors](development.md); [deployment/service boundaries](operations.md).

## Backend owns application business logic

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

## Technology Stack

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

Do not add microservices merely for future scalability.

Do not migrate the backend to Python unless product requirements change materially.

## Current Repository Direction

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

## Preferred Application Boundaries

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

### `app/merchant`

- merchant lookup
- tenant identity
- merchant configuration
- capability resolution
- merchant-specific settings
- configuration validation

### `app/shopify`

- Shopify Admin API adapters
- Shopify authentication helpers
- Shopify order lookup
- Shopify refund/replacement integrations
- webhook-specific helpers
- Shopify capability discovery
- Shopify ID normalization

### `app/protection`

- protection eligibility
- pricing logic
- protection purchase rules
- protection state

### `app/claims`

- claim creation
- claim normalization
- claim eligibility
- claim policy evaluation
- merchant review state
- resolution orchestration

### `app/returns`

- return eligibility
- free-return rules
- return workflows
- labels/integration adapters where later implemented

### `app/routes`

Transport and UI entry points only.

Routes may:

- authenticate
- validate input
- call application/domain functions
- translate results to HTTP/React responses

Routes should not become the primary home for business rules.

Do not introduce generic `services/`, `repositories/`, `use-cases/`, `ports/`, or `adapters/` layers unless the project genuinely benefits from them.

Prefer simple domain modules first.
