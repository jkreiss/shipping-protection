import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  basisPointsToPercent,
  percentToBasisPoints,
} from "../pricing-contract";
import {
  activatePricingRule,
  disableShippingProtection,
  readShippingProtectionState,
  setupShippingProtection,
} from "../shipping-protection.server";
import {
  readBillingView,
  requestBillingApproval,
  requestCapApproval,
  syncBillingAgreement,
} from "../billing/agreements.server";
import { UserFacingError } from "../user-facing-error";
import { reportFailure } from "../observability.server";

// Billing must never stop Settings from loading: fall back to stored terms.
async function loadBilling(admin, shop) {
  try {
    return await syncBillingAgreement({ admin, shopDomain: shop });
  } catch (error) {
    reportFailure("billing_sync_failed", error, { shop });
    return readBillingView({ shopDomain: shop });
  }
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const [state, billing] = await Promise.all([
    readShippingProtectionState(admin, session.shop),
    loadBilling(admin, session.shop),
  ]);
  return { ...state, billing };
};

// Shopify returns the merchant here, inside the Admin, after the approval page.
function billingReturnUrl(shop) {
  const store = shop.replace(/\.myshopify\.com$/, "");
  return `https://admin.shopify.com/store/${store}/apps/${process.env.SHOPIFY_API_KEY}/app/settings`;
}

async function billingAction(admin, shop, intent) {
  try {
    const confirmationUrl = intent === "approve-billing"
      ? await requestBillingApproval({ admin, shopDomain: shop, returnUrl: billingReturnUrl(shop) })
      : await requestCapApproval({ admin, shopDomain: shop });
    return { confirmationUrl };
  } catch (error) {
    if (error instanceof UserFacingError) return { billingError: error.message };
    reportFailure("settings_action_failed", error, { shop, intent });
    return { billingError: "Couldn't open Shopify's approval page. Try again in a few minutes." };
  }
}

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "approve-billing" || intent === "approve-cap") {
    return billingAction(admin, session.shop, intent);
  }

  if (!["setup", "update-rate", "enable", "disable"].includes(String(intent))) {
    return {
      state: await readShippingProtectionState(admin, session.shop),
      error: "Unknown settings action.",
    };
  }

  try {
    if (intent === "disable") {
      return {
        state: await disableShippingProtection(admin, session.shop),
        success: "Shipping protection is turned off.",
      };
    }
    if (intent === "update-rate") {
      const rateBasisPoints = percentToBasisPoints(formData.get("ratePercent"));
      const result = await activatePricingRule(
        admin,
        session.shop,
        rateBasisPoints,
      );
      return {
        state: result.state,
        success: `Protection rate updated to ${result.state.pricing?.percentage}.`,
      };
    }

    return {
      state: await setupShippingProtection(admin, session.shop),
      success: intent === "enable"
        ? "Shipping protection is turned on."
        : "Shipping protection is set up.",
    };
  } catch (error) {
    const userFacing = error instanceof UserFacingError;
    if (!userFacing)
      reportFailure("settings_action_failed", error, {
        shop: session.shop,
        intent,
      });
    let state = null;
    try {
      state = await readShippingProtectionState(admin, session.shop);
    } catch {
      // Preserve the original error if the follow-up health check fails.
    }

    return {
      state,
      error: userFacing
        ? error.message
        : intent === "disable"
          ? "Couldn't finish turning off shipping protection. Refresh to check its status, then try again."
          : "Something went wrong and your settings weren't saved. Try again in a few minutes.",
    };
  }
};

