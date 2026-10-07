import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  actualProtectionTotal,
  containsSellingPlan,
  deliveryEligibility,
  eligibleMerchandiseLines,
  protectionLines,
  protectionAttributes,
  protectionAttributesMatch,
  readConfiguration,
  readCheckoutOffer,
  reconciledProtectionAttributes,
  reconstructQuote,
} from "./shipping-protection";

export default async () => {
  render(<ShippingProtection />, document.body);
};

export function ShippingProtection() {
  const lines = shopify.lines.value;
  const deliveryGroups = shopify.deliveryGroups.value;
  const orderDiscountAllocations = shopify.discountAllocations.value;
  const instructions = shopify.instructions.value.lines;
  const appMetafields = shopify.appMetafields.value;
  const configuration = useMemo(
    () => readConfiguration(appMetafields),
    [appMetafields],
  );
  const offer = useMemo(
    () => readCheckoutOffer(appMetafields),
    [appMetafields],
  );
  const [busy, setBusy] = useState(false);
  const [mutationFailed, setMutationFailed] = useState(false);
  const [desiredSelection, setDesiredSelection] = useState(
    /** @type {boolean | null} */ (null),
  );
  const [retry, setRetry] = useState(0);
  const mutationLock = useRef(false);
  const attempts = useRef({ key: "", count: 0 });
  const awaitingCart = useRef(
    /** @type {{
    action: "add" | "remove" | "update",
    previousCount: number,
    configuration: import("./shipping-protection").ShippingProtectionConfiguration
  } | null} */ (null),
  );
  const currentProtectionLines = useMemo(
    () =>
      configuration ? protectionLines(lines, configuration.variantId) : [],
    [configuration, lines],
  );
  const eligibleLines = useMemo(
    () =>
      configuration
        ? eligibleMerchandiseLines(lines, configuration.variantId)
        : [],
    [configuration, lines],
  );
  const quote = configuration
    ? reconstructQuote(lines, configuration, orderDiscountAllocations)
    : null;
  const delivery = deliveryEligibility(
    deliveryGroups,
    new Set(eligibleLines.map(({ id }) => id)),
  );
  // Eligibility is independent of the permissions for individual cart mutations.
  // Missing rates preserve a buyer's eligible selection, while other exclusions
  // still require removal before delivery has loaded.
  const eligible = Boolean(
    configuration?.enabled &&
    !containsSellingPlan(lines) &&
    eligibleLines.length > 0 &&
    delivery !== "ineligible" &&
    quote &&
    quote.amount > 0,
  );
  const checked = currentProtectionLines.length > 0;
  const shouldOffer = eligible && instructions.canAddCartLine;
  const currentTotal = configuration
    ? actualProtectionTotal(lines, configuration.variantId)
    : null;
  const displayedFee = checked ? currentTotal : quote;
  const removeAll = !eligible || desiredSelection === false;
  const action =
    checked && (removeAll || currentProtectionLines.length > 1)
      ? "remove"
      : checked &&
          configuration &&
          (currentProtectionLines[0].quantity !== 1 ||
            !protectionAttributesMatch(
              currentProtectionLines[0],
              configuration,
            ))
        ? "update"
        : !checked && desiredSelection === true && eligible
          ? "add"
          : null;
  const actionAvailable =
    action === "remove"
      ? instructions.canRemoveCartLine
      : action === "update"
        ? instructions.canUpdateCartLine
        : action === "add"
          ? instructions.canAddCartLine
          : false;
  // A new rule or recovered capability starts a fresh budget. The publication
  // gate is separate: unrelated changes cannot repeat an acknowledged write.
  const reconciliationKey = JSON.stringify([
    configuration,
    lines,
    eligible,
    action,
    desiredSelection,
    instructions.canAddCartLine,
    instructions.canRemoveCartLine,
    instructions.canUpdateCartLine,
  ]);

  useEffect(() => {
    const pending = awaitingCart.current;
    if (pending) {
      const observed = protectionLines(lines, pending.configuration.variantId);
      const confirmed =
        pending.action === "add"
          ? observed.length > pending.previousCount
          : pending.action === "remove"
            ? observed.length < pending.previousCount
            : observed.some(
                (line) =>
                  line.quantity === 1 &&
                  protectionAttributesMatch(line, pending.configuration),
              );
      if (confirmed) awaitingCart.current = null;
    }
    if (attempts.current.key !== reconciliationKey) {
      attempts.current = { key: reconciliationKey, count: 0 };
    }
    if (!action) {
      setMutationFailed(false);
      if (desiredSelection !== null) setDesiredSelection(null);
      return;
    }
    if (
      !configuration ||
      busy ||
      mutationLock.current ||
      !actionAvailable ||
      awaitingCart.current !== null ||
      attempts.current.count >= 3
    )
      return;

    const run = async () => {
      if (mutationLock.current) return;
      mutationLock.current = true;
      setBusy(true);
      const attempt = attempts.current;
      attempt.count += 1;
      try {
        // Shopify IDs may change after any cart mutation. Read them immediately
        // before each operation; the effect serializes cleanup of all lines.
        const latest = protectionLines(
          shopify.lines.value,
          configuration.variantId,
        );
        const permissions = shopify.instructions.value.lines;
        let result = null;
        if (
          action === "remove" &&
          permissions.canRemoveCartLine &&
          latest.length
        ) {
          const target = removeAll ? latest[0] : latest[latest.length - 1];
          result = await shopify.applyCartLinesChange({
            type: "removeCartLine",
            id: target.id,
            quantity: target.quantity,
          });
        } else if (
          action === "update" &&
          permissions.canUpdateCartLine &&
          latest.length
        ) {
          const target = latest[0];
          result = await shopify.applyCartLinesChange({
            type: "updateCartLine",
            id: target.id,
            quantity: 1,
            attributes: reconciledProtectionAttributes(target, configuration),
          });
        } else if (
          action === "add" &&
          permissions.canAddCartLine &&
          !latest.length
        ) {
          result = await shopify.applyCartLinesChange({
            type: "addCartLine",
            merchandiseId: configuration.variantId,
            quantity: 1,
            attributes: protectionAttributes(configuration),
          });
        }
        if (!result) return;
        if (result.type === "error") throw new Error("Cart mutation failed");
        awaitingCart.current = {
          action,
          previousCount: latest.length,
          configuration,
        };
        setMutationFailed(false);
      } catch {
        setMutationFailed(true);
      } finally {
        mutationLock.current = false;
        setBusy(false);
        // Synchronous throws can batch busy=true/false into one render.
        setRetry((value) => value + 1);
      }
    };
    const delay = [0, 250, 1000][attempts.current.count];
    if (delay === 0) {
      void run();
      return;
    }
    const timer = setTimeout(() => {
      void run();
    }, delay);
    return () => clearTimeout(timer);
  }, [
    reconciliationKey,
    lines,
    busy,
    retry,
    action,
    actionAvailable,
    configuration,
    desiredSelection,
    removeAll,
  ]);

  if (!configuration || (!checked && !shouldOffer)) return null;
  const formattedFee = displayedFee
    ? shopify.i18n.formatCurrency(displayedFee.amount, {
        currency: displayedFee.currencyCode,
      })
    : shopify.i18n.translate("feeUnavailable");

  return (
    <s-stack direction="block" gap="small-200">
      {mutationFailed && (
        <s-banner tone="critical">
          {shopify.i18n.translate("mutationError")}
        </s-banner>
      )}
      <s-checkbox
        checked={checked}
        disabled={
          busy ||
          (checked
            ? !instructions.canRemoveCartLine
            : !instructions.canAddCartLine)
        }
        label={
          !eligible
            ? shopify.i18n.translate("removeProtection", { fee: formattedFee })
            : offer.checkboxLabel
              ? `${offer.checkboxLabel} — ${formattedFee}`
              : shopify.i18n.translate("checkboxLabel", { fee: formattedFee })
        }
        onChange={onCheckboxChange}
      />
      <s-text color="subdued" type="small">
        {!eligible
          ? shopify.i18n.translate("protectionUnavailable")
          : (offer.supportingText ?? shopify.i18n.translate("supportingText"))}
      </s-text>
      {checked && !instructions.canRemoveCartLine && (
        <s-text>{shopify.i18n.translate("removalUnavailable")}</s-text>
      )}
      {mutationFailed && action && (
        <s-button
          disabled={busy || !actionAvailable}
          onClick={() => {
            attempts.current = { key: reconciliationKey, count: 0 };
            setRetry((value) => value + 1);
          }}
        >
          {shopify.i18n.translate("retry")}
        </s-button>
      )}
    </s-stack>
  );

  /** @param {Event} event */
  function onCheckboxChange(event) {
    if (mutationLock.current) return;
    const target = /** @type {EventTarget & {checked: boolean}} */ (
      event.currentTarget
    );
    if (
      target.checked === checked ||
      (target.checked
        ? !instructions.canAddCartLine
        : !instructions.canRemoveCartLine)
    )
      return;
    setDesiredSelection(target.checked);
    attempts.current = { key: "", count: 0 };
    setRetry((value) => value + 1);
  }
}
