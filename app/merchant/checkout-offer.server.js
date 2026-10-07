import prisma from "../db.server.js";
import { withShopSettingsLock } from "../shop.server.js";
import {
  loadCore,
  writeJsonMetafield,
} from "../shopify/protection-admin.server.js";
import { UserFacingError } from "../user-facing-error.js";
import { getShopConfiguration } from "./configuration.server.js";
import {
  CHECKOUT_OFFER_KEY,
  parseCheckoutOffer,
  validateCheckoutOfferChanges,
} from "./checkout-offer.js";

export function checkoutOfferForSettings(settings, published) {
  return (
    parseCheckoutOffer(published) ?? {
      schemaVersion: 1,
      checkboxLabel: settings.protectionCheckboxLabel ?? null,
      supportingText: settings.protectionSupportingText ?? null,
    }
  );
}

export async function updateCheckoutOffer(
  admin,
  shopDomain,
  changes,
  { database = prisma } = {},
) {
  const validated = validateCheckoutOfferChanges(changes);
  return withShopSettingsLock(
    shopDomain,
    async () => {
      const settings = await getShopConfiguration(shopDomain, { database });
      if (
        ("checkboxLabel" in validated || "supportingText" in validated) &&
        settings.protectionCopyEditable !== true
      ) {
        throw new UserFacingError(
          "This store's checkout offer setting is managed by the app operator.",
        );
      }
      const core = await loadCore(admin);
      if (core.shop.myshopifyDomain !== shopDomain)
        throw new Error("Shopify shop identity does not match the session.");
      const offer = {
        ...checkoutOfferForSettings(
          settings,
          core.shop.checkoutOffer?.jsonValue,
        ),
        ...validated,
      };
      // Publish first using Shopify's compare-and-set, then mirror the accepted
      // values locally. Reads use a valid live offer if the local save was interrupted.
      await writeJsonMetafield(
        admin,
        core.shop.id,
        CHECKOUT_OFFER_KEY,
        offer,
        core.shop.checkoutOffer?.compareDigest ?? null,
      );
      await database.shopConfiguration.update({
        where: { shopId: settings.shopId },
        data: {
          protectionCheckboxLabel: offer.checkboxLabel,
          protectionSupportingText: offer.supportingText,
        },
      });
      return offer;
    },
    { database },
  );
}
