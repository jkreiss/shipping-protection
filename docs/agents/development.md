# Coding, GraphQL, testing, and refactor workflow

Read before code changes, new Shopify API operations, significant refactors, or pushes.

[Back to root instructions](../../AGENTS.md). Related: [Application boundaries](architecture.md); [tenant/data security](data-security.md).

## Coding Guidelines

### Types

Code must pass `npm run typecheck` (`tsc` over JS/JSX, and both extensions). Add JSDoc types where they clarify money, IDs, or external payloads.

Avoid `any` unless there is a concrete reason.

Validate external input.

Use schemas where useful.

Do not create abstract type systems that are more complicated than the domain itself.

### Server-only code

Mark and organize server-only modules clearly.

Secrets, database access, privileged Shopify API access, and merchant-sensitive business logic must remain server-side.

### Routes

Routes should primarily:

1. authenticate
2. resolve tenant
3. validate input
4. call domain/application code
5. format response

If a route contains large pricing, claim, return, or merchant-policy logic, extract it.

### Imports

Avoid dependency cycles.

Domain logic should not depend on route modules.

Shopify integration code should not become the only place business rules can execute.

## Shopify GraphQL

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

## Testing Expectations

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

## Before Significant Refactors

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

## Working practices

- Inspect the repository before proposing architectural changes, and follow current framework/project conventions.
- Do not rewrite working functionality without a clear reason; prefer incremental, testable changes.
- Document new environment variables.
- Never commit secrets.
- Prefer reversible implementations when requirements remain uncertain.
- Explain changes that affect merchant money, customer refunds, or claim decisions.
- Do not create abstraction layers without at least one concrete current use.
