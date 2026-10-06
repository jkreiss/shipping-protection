export const IMPLEMENTED_CAPABILITIES = Object.freeze({
  checkoutUiCartTransform: true,
  themeCart: false,
  returns: false,
  claimIntake: false,
  autoApproval: false,
});

export function resolveConfiguration(
  settings,
  capabilities,
  healthReady,
  implemented = IMPLEMENTED_CAPABILITIES,
) {
  const reasons = [];
  let strategy = "NONE";
  if (!settings?.protectionEnabled || settings.attachmentStrategy === "NONE") {
    if (!capabilities.checkoutUiSupported) reasons.push("Checkout UI blocks require Shopify Plus.");
    if (!capabilities.cartTransformUpdateSupported) reasons.push("Cart Transform price updates are unavailable for this shop.");
  }
  if (settings?.protectionEnabled && settings.attachmentStrategy !== "NONE") {
    if (settings.attachmentStrategy === "CHECKOUT_UI_CART_TRANSFORM") {
      if (!implemented.checkoutUiCartTransform) reasons.push("Checkout attachment is not implemented.");
      if (!capabilities.checkoutUiSupported) reasons.push("Checkout UI blocks require Shopify Plus.");
      if (!capabilities.cartTransformUpdateSupported) reasons.push("Cart Transform price updates are unavailable for this shop.");
      if (!healthReady) reasons.push("Protection setup needs to be updated.");
      if (reasons.length === 0) strategy = "CHECKOUT_UI_CART_TRANSFORM";
    } else if (settings.attachmentStrategy === "THEME_CART") {
      reasons.push("Theme cart attachment is not implemented.");
    } else {
      reasons.push("Unknown attachment strategy.");
    }
  }

  return {
    strategy,
    protectionEnabled: strategy !== "NONE",
    protectionRateEditable: settings?.protectionRateEditable === true,
    reasons,
    merchantActivationRequired: strategy === "CHECKOUT_UI_CART_TRANSFORM",
    coverage: {
      stolen: Boolean(settings?.stolenCoverageEnabled),
      lost: Boolean(settings?.lostCoverageEnabled),
      damaged: Boolean(settings?.damagedCoverageEnabled),
    },
    returnsEnabled: Boolean(settings?.returnsEnabled && implemented.returns),
    freeReturnsEnabled: Boolean(settings?.returnsEnabled && settings?.freeReturnsEnabled && implemented.returns),
    claimIntakeEnabled: Boolean(implemented.claimIntake && (
      settings?.emailClaimIntakeEnabled || settings?.formClaimIntakeEnabled || settings?.adminClaimIntakeEnabled
    )),
    autoApprovalEnabled: Boolean(settings?.autoApprovalEnabled && implemented.autoApproval),
  };
}

export function observedShopifyCapabilities(shop) {
  return {
    checkoutUiSupported: shop?.plan?.shopifyPlus === true,
    cartTransformUpdateSupported: shop?.features?.cartTransform?.eligibleOperations?.updateOperation === true,
  };
}
