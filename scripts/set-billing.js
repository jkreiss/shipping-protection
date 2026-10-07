import process from "node:process";
import prisma from "../app/db.server.js";
import { parseBillingTerms, setBillingTerms } from "../app/billing/agreements.server.js";
import { describeRevenueShare, formatAmount } from "../app/billing/ledger.js";
import { UserFacingError } from "../app/user-facing-error.js";

try {
  const [shopDomain, ...args] = process.argv.slice(2);
  const terms = parseBillingTerms(args);
  // Loaded only when Shopify is needed, so a bad domain fails without app configuration.
  const adminForShop = async (shop) => (await import("../app/shopify.server.js")).unauthenticated.admin(shop);
  const result = await setBillingTerms({ shopDomain, terms, adminForShop });
  const { agreement, settlement } = result;
  if (settlement) {
    console.log(`Settled the previous terms: ${settlement.billed} charge(s) billed` +
      (settlement.unbilled ? `, ${settlement.unbilled} could not be billed before cancelling.` : "."));
  }
  if (result.outcome === "unchanged") {
    console.log(`Billing for ${shopDomain} is unchanged.`);
  } else if (result.outcome === "free") {
    console.log(`Billing for ${shopDomain}: free. Any revenue-share subscription is cancelled.`);
  } else if (result.outcome === "cap-requested") {
    console.log(`New monthly cap of ${agreement.currencyCode} ${formatAmount(agreement.pendingCappedAmount, agreement.currencyCode)} ` +
      "is waiting for the merchant's approval in Settings. The current cap applies until then.");
  } else {
    console.log(`Billing for ${shopDomain}: ${describeRevenueShare(agreement)}, capped at ` +
      `${agreement.currencyCode} ${formatAmount(agreement.cappedAmount, agreement.currencyCode)} a month. ` +
      "The merchant approves it in Settings; nothing is billed before then.");
  }
} catch (error) {
  console.error(
    error instanceof UserFacingError
      ? error.message
      : "Unable to update billing. Check operator database access, migrations and the shop's offline session.",
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
