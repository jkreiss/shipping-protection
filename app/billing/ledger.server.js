import prisma from "../db.server.js";
import { retrySerializationFailures } from "../serializable-retry.server.js";
import { planCharge, planEntries } from "./ledger.js";

const PURCHASE_BATCH = 500;

function isUniqueViolation(error) {
  return error?.code === "P2002";
}

// Paid purchases are immutable once confirmed (enforced by the database), so a
// purchase is entered once, under the agreement active when it was paid. Test
// orders and other currencies never qualify and are filtered here.
function unenteredPurchases(transaction, agreement) {
  return transaction.$queryRaw`
    SELECT p.id AS "sourceId", p."feeAmount"::text AS "feeAmount", p."currencyCode",
      p."purchasedAt", o."isTest"
    FROM "ProtectionPurchase" p
    JOIN "Order" o ON o.id = p."orderId" AND o."shopId" = p."shopId"
    WHERE p."shopId" = ${agreement.shopId} AND p."purchasedAt" >= ${agreement.activatedAt}
      AND p."currencyCode" = ${agreement.currencyCode} AND o."isTest" = false
      AND NOT EXISTS (
        SELECT 1 FROM "BillingEntry" e
        WHERE e."shopId" = p."shopId" AND e."sourceType" = 'PURCHASE'::"BillingSourceType"
          AND e."sourceId" = p.id)
    ORDER BY p."purchasedAt", p.id
    LIMIT ${PURCHASE_BATCH}`;
}

// Every protection refund on an order whose purchase this agreement billed,
// with what is already entered for it, so status or amount changes get deltas.
function billedPurchaseRefunds(transaction, agreement) {
  return transaction.$queryRaw`
    SELECT r.id AS "sourceId", r.status::text AS status, r.amount::text AS amount,
      r."currencyCode", o."isTest",
      COALESCE((SELECT SUM(e.amount) FROM "BillingEntry" e
        WHERE e."shopId" = r."shopId" AND e."sourceType" = 'REFUND'::"BillingSourceType"
          AND e."sourceId" = r.id AND e."agreementId" = ${agreement.id}), 0)::text AS entered,
      COALESCE((SELECT MAX(e.revision) FROM "BillingEntry" e
        WHERE e."shopId" = r."shopId" AND e."sourceType" = 'REFUND'::"BillingSourceType"
          AND e."sourceId" = r.id), -1)::int AS "lastRevision"
    FROM "ProtectionRefund" r
    JOIN "Order" o ON o.id = r."orderId" AND o."shopId" = r."shopId"
    JOIN "ProtectionPurchase" p ON p."orderId" = r."orderId" AND p."shopId" = r."shopId"
    WHERE r."shopId" = ${agreement.shopId}
      AND EXISTS (
        SELECT 1 FROM "BillingEntry" pe
        WHERE pe."shopId" = p."shopId" AND pe."sourceType" = 'PURCHASE'::"BillingSourceType"
          AND pe."sourceId" = p.id AND pe."agreementId" = ${agreement.id})`;
}

async function enterInTransaction(database, agreement, readSources) {
  try {
    return await retrySerializationFailures(() => database.$transaction(async (transaction) => {
      const current = await transaction.billingAgreement.findFirst({
        where: { id: agreement.id, shopId: agreement.shopId, status: "ACTIVE" },
      });
      if (!current) return { added: 0, read: 0 };
      const sources = await readSources(transaction, current);
      const planned = planEntries(sources, current);
      if (planned.length) {
        await transaction.billingEntry.createMany({
          data: planned.map((entry) => ({ ...entry, shopId: current.shopId, agreementId: current.id })),
        });
      }
      return { added: planned.length, read: sources.length };
    }, { isolationLevel: "Serializable", timeout: 30_000 }));
  } catch (error) {
    // Another worker entered the same source first; the next pass catches up.
    if (isUniqueViolation(error)) return { added: 0, read: 0 };
    throw error;
  }
}

// Appends entries for sources this agreement has not entered yet, and deltas
// for refunds that changed. Returns how many entries were added.
export async function recordBillingEntries({ database = prisma, agreement }) {
  let added = 0;
  for (;;) {
    const batch = await enterInTransaction(database, agreement, (transaction, current) =>
      unenteredPurchases(transaction, current).then((rows) =>
        rows.map((row) => ({ ...row, sourceType: "PURCHASE", entered: "0", lastRevision: -1 }))));
    added += batch.added;
    if (batch.read < PURCHASE_BATCH || batch.added === 0) break;
  }
  if (agreement.mode === "NET_SHARE") {
    const refunds = await enterInTransaction(database, agreement, (transaction, current) =>
      billedPurchaseRefunds(transaction, current).then((rows) =>
        rows.map((row) => ({ ...row, sourceType: "REFUND" }))));
    added += refunds.added;
  }
  return added;
}

function utcDay(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// Charges the agreement's rate on its unassigned entries, at most once per UTC
// day. A final settlement (before terms change) is not limited to one a day.
// Returns the new PENDING charge, or null when nothing is due.
export async function createBillingCharge({ database = prisma, agreement, now = new Date(), final = false }) {
  const periodDate = final ? null : utcDay(now);
  try {
    return await retrySerializationFailures(() => database.$transaction(async (transaction) => {
      const current = await transaction.billingAgreement.findFirst({
        where: { id: agreement.id, shopId: agreement.shopId, status: "ACTIVE" },
      });
      if (!current) return null;
      if (periodDate) {
        const existing = await transaction.billingCharge.findUnique({
          where: { agreementId_periodDate: { agreementId: current.id, periodDate } },
        });
        if (existing) return null;
      }
      const entries = await transaction.billingEntry.findMany({
        where: { shopId: current.shopId, agreementId: current.id, chargeId: null },
        select: { id: true, amount: true },
      });
      const plan = planCharge(entries.map(({ amount }) => amount), current);
      if (!plan) return null;
      const charge = await transaction.billingCharge.create({ data: {
        shopId: current.shopId, agreementId: current.id, periodDate,
        baseAmount: plan.baseAmount, chargeAmount: plan.chargeAmount, currencyCode: current.currencyCode,
      } });
      const assigned = await transaction.billingEntry.updateMany({
        where: { id: { in: entries.map(({ id }) => id) }, shopId: current.shopId, chargeId: null },
        data: { chargeId: charge.id },
      });
      if (assigned.count !== entries.length) throw new Error("Billing entries changed while charging.");
      return charge;
    }, { isolationLevel: "Serializable", timeout: 30_000 }));
  } catch (error) {
    // A concurrent run created today's charge first.
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}
