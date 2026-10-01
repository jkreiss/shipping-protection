import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { basisPointsToPercent, percentToBasisPoints } from "../pricing-contract";
import {
  activatePricingRule,
  readShippingProtectionState,
  setupShippingProtection,
} from "../shipping-protection.server";
import { UserFacingError } from "../user-facing-error";
import { reportFailure } from "../observability.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  return readShippingProtectionState(admin, session.shop);
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent !== "setup" && intent !== "update-rate") {
    return {
      state: await readShippingProtectionState(admin, session.shop),
      error: "Unknown settings action.",
    };
  }

  try {
    if (intent === "update-rate") {
      const rateBasisPoints = percentToBasisPoints(formData.get("ratePercent"));
      const result = await activatePricingRule(admin, session.shop, rateBasisPoints);
      return {
        state: result.state,
        success: `Protection rate updated to ${result.state.pricing?.percentage}.`,
      };
    }

    return {
      state: await setupShippingProtection(admin, session.shop),
      success: "Shipping protection is set up.",
    };
  } catch (error) {
    const userFacing = error instanceof UserFacingError;
    if (!userFacing) reportFailure("settings_action_failed", error, { shop: session.shop, intent });
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
  const supported =
    state.capabilities.checkoutUiSupported && state.capabilities.cartTransformUpdateSupported;
  const failingChecks = state.checks.filter((check) => !check.ok);
  const currentPercent = state.pricing ? basisPointsToPercent(state.pricing.rateBasisPoints) : "0.25";

  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show(fetcher.data.success);
    }
  }, [fetcher.data?.success, shopify]);

  const runSetup = () => {
    fetcher.submit({ intent: "setup" }, { method: "POST" });
  };

  const editProduct = () => {
    if (!state.product?.id) return;
    shopify.intents.invoke?.("edit:shopify/Product", { value: state.product.id });
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
            {active
              ? <s-badge tone="success" icon="check-circle">Active</s-badge>
              : <s-badge tone="warning" icon="alert-triangle">Not active</s-badge>}
            <s-text>
              {active
                ? "Protection is set up and offered in checkout."
                : "Run setup to create the protection product and turn on checkout pricing."}
            </s-text>
          </s-stack>

          {!supported && (
            <s-banner heading="This store can't use checkout protection yet" tone="warning">
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
            <s-text color="subdued">All {state.checks.length} setup checks pass.</s-text>
          )}

          <s-stack direction="inline" gap="base">
            <s-button
              variant={active ? "secondary" : "primary"}
              onClick={runSetup}
              disabled={!supported}
              {...(isSaving ? { loading: true } : {})}
            >
              {active ? "Repair setup" : "Set up protection"}
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Pricing">
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
              A new rate applies to new checkouts only. Past orders keep the rate they were charged.
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-button
                variant="primary"
                type="submit"
                disabled={!active}
                {...(isSaving ? { loading: true } : {})}
              >
                Save rate
              </s-button>
            </s-stack>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section heading="Protection product">
        {state.product ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {state.product.title} is added to orders when customers choose protection. It&apos;s
              unlisted, so it doesn&apos;t appear in your store&apos;s search or collections.
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-button onClick={editProduct}>Edit product</s-button>
            </s-stack>
          </s-stack>
        ) : (
          <s-paragraph>The protection product is created when you run setup.</s-paragraph>
        )}
      </s-section>

      <s-section heading="Show protection in checkout">
        <s-ordered-list>
          <s-list-item>Run setup above.</s-list-item>
          <s-list-item>
            In Shopify, go to Settings → Checkout → Customize, add the Shipping Protection block to
            the order summary, and save.
          </s-list-item>
          <s-list-item>If your store offers Shop Pay, turn the block on for Shop Pay too.</s-list-item>
          <s-list-item>Place a test order to confirm protection is added and priced correctly.</s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section slot="aside" heading="Requirements">
        <s-paragraph>
          Checkout blocks require Shopify Plus. Checkout price updates are available on Plus and
          development stores. Tax may make the final order total higher than the displayed
          protection fee.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