function BillingSection({ billing, fetcher }) {
  const amount = (value) => `${billing.currencyCode} ${value}`;
  const approval = billing.status === "PENDING_APPROVAL"
    ? "approve-billing"
    : billing.pendingCappedAmount ? "approve-cap" : null;
  const submitting = fetcher.state !== "idle";
  const cycleEnds = billing.cycleEndsAt
    ? new Date(billing.cycleEndsAt).toLocaleDateString("en-AU", { dateStyle: "medium", timeZone: "UTC" })
    : null;

  return (
    <s-section heading="Billing">
      <s-stack direction="block" gap="base">
        {fetcher.data?.billingError && (
          <s-banner heading="Couldn't open the approval page" tone="critical">
            {fetcher.data.billingError}
          </s-banner>
        )}
        {billing.mode === "FREE" ? (
          <s-paragraph>No charge. This app is free for your store.</s-paragraph>
        ) : (
          <>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              {billing.status === "ACTIVE" ? (
                <s-badge tone="success">Active</s-badge>
              ) : (
                <s-badge tone="warning">Awaiting approval</s-badge>
              )}
              <s-text>
                {billing.terms}, capped at {amount(billing.cappedAmount)} a month.
              </s-text>
            </s-stack>
            {billing.status === "ACTIVE" && billing.billedThisCycle !== null && (
              <s-paragraph color="subdued">
                Billed this cycle: {amount(billing.billedThisCycle)} of {amount(billing.cappedAmount)}
                {cycleEnds ? `. The cycle ends ${cycleEnds}.` : "."}
              </s-paragraph>
            )}
            {approval === "approve-billing" && (
              <s-banner heading="Approve billing" tone="warning">
                Shopify asks you to approve this charge. Shipping protection
                keeps working until you do, and nothing is billed for orders
                placed before you approve.
              </s-banner>
            )}
            {approval === "approve-cap" && (
              <s-banner heading="Approve the new monthly cap" tone="info">
                The monthly cap is changing to {amount(billing.pendingCappedAmount)}.
                The current cap applies until you approve.
              </s-banner>
            )}
            {approval && (
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value={approval} />
                <s-button
                  variant="primary"
                  type="submit"
                  disabled={submitting}
                  {...(submitting ? { loading: true } : {})}
                >
                  {approval === "approve-billing" ? "Approve billing" : "Approve new cap"}
                </s-button>
              </fetcher.Form>
            )}
          </>
        )}
      </s-stack>
    </s-section>
  );
}

