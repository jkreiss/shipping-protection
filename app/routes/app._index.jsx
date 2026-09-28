import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  activatePricingRule,
  readShippingProtectionState,
  setupShippingProtection,
} from "../shipping-protection.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  return readShippingProtectionState(admin, session.shop);
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent !== "setup" && intent !== "activate-rule") {
    return {
      state: await readShippingProtectionState(admin, session.shop),
      error: "Unknown setup action.",
    };
  }

  try {
    if (intent === "activate-rule") {
      const rateBasisPoints = Number(formData.get("rateBasisPoints"));
      const result = await activatePricingRule(
        admin,
        session.shop,
        rateBasisPoints,
      );
      return {
        state: result.state,
        success: `Pricing rule v${result.rule.version} is active.`,
      };
    }

    return {
      state: await setupShippingProtection(admin, session.shop),
      success: "Shipping protection is configured and enabled.",
    };
  } catch (error) {
    let state = null;
    try {
      state = await readShippingProtectionState(admin, session.shop);
    } catch {
      // Preserve the original repair error if the follow-up health check fails.
    }

    return {
      state,
      error:
        error instanceof Error
          ? error.message
          : "Shipping protection setup failed.",
    };
  }
};

export default function Index() {
  const initialState = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const state = fetcher.data?.state ?? initialState;
  const isLoading =
    fetcher.state !== "idle" && fetcher.formMethod?.toUpperCase() === "POST";

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
    shopify.intents.invoke?.("edit:shopify/Product", {
      value: state.product.id,
    });
  };

  return (
    <s-page heading="Shipping protection">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={runSetup}
        {...(isLoading ? { loading: true } : {})}
      >
        {state.ready
          ? "Repair shipping protection"
          : "Set up shipping protection"}
      </s-button>

      {fetcher.data?.error && (
        <s-banner heading="Setup needs attention" tone="critical">
          {fetcher.data.error}
        </s-banner>
      )}

      {fetcher.data?.success && (
        <s-banner heading="Setup complete" tone="success">
          The checkout offer and its blocking price transform are enabled.
        </s-banner>
      )}

      <s-section heading="Status">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            This app offers optional shipping protection in checkout and prices
            it at {state.pricing?.percentage ?? "0.25%"} of eligible shipped
            merchandise before discounts.
          </s-paragraph>
          <s-banner
            heading={state.ready ? "Ready" : "Setup or repair required"}
            tone={state.ready ? "success" : "warning"}
          >
            {state.ready
              ? "All app-side health checks pass."
              : "Run setup after deploying the app version, then review any failing checks."}
          </s-banner>
          <s-stack direction="block" gap="small-200">
            {state.checks.map((check) => (
              <s-box
                key={check.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-badge tone={check.ok ? "success" : "critical"}>
                    {check.ok ? "Pass" : "Needs attention"}
                  </s-badge>
                  <s-text>{check.label}</s-text>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Pricing rule">
        <fetcher.Form method="post">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              Rates are stored as whole basis points. The active rule is
              {state.pricing
                ? ` v${state.pricing.ruleVersion ?? "legacy"} at ${state.pricing.percentage}.`
                : " not yet available."}
            </s-paragraph>
            <s-text-field
              label="Rate in basis points"
              name="rateBasisPoints"
              type="number"
              min="1"
              max="10000"
              value={String(state.pricing?.rateBasisPoints ?? 25)}
              helpText="25 basis points equals 0.25%."
            />
            <s-button
              variant="primary"
              type="submit"
              name="intent"
              value="activate-rule"
              {...(isLoading ? { loading: true } : {})}
            >
              Publish new rule version
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section heading="Product access">
        {state.product ? (
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {state.product.title} is {state.product.status.toLowerCase()} and
              remains accessible by direct link without appearing in normal
              storefront discovery.
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <s-button onClick={editProduct}>Edit product</s-button>
              {state.product.onlineStoreUrl && (
                <s-link href={state.product.onlineStoreUrl} target="_blank">
                  Open direct product link
                </s-link>
              )}
            </s-stack>
          </s-stack>
        ) : (
          <s-paragraph>
            The Shipping Protection product has not been created yet.
          </s-paragraph>
        )}
      </s-section>

      <s-section heading="Activate in checkout">
        <s-ordered-list>
          <s-list-item>
            Deploy the backend and an app version containing the checkout block
            and the {state.functionHandle} Function.
          </s-list-item>
          <s-list-item>
            Approve the requested product, publication, and Cart Transform
            scopes, then run setup on this page.
          </s-list-item>
          <s-list-item>
            In Settings → Checkout → Customize, add the Shipping Protection
            block to the order summary and save it.
          </s-list-item>
          <s-list-item>
            Enable the extension separately for Shop Pay if the store offers
            Shop Pay, then place a real test order before release.
          </s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section slot="aside" heading="Important">
        <s-paragraph>
          Checkout UI extensions and dynamic Cart Transform pricing require
          Shopify Plus for this design. Tax may increase the final order total
          above the displayed protection fee.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
