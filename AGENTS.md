# AGENTS.md

This repository is a multi-tenant Shopify app for merchant-provided shipping protection, returns, and claims management.

## Always apply

- Shipping protection is the current priority: make the offer, pricing, order ingestion, and dashboard reliable at live-store scale before expanding claims, returns, or intake. Future roadmap details are not current implementation requirements.
- Use one codebase for unrelated merchants. Resolve tenant identity from trusted authentication, verify resource ownership, and scope all merchant-owned data; drive differences through configuration and specific capability checks.
- Shopify is authoritative for commerce records; the application database owns application state. Frontend events are funnel analytics, never financial truth.
- Keep secrets and privileged operations server-side. Treat external input, including AI output, as untrusted.
- Preserve financial idempotency and historical auditability. Changes must never block checkout.
- The initial release is for US stores. US copy may offer protection for stolen, damaged, and undelivered packages. Australian stores come later with their own wording and settings; for them, never sell or gate existing Australian Consumer Law remedies as protection.
- Do not invent legal/compliance guarantees. Customer-facing copy uses “shipping protection” unless legal review confirms otherwise.
- Before fixing a bug you were asked to fix, step back and find its root cause; fix that rather than patching the symptom where it surfaced.
- Don't hide broken functionality: let it fail fast and visibly (throw, report) instead of masking it with silent fallbacks or defaults. Checkout is the exception: it must never be blocked, so degrade there and report the failure.

## Keeping docs current

- When a change alters setup, commands, configuration, deployment, or behavior that `README.md` or `docs/` describes, update that documentation in the same change. Only write what you have verified in code, config, or command output; leave uncertain details out rather than guessing.
- `README.md` is the owner's concise operator reference. Keep it short and current; put design detail in `docs/agents/` and release evidence, one-off migration notes, and recovery procedures in `docs/production-readiness.md`.

## Codex workspaces

- Create Codex Git worktrees as sibling directories in the parent `yasas` directory, using `../insurance-<task-name>` relative to this repository root. Keep worktrees outside this repository so Shopify CLI does not discover conflicting app configurations during type checking or releases.
- Reuse the current worktree when already working in one; do not create nested worktrees.
- After merging, remove Codex-created worktrees only when they are clean and their commits are merged. Preserve other agents' worktrees and unfinished work.

## Build and type checking

- `npm run build`: builds the React Router app.
- `npm run typecheck`: generates React Router and Cart Transform types, then checks JavaScript/JSX, both extensions, and the E2E project. Use this script rather than plain `tsc`. New files match the surrounding language.

## Read when relevant

Open the linked guidance for the task being performed; follow its links when a task crosses boundaries.

| Task | Instructions |
| --- | --- |
| Scope, roadmap, pilot economics | [Product direction](docs/agents/product-roadmap.md) |
| Modules, routes, stack, architecture | [Application boundaries](docs/agents/architecture.md) |
| Tenant data, settings, capability checks | [Merchant configuration](docs/agents/merchant-configuration.md) |
| Checkout, Cart Transform, pricing, purchases | [Protection](docs/agents/protection.md) |
| Orders, refunds, webhooks, side effects | [Orders and idempotency](docs/agents/orders-webhooks.md) |
| Existing claims or future cases/returns | [Cases, claims, and returns](docs/agents/claims-returns.md) |
| Future email, form, or Admin intake | [Claim intake](docs/agents/claims-intake.md) |
| Future claim validation, AI, decisions, resolutions | [Claim automation](docs/agents/claim-automation.md) |
| Dashboard metrics and payout accounting | [Analytics and payouts](docs/agents/analytics-payouts.md) |
| Navigation, dashboard, settings, Polaris | [Merchant Admin UI](docs/agents/admin-ui.md) |
| Authentication, schema, privacy, audit records | [Data and security](docs/agents/data-security.md) |
| Distribution, deployment, workers, reliability | [Operations](docs/agents/operations.md) |
| Code changes, GraphQL, testing, refactors, pushes | [Development workflow](docs/agents/development.md) |
| Benefits, public copy, liability, legal decisions | [Legal/product boundary](docs/agents/legal-product.md) |