export default function Settings() {
  const initialState = useLoaderData();
  const fetcher = useFetcher();
  const billingFetcher = useFetcher();
  const shopify = useAppBridge();
  const state = fetcher.data?.state ?? initialState;
  const isSaving =
    fetcher.state !== "idle" && fetcher.formMethod?.toUpperCase() === "POST";
  const active = state.configuration.protectionEnabled;
  const off = state.protectionOff === true;
  const supported =
    state.capabilities.checkoutUiSupported &&
    state.capabilities.cartTransformUpdateSupported;
  const failingChecks = state.checks.filter((check) =>
    !check.ok && (!off || !["checkoutConfig", "transformConfig"].includes(check.id)),
  );
  const hasExistingSetup = Boolean(
    state.product ||
    state.pricing?.ruleId ||
    (state.configuredStrategy && state.configuredStrategy !== "NONE"),
  );
  const needsSetup = !off && (!active || failingChecks.length > 0);
  const canTurnOff = !off && (active || state.configuredStrategy === "CHECKOUT_UI_CART_TRANSFORM");
  const rateEditable = state.configuration.protectionRateEditable === true;
  const currentPercent = state.pricing
    ? basisPointsToPercent(state.pricing.rateBasisPoints)
    : "0.25";

  let statusMessage;
  if (off) {
    statusMessage =
      "Shipping protection is off. Customers won't see the checkout offer.";
  } else if (active) {
    statusMessage =
      "Protection setup is ready. Add its block to checkout to show the offer.";
  } else if (hasExistingSetup) {
    statusMessage =
      "Update protection setup to make the offer ready for checkout.";
  } else {
    statusMessage = "Set up shipping protection, then add its block to checkout.";
  }

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show(fetcher.data.success);
    }
  }, [fetcher.data?.success, shopify]);

  // Shopify's approval page must open at the top level, outside the Admin iframe.
  const confirmationUrl = billingFetcher.data?.confirmationUrl;
  useEffect(() => {
    if (confirmationUrl) window.open(confirmationUrl, "_top");
  }, [confirmationUrl]);

  const runSetup = () => {
    fetcher.submit({ intent: "setup" }, { method: "POST" });
  };

  return (
    <s-page heading="Settings">
      {fetcher.data?.error && (
        <s-banner heading="Couldn't save" tone="critical">
          {fetcher.data.error}
        </s-banner>
      )}

      <s-section heading="Protection status">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            {off ? (
              <s-badge>Off</s-badge>
            ) : active ? (
              <s-badge tone="success" icon="check-circle">
                Ready
              </s-badge>
            ) : (
              <s-badge tone="warning" icon="alert-triangle">
                Setup needed
              </s-badge>
            )}
            <s-text>{statusMessage}</s-text>
          </s-stack>

          {!supported && (
            <s-banner
              heading="This store can't use checkout protection yet"
              tone="warning"
            >
              {state.configuration.reasons.join(" ")}
            </s-banner>
          )}

          {failingChecks.length > 0 ? (
            <s-stack direction="block" gap="small-200">
              <s-text type="strong">Needs attention</s-text>
              <s-unordered-list>
                {failingChecks.map((check) => (
                  <s-list-item key={check.id}>{check.label}</s-list-item>
                ))}
              </s-unordered-list>
            </s-stack>
          ) : !off && (
            <s-text color="subdued">
              The protection product and checkout pricing are ready.
            </s-text>
          )}

          {needsSetup && (
            <s-stack direction="inline" gap="base">
              <s-button
                variant="primary"
                onClick={runSetup}
                disabled={!supported || isSaving}
                {...(isSaving ? { loading: true } : {})}
              >
                {hasExistingSetup
                  ? "Update protection setup"
                  : "Set up protection"}
              </s-button>
            </s-stack>
          )}

          {(off || canTurnOff) && (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value={off ? "enable" : "disable"} />
              <s-stack direction="block" gap="base">
                <s-paragraph color="subdued">
                  Existing orders keep their purchased protection. Your saved rate
                  and checkout block stay in place when protection is turned off.
                </s-paragraph>
                <s-stack direction="inline" gap="base">
                  <s-button
                    variant={off ? "primary" : "secondary"}
                    type="submit"
                    disabled={isSaving || (off && !supported)}
                    {...(isSaving ? { loading: true } : {})}
                  >
                    {off ? "Turn on shipping protection" : "Turn off shipping protection"}
                  </s-button>
                </s-stack>
              </s-stack>
            </fetcher.Form>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Pricing">
        {rateEditable ? (
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="update-rate" />
            <s-stack direction="block" gap="base">
              <s-number-field
                key={currentPercent}
                label="Protection rate"
                name="ratePercent"
                suffix="%"
                min={0.01}
                max={100}
                step={0.01}
                inputMode="decimal"
                value={currentPercent}
                details="Percentage of the order's shippable merchandise, before discounts. For example, 1 means 1%."
              />
              <s-paragraph color="subdued">
                A new rate applies to new checkouts only. Past orders keep the
                rate they were charged.
              </s-paragraph>
              <s-stack direction="inline" gap="base">
                <s-button
                  variant="primary"
                  type="submit"
                  disabled={!active || isSaving}
                  {...(isSaving ? { loading: true } : {})}
                >
                  Save rate
                </s-button>
              </s-stack>
            </s-stack>
          </fetcher.Form>
        ) : (
          <s-stack direction="block" gap="base">
            {state.pricing ? (
              <>
                <s-text type="strong">
                  Protection rate: {state.pricing.percentage}
                </s-text>
                <s-paragraph color="subdued">
                  Percentage of the order&apos;s shippable merchandise, before
                  discounts.
                </s-paragraph>
              </>
            ) : (
              <s-paragraph>
                Your protection rate will appear after setup.
              </s-paragraph>
            )}
            <s-paragraph>
              This store&apos;s protection rate is managed for you.
            </s-paragraph>
          </s-stack>
        )}
      </s-section>

      <BillingSection billing={initialState.billing} fetcher={billingFetcher} />

      <s-section heading="Can't see protection at checkout?">
        <s-paragraph>
          Make sure the Shipping Protection block is added to your checkout.
          Completing setup here prepares the offer; you choose where it appears
          in Shopify&apos;s checkout editor.
        </s-paragraph>
        <s-ordered-list>
          <s-list-item>
            In Shopify, go to Settings → Checkout → Customize to open the
            checkout editor.
          </s-list-item>
          <s-list-item>
            Add the Shipping Protection block to the order summary and save.
          </s-list-item>
          <s-list-item>
            If your store offers Shop Pay, turn the block on for Shop Pay too.
          </s-list-item>
          <s-list-item>
            Place a test order to confirm protection is added and priced
            correctly.
          </s-list-item>
        </s-ordered-list>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
