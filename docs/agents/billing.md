# Revenue-share billing

Read when changing how merchants are billed, the billing ledger, usage charges, or the operator billing command.

[Back to root instructions](../../AGENTS.md). Related: [Revenue sources](analytics-payouts.md); [commerce truth and idempotency](orders-webhooks.md); [worker operations](operations.md).

## Model

The production app is a public app, free to install. Some merchants pay a share of their protection revenue by agreement. A public app may only charge merchants through Shopify billing (App Store requirement 1.2.1), so the share is a usage charge on the merchant's Shopify invoice, created with the Billing API (manual pricing). It bills in the merchant's billing currency, under a monthly cap.

Each shop has one of three modes:

| Mode | Billed |
| --- | --- |
| `FREE` (default, and any shop without terms) | Nothing |
| `GROSS_SHARE` | A percentage of paid protection fees |
| `NET_SHARE` | A percentage of paid protection fees minus confirmed protection refunds |

Only the operator sets terms (`npm run merchant:billing`). Merchants never choose or change them in Settings. They approve the charge on Shopify's page, which Settings opens.

Until terms are approved, or after they end, protection keeps selling. Settings shows a banner. Revenue earned before approval is never billed, and nothing is back-billed later.

## Records

All three tables are tenant-keyed with composite `[id, shopId]` relations. They are deleted explicitly during shop redaction.

