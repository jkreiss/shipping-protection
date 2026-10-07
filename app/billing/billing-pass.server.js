import prisma from "../db.server.js";
import { reportFailure } from "../observability.server.js";
import { createBillingCharge, recordBillingEntries } from "./ledger.server.js";
import { submitPendingCharges } from "./usage-charges.server.js";

// One worker pass: append entries and create today's charge for every active
// paid agreement, then send due charges to Shopify. Safe to run repeatedly.
export async function runBillingPass({ database = prisma, adminForShop, now = new Date(), onProgress = () => {} }) {
  const agreements = await database.billingAgreement.findMany({
    where: { status: "ACTIVE", mode: { not: "FREE" } }, orderBy: { id: "asc" },
  });
  let entries = 0;
  let charges = 0;
  for (const agreement of agreements) {
    try {
      entries += await recordBillingEntries({ database, agreement });
      if (await createBillingCharge({ database, agreement, now })) charges += 1;
    } catch (error) {
      reportFailure("billing_ledger_failed", error, { shopId: agreement.shopId, agreementId: agreement.id });
    }
    onProgress();
  }
  const submitted = await submitPendingCharges({ database, adminForShop, now });
  return { agreements: agreements.length, entries, charges, ...submitted };
}
