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
  const [busy, setBusy] = useState(false);
  const [mutationFailed, setMutationFailed] = useState(false);
  const mutationLock = useRef(false);
  const attemptedReconciliation = useRef(/** @type {string | null} */ (null));

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
  const mutationsAvailable =
    instructions.canAddCartLine &&
    instructions.canRemoveCartLine &&
    instructions.canUpdateCartLine;
  const delivery = deliveryEligibility(
    deliveryGroups,
    new Set(eligibleLines.map(({ id }) => id)),
  );
  const shouldOffer = Boolean(
    configuration?.enabled &&
    !containsSellingPlan(lines) &&
    eligibleLines.length > 0 &&
    delivery === "eligible" &&
    quote &&
    quote.amount > 0 &&
    mutationsAvailable,
  );
  const checked = currentProtectionLines.length > 0;
  const currentTotal = configuration
    ? actualProtectionTotal(lines, configuration.variantId)
    : null;
  const displayedFee = checked && currentTotal ? currentTotal : quote;
  const lineFingerprint = currentProtectionLines
    .map(
      ({ id, quantity, attributes }) =>
        `${id}:${quantity}:${JSON.stringify(attributes)}`,
    )
    .join("|");

  useEffect(() => {
    if (!configuration || mutationLock.current) return;

    let removeTarget = null;
    let updateTarget = null;
    // While delivery is pending the offer is hidden, but the buyer's line
    // stays until checkout settles on an option.
    if (
      !shouldOffer &&
      delivery !== "pending" &&
      currentProtectionLines.length > 0 &&
      instructions.canRemoveCartLine
    ) {
      const line = currentProtectionLines[0];
      removeTarget = line;
    } else if (
      shouldOffer &&
      currentProtectionLines.length > 1 &&
      instructions.canRemoveCartLine
    ) {
      const duplicate =
        currentProtectionLines[currentProtectionLines.length - 1];
      removeTarget = duplicate;
    } else if (
      shouldOffer &&
      currentProtectionLines.length === 1 &&
      (currentProtectionLines[0].quantity !== 1 ||
        !protectionAttributesMatch(
          currentProtectionLines[0],
          configuration,
        )) &&
      instructions.canUpdateCartLine
    ) {
      updateTarget = currentProtectionLines[0];
    }

    if (!removeTarget && !updateTarget) {
      attemptedReconciliation.current = null;
      return;
    }

    const action = removeTarget ? "remove" : "update";
    const attemptKey = `${shouldOffer}:${lineFingerprint}:${action}`;
    if (attemptedReconciliation.current === attemptKey) return;
    attemptedReconciliation.current = attemptKey;
    mutationLock.current = true;
    setBusy(true);

    let mutation;
    if (removeTarget) {
      mutation = shopify.applyCartLinesChange({
        type: "removeCartLine",
        id: removeTarget.id,
        quantity: removeTarget.quantity,
      });
    } else if (updateTarget) {
      mutation = shopify.applyCartLinesChange({
        type: "updateCartLine",
        id: updateTarget.id,
        quantity: 1,
        attributes: reconciledProtectionAttributes(
          updateTarget,
          configuration,
        ),
      });
    } else {
      return;
    }

    void mutation
      .then((result) => {
        if (result.type === "error") setMutationFailed(true);
      })
      .catch(() => setMutationFailed(true))
      .finally(() => {
        mutationLock.current = false;
        setBusy(false);
      });
  }, [
    configuration,
    currentProtectionLines,
    delivery,
    instructions.canRemoveCartLine,
    instructions.canUpdateCartLine,
    lineFingerprint,
    shouldOffer,
  ]);

  if (!shouldOffer || !configuration || !displayedFee) return null;
  const activeConfiguration = configuration;

  const formattedFee = shopify.i18n.formatCurrency(displayedFee.amount, {
    currency: displayedFee.currencyCode,
  });

  return (
    <s-stack direction="block" gap="small-200">
      {mutationFailed && (
        <s-banner tone="critical">
          {shopify.i18n.translate("mutationError")}
        </s-banner>
      )}
      <s-checkbox
        checked={checked}
        disabled={busy}
        label={shopify.i18n.translate("checkboxLabel", { fee: formattedFee })}
        onChange={onCheckboxChange}
      />
      <s-text color="subdued" type="small">
        {shopify.i18n.translate("supportingText")}
      </s-text>
    </s-stack>
  );

  /** @param {Event} event */
  async function onCheckboxChange(event) {
    if (mutationLock.current) return;

    const target = /** @type {EventTarget & {checked: boolean}} */ (
      event.currentTarget
    );
    const desiredChecked = target.checked;
    if (desiredChecked === checked) return;

    mutationLock.current = true;
    setBusy(true);
    setMutationFailed(false);

    try {
      let result;
      if (desiredChecked) {
        const alreadyPresent = protectionLines(
          shopify.lines.value,
          activeConfiguration.variantId,
        );
        if (alreadyPresent.length > 0) return;
        result = await shopify.applyCartLinesChange({
          type: "addCartLine",
          merchandiseId: activeConfiguration.variantId,
          quantity: 1,
          attributes: protectionAttributes(activeConfiguration),
        });
      } else {
        const latest = protectionLines(
          shopify.lines.value,
          activeConfiguration.variantId,
        )[0];
        if (!latest) return;
        result = await shopify.applyCartLinesChange({
          type: "removeCartLine",
          id: latest.id,
          quantity: latest.quantity,
        });
      }

      if (result.type === "error") setMutationFailed(true);
    } catch {
      setMutationFailed(true);
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
}
