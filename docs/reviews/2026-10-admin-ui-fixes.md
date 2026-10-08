# Section 6: Admin UI and analytics dispositions

Implemented from `main` at `8b3fa96`, following section 6 of the October 2026
bug review. Financial definitions and future claims functionality are unchanged.

| Finding | Disposition and evidence | Regression coverage |
| --- | --- | --- |
| Fresh-install parent/child loader race | Unconfirmed. `ShopAwareSessionStorage.storeSession` awaits the shop upsert before storing the session, which references the shop through a foreign key. Removed the parent loader's redundant upsert; retained authentication and the protection reader's Shopify shop-ID update. | Existing shop/session tests; tenant readers reject missing shops before reading merchant records. |
| Dangling Settings label/example | Already fixed on main. Default and placeholder are “Add shipping protection”; the fee example matches checkout's current format. | Existing Settings UI and shared checkout-copy contract tests. |
| Revenue lost across midnight | Not reproduced through supported ingestion. Confirmed purchases use the order's `firstPaidAt`; migration `20260929000000_durable_protection_claims` copies that timestamp to historical purchases. Keep completed-payment revenue dating and existing filters. | Ingestion asserts matching order/purchase timestamps at payment and after edits. |
| Currency mismatch understates attach rate | Not reproduced through supported writes. Ingestion and the durable-purchase migration copy the order snapshot currency into the purchase. Keep shop-currency filtering and existing metric definitions. | Ingestion asserts matching order/purchase currencies at payment and after edits; existing analytics mismatch notices. |
| Identical successful saves omit toast | Fixed. A ref records the handled response object; only a new successful response at fetcher `idle` shows feedback. | Mounted effects: repeated identical successes, rerenders, retained responses during submission, failed saves. |
| Host locale/timezone dates | Fixed. Overview money, counts, chart labels, activity dates and sync timestamps use `en-US`. Timestamps use the merchant timezone; date-only chart labels retain UTC anchoring. Claims fetch `ianaTimezone` through the authenticated Admin client for submitted dates. | Rendering and hydration with differing host defaults; midnight and DST boundaries; Claims query syntax, timezone retrieval, tenant scope. |
| Injected reporting clock ignored | Fixed. `now` reaches `analyticsRange` as well as sync staleness. | January 2020 clock with a different Sydney/UTC calendar date: range, query bounds, and 30-day trend endpoints. |
| Duplicate shop reads/upserts and serial activity | Fixed for section 6. Overview resolves the shop once and starts analytics/activity together. Parent loader authenticates without another upsert. | One Overview shop lookup; tenant-scoped reads; activity starts while Shopify analytics remains pending. |
| Stray Settings whitespace | Removed the dead whitespace expression after supporting text. | Existing Settings rendering tests. |

Regression tests reproduced the missing second toast, real-clock range,
host-locale Overview rendering, and incorrect midnight claim date before fixes.
A separate review found no production correctness issue and requested stronger
native locale-method test coverage; that coverage was added and verified with a
reverted protected-order count formatter.

Verification and MCP evidence are recorded in
[production readiness](../production-readiness.md). Local checks do not establish
a live-store browser or deployment result.
