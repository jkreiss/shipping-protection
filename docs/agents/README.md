# Agent guidance structure and refactor review

The root [AGENTS.md](../../AGENTS.md) contains the project description, universal constraints, build/typecheck entry points, and a task-based reading index. Read topic files only when relevant; related links connect tasks that cross boundaries.

This file records the refactor, rather than adding implementation requirements. The existing [production-readiness checklist](../production-readiness.md) remains in place.

## Folder structure

```text
AGENTS.md
docs/
├── production-readiness.md          # existing operational checklist
└── agents/
    ├── README.md                   # structure, decisions, preservation, deletion candidates
    ├── product-roadmap.md          # current scope, pilot, future phases and examples
    ├── architecture.md             # stack, repository layout and domain boundaries
    ├── merchant-configuration.md   # tenancy, settings and capability resolution
    ├── protection.md               # extensions, Function runtime, pricing and purchases
    ├── orders-webhooks.md          # commerce truth, webhook processing and idempotency
    ├── claims-returns.md           # future shared Case, claims and return logistics
    ├── claims-intake.md            # future email, customer replies, forms and Admin intake
    ├── claim-automation.md         # future validation, decisions, AI and resolution
    ├── analytics-payouts.md         # metric definitions and future payout accounting
    ├── billing.md                  # revenue-share billing through the Shopify Billing API
    ├── admin-ui.md                 # navigation, Polaris, Overview and merchant review
    ├── data-security.md            # authentication, Prisma, privacy and auditability
    ├── operations.md               # distribution, Railway, workers and scale
    ├── development.md              # coding, GraphQL, tests and refactor workflow
    └── legal-product.md            # benefit boundaries, wording and unresolved risk
```

These are ordinary Markdown files, explicitly linked from the root, rather than additional automatically applied AGENTS.md files. Future roadmap sections remain labelled as future direction.

## Contradictions and decisions

| Original instructions | Decision | Result |
| --- | --- | --- |
| Accept inbound email only from registered merchant senders, but also thread customer replies into the case. | User chose registered/authenticated merchant senders for new forwards, and the case's verified customer plus a case token for replies. | [Claim intake](claims-intake.md) distinguishes new cases from replies and retains tenant/ownership checks. |
| Phase 3 specified provider-paid free-return labels, while pilot claims are merchant-funded and provider risk is unresolved. | User said label funding is unnecessary agent context unless specifically stated, because it does not contribute to current code. | Removed the payer assumption from the Phase 3 label requirement and return-origin description. Preserved return logistics, accounting fields, and independent legal risk boundaries. |

The original provider-paid wording is historical context for this decision, not a standing product requirement. Specify funding in a future task when it affects implementation.

These apparent tensions are already qualified in the source and do not require a policy choice:

- Shipping protection is the current focus; claims/returns are future roadmap work. Manual payout recording may ship ahead of the claims MVP.
- Business logic belongs in the backend, with an explicit exception for logic required to execute in Shopify Functions.
- Phase 3 requires human approval; Phase 4 introduces configured auto-approval. Uncertain claims go to review, never automatic denial.
- The current `LOST | STOLEN | DAMAGED` schema and setup flags are legacy implementation facts, with explicit instructions to revisit them before claims work. They do not authorize selling benefits excluded by the legal/product guidance.
- Billing is deferred until the payment model is decided; adding billing before charging a merchant is a later milestone gate.

## Root essentials

- One sentence describing the project.
- Current protection-first scope, one shared codebase, tenant safety, commerce/application sources of truth, trusted execution, financial integrity, checkout safety, and legal/product guardrails.
- `npm run build` and the non-standard `npm run typecheck` pipeline. The typecheck description reflects the current package script, including the E2E project.
- A reading index with concrete task triggers.

There is no separate package-manager rule: the project uses npm. Detailed technology versions, models, UI conventions, future features, and deployment procedures belong in the topic files.

## Preservation map

Original section content was moved with its examples, field lists, formulas, dates, implementation caveats, and future-work qualifiers. Heading levels and cross-file references were adjusted for navigation. The duplicate working-rules checklist was consolidated, the email rule was clarified according to the user's choice, and the label-payer wording above was removed at the user's direction.