- `BillingAgreement`: versioned terms (mode, `rateBasisPoints`, `cappedAmount`, `currencyCode`) and the Shopify subscription and usage line item IDs. Terms are never edited: new terms supersede the old row. The only later changes are the Shopify IDs, status and dates, and `pendingCappedAmount` (a raised cap awaiting the merchant's approval). A partial unique index allows one open agreement (`PENDING_APPROVAL` or `ACTIVE`) per shop. `FREE` is stored as an `ACTIVE` row with rate 0 and no subscription.
- `BillingEntry`: append-only. One signed amount per source (`PURCHASE` or `REFUND`) and revision, unique per `[shopId, sourceType, sourceId, revision]`. A database trigger rejects every update except assigning an unassigned entry to a charge. Deletion is allowed only under the redaction setting, as for `ClaimEvent`.
- `BillingCharge`: one usage charge. Its ID is the usage record's idempotency key. `periodDate` (UTC day) is unique per agreement, so there is at most one daily charge per agreement. A final settlement before terms change has no `periodDate`.

## Ledger rules

Billing reads only data the app already trusts: paid `ProtectionPurchase` rows (`purchasedAt` set) and `CONFIRMED` `ProtectionRefund` rows, both ingested from Shopify orders. Checkout and funnel events are never used.

- A purchase is entered once, at +`feeAmount`, under the active agreement. It qualifies only if `purchasedAt >= activatedAt`, the order is not a test order, and its currency equals the agreement's. Paid purchases are immutable in the database, so a purchase never needs a delta.
- For `NET_SHARE` only, each refund of a purchase billed under the same agreement is entered at −`amount` while `CONFIRMED`. When a refund's amount or status changes, the pass appends a delta entry with the next revision. A refund that stops being confirmed is reversed.
- Each day, a transaction sums the agreement's unassigned entries and applies the rate. It floors the result to the currency's minor units (`currencyMinorUnits`).
  - If the result is above 0, it creates a `PENDING` charge and assigns those entries to it.
  - If the sum is at or below 0, or the charge would floor to nothing, the entries stay unassigned. Refunds then carry forward to offset later revenue.
- Free shops and non-active agreements get no entries and no charges.

## Submitting charges

The worker's billing loop runs hourly (`runBillingPass` in `app/billing/billing-pass.server.js`):

1. Enter new sources.
2. Create today's charge.
3. Submit due charges with `appUsageRecordCreate`, using the charge ID as the idempotency key.

Shopify's refusals carry no error codes. Except for "in progress", the app reads the subscription to classify a refusal:

| Outcome | Charge becomes | Notes |
| --- | --- | --- |
| Usage record created | `BILLED` | Stores `usageRecordGid` and `billedAt`. |
| "Request in progress" or a thrown error | stays `PENDING` | Retried with backoff (1 minute doubling, up to 6 hours). After 10 attempts it is no longer picked up, and `billing_charge_stuck` alerts the operator. |
| Subscription `ACTIVE` and the cap would be exceeded | `CAP_EXCEEDED` | Retried when the billing cycle resets (`currentPeriodEnd`) or a raised cap is approved. Alerts with `billing_cap_exceeded`. |
| Subscription `CANCELLED`, `DECLINED` or `EXPIRED` | `VOID` | The agreement becomes `CANCELLED`. Alerts with `billing_subscription_inactive`. A void charge's entries are never rebilled: a later agreement bills only revenue after its own activation. |
| Subscription `FROZEN` (the store's Shopify bill is unpaid) | stays `PENDING` | Retried with backoff, not voided. |
| Agreement ended, or shop uninstalled | `VOID` | Shopify is not called. |

## Approval and status

- **Approve billing** in Settings calls `appSubscriptionCreate`. It requests one usage line item, the terms text, a cap in the agreement's currency, `test: true` on development stores, and a return URL back to Settings in the Admin. The page then opens Shopify's `confirmationUrl` at the top level.
- The subscription name is `Shipping protection revenue share (terms N)`, where N is the agreement version.
- `app_subscriptions/update` updates the shop's own agreement whose subscription ID matches:
  - `ACTIVE` activates it and sets `activatedAt`.
  - `DECLINED` ends pending terms.
  - `CANCELLED` or `EXPIRED` ends active terms.
  - A cap at or above the requested one replaces the cap.
- If the subscription ID matches no agreement (for example, a second approval page), the webhook runs the same sync as Settings.
- Each Settings load syncs with `currentAppInstallation.activeSubscriptions`. It adopts an approved subscription by its name, ends terms Shopify ended, and cancels any other revenue-share subscription that no open terms own. If the sync fails, Settings shows the stored terms instead.
- `app_subscriptions/approaching_capped_amount` reports `billing_cap_approaching` (usage at 90% of the cap).
- Uninstalling cancels the subscription on Shopify's side, and no update webhook follows, so `markShopUninstalled` marks open agreements `CANCELLED`.
- `activatedAt` is when the app learns of the approval. This is slightly later than Shopify's approval, and favours the merchant.

The Billing API needs no access scopes.

## Currency rule

Terms can only be set when the shop's currency equals its billing currency (`shopBillingPreferences`). Otherwise the command fails with a clear message. This holds for the AU pilot; conversion is out of scope.

## Operator runbook

Run these from a trusted operator shell with the environment's `DATABASE_URL` and Shopify app credentials (`.env` is loaded if present):

```shell
npm run merchant:billing -- store.myshopify.com net 10 100    # 10% of protection revenue net of refunds, cap 100/month
npm run merchant:billing -- store.myshopify.com gross 5 250   # 5% of gross protection revenue, cap 250/month
npm run merchant:billing -- store.myshopify.com free          # stop billing
```

- New terms are recorded as `PENDING_APPROVAL`. The merchant approves them in Settings.
- Same mode and rate with a higher cap on active terms keeps the subscription. Settings then shows **Approve new cap**, which calls `appSubscriptionLineItemUpdate`.
- Any other change (including a lower cap or `free`) works in this order:
  1. Settles the old terms: enters sources, creates a final charge, and submits it.
  2. Cancels the subscription with `appSubscriptionCancel`.
  3. Supersedes the old terms.

  The command reports any settlement charge it could not bill.
- The command refuses unknown or uninstalled stores, and it waits for the shop's settings lock.

## Shopify's fees

Shopify keeps a 2.9% processing fee plus tax on these charges. Its revenue share is 0% up to US$1M lifetime, then 15%. These figures are for documentation only and are not used in code.
