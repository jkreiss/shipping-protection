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
import { UserFacingError } from "../user-facing-error";
import { reportFailure } from "../observability.server";
import { updateCheckoutOffer } from "../merchant/checkout-offer.server";
import {
  DEFAULT_CHECKBOX_LABEL,
  DEFAULT_SUPPORTING_TEXT,
  MERCHANT_DISCLOSURE,
} from "../merchant/checkout-offer";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  return readShippingProtectionState(admin, session.shop);
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (
    !["setup", "update-rate", "update-copy", "enable", "disable"].includes(
      String(intent),
    )
  ) {
    return {
      state: await readShippingProtectionState(admin, session.shop),
      error: "Unknown settings action.",
    };
  }

  try {
    if (intent === "update-copy") {
      await updateCheckoutOffer(admin, session.shop, {
        checkboxLabel: formData.get("checkboxLabel"),
        supportingText: formData.get("supportingText"),
      });
      return {
        state: await readShippingProtectionState(admin, session.shop),
        success: "Checkout copy updated.",
      };
    }
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
      success:
        intent === "enable"
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
          : intent === "update-copy"
            ? "Couldn't confirm the checkout offer update. Refresh to check its current settings, then try again."
            : "Something went wrong and your settings weren't saved. Try again in a few minutes.",
    };
  }
};

export default function Settings() {
  const initialState = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const state = fetcher.data?.state ?? initialState;
  const isSaving =
    fetcher.state !== "idle" && fetcher.formMethod?.toUpperCase() === "POST";
  const active = state.configuration.protectionEnabled;
  const off = state.protectionOff === true;
  const supported =
    state.capabilities.checkoutUiSupported &&
    state.capabilities.cartTransformUpdateSupported;
  const failingChecks = state.checks.filter(
    (check) =>
      !check.ok &&
      (!off || !["checkoutConfig", "transformConfig"].includes(check.id)),
  );
  const hasExistingSetup = Boolean(
    state.product ||
    state.pricing?.ruleId ||
    (state.configuredStrategy && state.configuredStrategy !== "NONE"),
  );
  const needsSetup = !off && (!active || failingChecks.length > 0);
  const canTurnOff =
    !off &&
    (active || state.configuredStrategy === "CHECKOUT_UI_CART_TRANSFORM");
  const rateEditable = state.configuration.protectionRateEditable === true;
  const copyEditable = state.configuration.protectionCopyEditable === true;
  const offer = state.checkoutOffer ?? {
    checkboxLabel: null,
    supportingText: null,
  };
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
    statusMessage =
      "Set up shipping protection, then add its block to checkout.";
  }

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show(fetcher.data.success);
    }
  }, [fetcher.data?.success, shopify]);

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
          ) : (
            !off && (
              <s-text color="subdued">
                The protection product and checkout pricing are ready.
              </s-text>
            )
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
              <input
                type="hidden"
                name="intent"
                value={off ? "enable" : "disable"}
              />
              <s-stack direction="block" gap="base">
                <s-paragraph color="subdued">
                  Existing orders keep their purchased protection. Your saved
                  rate and checkout block stay in place when protection is
                  turned off.
                </s-paragraph>
                <s-stack direction="inline" gap="base">
                  <s-button
                    variant={off ? "primary" : "secondary"}
                    type="submit"
                    disabled={isSaving || (off && !supported)}
                    {...(isSaving ? { loading: true } : {})}
                  >
                    {off
                      ? "Turn on shipping protection"
                      : "Turn off shipping protection"}
                  </s-button>
                </s-stack>
              </s-stack>
            </fetcher.Form>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Checkout offer">
        <s-stack direction="block" gap="large">
          <s-stack direction="block" gap="base">
            <s-heading>Pricing</s-heading>
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
                    A new rate applies to new checkouts only. Past orders keep
                    the rate they were charged.
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
                      Percentage of the order&apos;s shippable merchandise,
                      before discounts.
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
          </s-stack>
          <s-divider />
          <s-stack direction="block" gap="base">
            <s-heading>Customer-facing copy</s-heading>
            {copyEditable ? (
              <fetcher.Form
                method="post"
                key={`copy-${offer.checkboxLabel}-${offer.supportingText}`}
              >
                <input type="hidden" name="intent" value="update-copy" />
                <s-stack direction="block" gap="base">
                  <s-text-field
                    name="checkboxLabel"
                    label="Checkbox label"
                    value={offer.checkboxLabel ?? ""}
                    placeholder={DEFAULT_CHECKBOX_LABEL}
                    maxLength={120}
                    details="Use shipping protection in the label. The fee is always shown beside it. Leave blank to use the default wording."
                    {...(isSaving ? { disabled: true } : {})}
                  />
                  <s-text-area
                    name="supportingText"
                    label="Supporting text"
                    value={offer.supportingText ?? ""}
                    placeholder={DEFAULT_SUPPORTING_TEXT}
                    maxLength={500}
                    rows={3}
                    details="Describe protection for packages stolen after delivery. Leave blank to use the default wording."
                    {...(isSaving ? { disabled: true } : {})}
                  />
                  <s-paragraph color="subdued">
                    Only describe this store&apos;s theft-after-delivery
                    benefit. Loss, damage, and returns aren&apos;t benefits of
                    this offer. Custom text appears in every checkout language;
                    default wording follows the checkout language.
                  </s-paragraph>
                  <s-paragraph color="subdued">
                    {MERCHANT_DISCLOSURE} is always shown.
                  </s-paragraph>
                  <s-stack direction="inline" gap="base">
                    <s-button
                      variant="primary"
                      type="submit"
                      {...(isSaving ? { disabled: true, loading: true } : {})}
                    >
                      Save copy
                    </s-button>
                  </s-stack>
                </s-stack>
              </fetcher.Form>
            ) : (
              <>
                <s-text type="strong">
                  {offer.checkboxLabel ?? DEFAULT_CHECKBOX_LABEL}
                </s-text>
                <s-paragraph>
                  {offer.supportingText ?? DEFAULT_SUPPORTING_TEXT}{" "}
                  {MERCHANT_DISCLOSURE}
                </s-paragraph>
                <s-paragraph>
                  This store&apos;s checkout copy is managed for you.
                </s-paragraph>
              </>
            )}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Can't see protection at checkout?">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Make sure the Shipping Protection block is added to your checkout.
            Completing setup here prepares the offer; you choose where it
            appears in Shopify&apos;s checkout editor.
          </s-paragraph>
          <s-ordered-list>
            <s-list-item>
              In Shopify, go to Settings → Checkout → Configure → Edit to open
              the checkout editor.
            </s-list-item>
            <s-list-item>
              Add the Shipping Protection block to your checkout and save.
            </s-list-item>
            <s-list-item>
              If your store offers Shop Pay, turn the block on for Shop Pay too.
            </s-list-item>
            <s-list-item>
              Place a test order to confirm protection is added and priced
              correctly.
            </s-list-item>
          </s-ordered-list>
          <s-stack direction="block" gap="small-200">
            <s-heading>We suggest</s-heading>
            <s-paragraph>
              Place the Shipping Protection block directly under the block
              labeled “Shipping method” so customers see it when choosing
              delivery.
            </s-paragraph>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