| Destination | Original sections |
| --- | --- |
| [Product roadmap](product-roadmap.md) | Project Overview; Current Focus; Product Goals; Product Direction; Definition of a Good Implementation |
| [Architecture](architecture.md) | Backend owns application business logic; Technology Stack; Current Repository Direction; Preferred Application Boundaries |
| [Merchant configuration](merchant-configuration.md) | This is a multi-tenant application; Configuration drives behavior; Merchant Configuration; Resolved Capabilities |
| [Protection](protection.md) | Keep Shopify extensions thin; Shopify Protection Strategies; Protection Pricing; Protection Purchase Model |
| [Orders/webhooks](orders-webhooks.md) | Shopify remains the commerce source of truth; Webhooks; Idempotency |
| [Cases/returns](claims-returns.md) | Customer requests should normalize into one model; The application owns claims and tickets; Cases, Claims, and Returns; Returns |
| [Intake](claims-intake.md) | Claims Intake, including email sending, replies, merchant copies, mailbox restrictions, forms and Admin creation |
| [Claim automation](claim-automation.md) | Never auto-deny claims by default; Claim Validation; Claim Decision Model; AI Usage; Claim Resolution |
| [Analytics/payouts](analytics-payouts.md) | Payouts; Analytics, including every metric definition and accounting convention |
| [Admin UI](admin-ui.md) | Merchant Admin UI; Merchant Review in Shopify Admin |
| [Data/security](data-security.md) | Authentication and Security; Data Model and Database; Privacy and Data Minimization; Auditability |
| [Operations](operations.md) | Shopify Distribution; Deployment Architecture; Error Handling; Background Jobs; Scale and Reliability, including the dated fixed-gap history and remaining performance observation |
| [Development](development.md) | Coding Guidelines; Shopify GraphQL; Testing Expectations; Before Significant Refactors; unique Agent Working Rules |
| [Legal/product](legal-product.md) | Legal / Product Boundary |

### Consolidated Agent Working Rules

All 43 original checklist rules are accounted for below. Unique requirements such as documenting environment variables, choosing reversible implementations when uncertain, and explaining financial/decision changes remain in Development's working practices.

| Original rule numbers | Retained location |
| --- | --- |
| 1, 2, 3, 18, 19, 20, 21, 23, 24, 33 | Development: coding, testing, significant refactors, working practices |
| 4, 5, 6, 7, 28, 37 | Merchant configuration and root tenant/codebase constraints |
| 8, 9, 31 | Orders/webhooks and root commerce/financial integrity constraints |
| 10, 12, 41 | Protection: extension/Function boundaries and percentage conversion |
| 11, 17, 29, 32, 34 | Data/security, Protection pricing history, and root trusted-execution constraint |
| 13, 42 | Development: Shopify GraphQL |
| 14, 15, 16 | Claim automation and root untrusted-input constraint |
| 22, 40 | Legal/product and root legal guardrail |
| 25 | Architecture: no major infrastructure without a concrete operational need |
| 26, 27, 35, 38, 43 | Operations: origins, private workers, service responsibilities, environment distribution, scale; Development refactor checklist; root checkout safety |
| 30, 36 | Cases/returns: canonical app-owned state and shared intake model |
| 39 | Root protection-first scope and Product roadmap |

## Deletion candidates

Except for the duplicate checklist consolidation and the user-directed label-payer change, the candidates below remain in their topic files. They are flags for later editing, not evidence that useful project information was discarded.

| Candidate | Classification | Recommendation |
| --- | --- | --- |
| The 43-item Agent Working Rules section | Redundant restatement of domain guidance | Consolidated now; keep the domain rules and unique working practices listed above. |
| Repeated “Route handlers should remain thin” / routes-as-transport descriptions | Redundant across architecture, coding and working rules | Later consolidate around the explicit authenticate → tenant → validate → domain → response sequence. Keep the concrete extraction rule for pricing/policy logic. |
| Repeated multi-tenant / no merchant forks / no merchant-specific branches instructions | Redundant across overview, principles, roadmap and working rules | Keep the universal root rule and detailed ownership/capability requirements; trim further repetitions only if their examples add no value. |
| “Use configuration.” in Returns | Overly obvious given the surrounding domain rules | The tenant-aware return-policy requirement is already explicit; the standalone sentence can be removed later. |
| “Keep internal code boundaries clear.” in deployment guidance | Too vague on its own | The actual route/domain and web/worker responsibilities provide actionable guidance. Preserve those boundaries. |
| “Use schemas where useful.” | Too vague to select a validation approach | Replace when the repository adopts a specific validation convention; keep the requirement to validate external input. |
| “This order is not absolute.” | Too vague as a scheduling exception | Clarify exceptions in a future product task; keep the firm protection-first scope and explicit payout exception. |
| “A clean operational dashboard” | Subjective on its own | Keep its concrete questions, five tiles, chart, recent activity, and limits on reporting features. |
| The aspirational opening/closing product flow and repeated merchant examples | Potentially redundant product context | Kept in the roadmap because they explain scope and intended variability; remove only with an explicit decision that this context is no longer needed. |

Do not flag tenant isolation, idempotency, financial formulas, legacy-schema caveats, Shopify runtime constraints, legal gates, or historical pricing/audit data for deletion merely because agents might know general best practices. These are necessary project-specific requirements.
