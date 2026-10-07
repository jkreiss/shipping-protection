# Merchant Admin UI

Read when changing navigation, Overview, Settings, Polaris components, or future merchant review surfaces.

[Back to root instructions](../../AGENTS.md). Related: [Metric definitions](analytics-payouts.md); [percentage conversion](protection.md#protection-pricing); [legal copy](legal-product.md); [capability resolution](merchant-configuration.md).

## Merchant Admin UI

Navigation under the app:

```text
Overview            /app/overview  (dashboard; /app redirects here)
Claims & Returns    /app/claims
Settings            /app/settings
```

App Bridge hides the `rel="home"` link from the sidebar. That is why the dashboard has its own `/app/overview` route: so "Overview" appears as a menu item.

Overview:

- a clean operational dashboard, not a dense reporting tool
- answers: Is protection active? What revenue is it generating? What share of customers choose it? What has been paid in claims? What is net protection revenue?
- shows status and rate, five metric tiles, a 30-day revenue chart, recent activity, and a short data-quality warning only when there are issues
- do not add date-range pickers, breakdowns, exports, or a separate Analytics page until deeper reporting is actually needed

Settings: protection readiness, a grouped **Checkout offer** block (pricing and
customer-facing text), and "Can't see protection at checkout?" placement
instructions. Hide setup actions when ready; show "Set up protection" for a first
installation and "Update protection setup" when an existing setup needs attention.
Show only failing checks. Readiness confirms the backend setup, not checkout
block placement. Do not show a product editor or Requirements sidebar. Rate
editing is operator-controlled per store; restricted stores see the current rate
as text with no rate form. Enforce the restriction server-side.

Copy has its own operator-controlled editing permission.
Locked stores see current values without the corresponding form. Enforce both
permissions server-side, and preserve the other settings when saving one editor.
Blank copy fields restore translated defaults; always show the fee and store
disclosure. The placement instructions use Settings → Checkout → Configure →
Edit and suggest placing the block directly under “Shipping method”.

Existing checkout protection setups have a "Turn off shipping protection"
button. Confirmed disabled checkout and pricing configurations show "Off" and
"Turn on shipping protection"; expected disabled flags are not setup failures.
Keep genuine setup failures visible. Turning it back on uses the existing setup
checks and saved rate. Turning it off preserves the checkout block, product,
historical pricing rules, and existing purchases. Disable Settings actions while
a change is saving.
The Overview also shows "Off" with a link to manage protection in Settings;
reserve "Finish setup" for stores whose setup actually needs attention.

Copy:

- plain language merchants understand, with no basis points or internal jargon
- never imply protection covers what Australian Consumer Law already requires

Components:

- use Polaris web components, and check their props against `@shopify/polaris-types`
- `s-button` does not submit `name`/`value`: send form intents with a hidden `<input>`
- `s-empty-state` is not available in the installed types

## Merchant Review in Shopify Admin

Claims that cannot be automatically resolved should appear naturally within Shopify Admin.

Potential surfaces include:

- embedded app claims queue
- order-detail Admin block
- Admin action
- claim detail page

Example order context:

```text
Order #1048

Shipping Protection
-------------------
Claim: Stolen package
Status: Review required
Protected amount: $142.00

[Review claim]
```

The Admin UI is a presentation/integration layer.

The canonical claim record remains in the application database.
