import { UserFacingError } from "../user-facing-error.js";

export const CHECKOUT_OFFER_KEY = "shipping_protection_offer";
export const DEFAULT_CHECKBOX_LABEL = "Add shipping protection";
export const DEFAULT_SUPPORTING_TEXT = "Covers packages stolen after delivery.";
export const MERCHANT_DISCLOSURE = "Optional add-on from this store.";

/** @typedef {{schemaVersion: 1, preselected: boolean, checkboxLabel: string | null, supportingText: string | null}} CheckoutOffer */

function validCopy(value, maxLength) {
  return (
    value === null ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= maxLength &&
      !/[<>]/.test(value) &&
      [...value].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ))
  );
}

/** @param {unknown} value @returns {CheckoutOffer | null} */
export function parseCheckoutOffer(value) {
  if (!value || typeof value !== "object") return null;
  const offer = /** @type {Record<string, unknown>} */ (value);
  if (
    offer.schemaVersion !== 1 ||
    typeof offer.preselected !== "boolean" ||
    !validCopy(offer.checkboxLabel, 120) ||
    !validCopy(offer.supportingText, 500)
  )
    return null;
  return /** @type {CheckoutOffer} */ ({
    schemaVersion: 1,
    preselected: offer.preselected,
    checkboxLabel: offer.checkboxLabel,
    supportingText: offer.supportingText,
  });
}

export function validateCheckoutOfferChanges(changes) {
  const keys = Object.keys(changes);
  if (
    !keys.length ||
    keys.some((key) => !["checkboxLabel", "supportingText"].includes(key))
  ) {
    throw new UserFacingError("Choose a checkout offer setting to update.");
  }
  const validated = { ...changes };
  for (const [key, limit] of [
    ["checkboxLabel", 120],
    ["supportingText", 500],
  ]) {
    if (!(key in changes)) continue;
    if (typeof changes[key] !== "string")
      throw new UserFacingError("Enter plain text for the checkout copy.");
    const text = changes[key].trim();
    if (!validCopy(text || null, limit)) {
      throw new UserFacingError(
        `Use plain text of at most ${limit} characters for the ${key === "checkboxLabel" ? "label" : "supporting text"}.`,
      );
    }
    if (
      text &&
      (/\b(insurance|coverage|lost|loss|damaged?|faulty|returns?)\b|not[\s-]+as[\s-]+described/i.test(
        text,
      ) ||
        (key === "checkboxLabel" && !/shipping protection/i.test(text)))
    ) {
      throw new UserFacingError(
        "Use shipping protection wording for packages stolen after delivery. Loss, damage, and returns aren't benefits of this offer.",
      );
    }
    validated[key] = text || null;
  }
  return validated;
}
