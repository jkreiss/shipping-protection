import { beforeEach, describe, expect, test, vi } from "vitest";
import { reportCondition, reportFailure } from "../observability.server.js";
import { MAX_CHARGE_ATTEMPTS, submitPendingCharges } from "./usage-charges.server.js";

vi.mock("../observability.server.js", () => ({
  logEvent: vi.fn(), reportCondition: vi.fn(), reportFailure: vi.fn(),
}));

const now = new Date("2026-10-05T13:00:00Z");
const periodEnd = new Date("2026-10-20T00:00:00Z");

function setup({ charge = {}, agreement = {}, installed = true } = {}) {
  const agreementRow = {
    id: "agreement-1", shopId: "shop-1", mode: "NET_SHARE", status: "ACTIVE", rateBasisPoints: 1_000,
    currencyCode: "AUD", subscriptionGid: "gid://shopify/AppSubscription/1", usageLineItemGid: "li-1",
    shop: { shopDomain: "one.myshopify.com", installationState: installed ? "INSTALLED" : "UNINSTALLED" },
    ...agreement,
  };
  const chargeRow = {
    id: "charge-1", shopId: "shop-1", agreementId: "agreement-1", status: "PENDING", attempts: 0,
    nextAttemptAt: now, baseAmount: { toFixed: () => "4.5000" }, chargeAmount: { toFixed: () => "0.4500" },
    currencyCode: "AUD", ...charge,
  };
  const rows = [chargeRow];
  const database = {
    rows, agreement: agreementRow,
    billingCharge: {
      findMany: vi.fn(async ({ where }) => rows
        .filter((row) => where.status.in.includes(row.status) && row.nextAttemptAt <= where.nextAttemptAt.lte
          && row.attempts < where.attempts.lt)
        .map((row) => ({ ...row, agreement: agreementRow }))),
      updateMany: vi.fn(async ({ where, data }) => {
        const matched = rows.filter((row) => row.id === where.id && row.shopId === where.shopId
          && where.status.in.includes(row.status));
        for (const row of matched) Object.assign(row, data);
        return { count: matched.length };
      }),
    },
    billingAgreement: {
      updateMany: vi.fn(async ({ where, data }) => {
        if (agreementRow.id !== where.id || agreementRow.shopId !== where.shopId || agreementRow.status !== where.status) return { count: 0 };
        Object.assign(agreementRow, data);
        return { count: 1 };
      }),
    },
  };
  return { database, charge: chargeRow };
}

const admin = {};
const adminForShop = vi.fn(async () => ({ admin }));
const activeSubscription = (balanceUsed = "10.0") => ({
  id: "gid://shopify/AppSubscription/1", status: "ACTIVE", currentPeriodEnd: periodEnd,
  usageLineItem: { id: "li-1", cappedAmount: "100.0", balanceUsed, currencyCode: "AUD" },
});

beforeEach(() => vi.clearAllMocks());

describe("submitting usage charges", () => {
  test("bills a pending charge once, using its ID as the idempotency key", async () => {
    const { database, charge } = setup();
    const createRecord = vi.fn(async () => ({ usageRecordGid: "gid://shopify/AppUsageRecord/9" }));

    await submitPendingCharges({ database, adminForShop, now, createRecord, readSubscription: vi.fn() });
    await submitPendingCharges({ database, adminForShop, now, createRecord, readSubscription: vi.fn() });

    expect(createRecord).toHaveBeenCalledTimes(1);
    expect(createRecord).toHaveBeenCalledWith(admin, "one.myshopify.com", {
      lineItemId: "li-1", amount: "0.4500", currencyCode: "AUD", idempotencyKey: "charge-1",
      description: "Shipping protection revenue share: 10% of AUD 4.50, net of protection refunds",
    });
    expect(charge).toMatchObject({ status: "BILLED", usageRecordGid: "gid://shopify/AppUsageRecord/9", billedAt: now });
  });

  test("retries later while Shopify is still processing the same request", async () => {
    const { database, charge } = setup();
    const createRecord = vi.fn(async () => ({ errors: ["A request with this idempotency key is currently in progress."] }));
    const readSubscription = vi.fn();

    await submitPendingCharges({ database, adminForShop, now, createRecord, readSubscription });

    expect(charge).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(charge.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
    expect(readSubscription).not.toHaveBeenCalled();
  });

  test("holds a charge over the cap until the next billing cycle and alerts the operator", async () => {
    const { database, charge } = setup();
    const createRecord = vi.fn(async () => ({ errors: ["Failed to create usage charge"] }));
    const readSubscription = vi.fn(async () => activeSubscription("99.8"));

    await submitPendingCharges({ database, adminForShop, now, createRecord, readSubscription });

    expect(charge).toMatchObject({ status: "CAP_EXCEEDED", attempts: 0, nextAttemptAt: periodEnd, errorMessage: "CAP_EXCEEDED" });
    expect(reportCondition).toHaveBeenCalledWith("billing_cap_exceeded", expect.objectContaining({ shopId: "shop-1", chargeId: "charge-1" }));
  });

  test("voids the charge and ends the agreement when the subscription is no longer active", async () => {
    const { database, charge } = setup();
    const createRecord = vi.fn(async () => ({ errors: ["Failed to create usage charge"] }));
    const readSubscription = vi.fn(async () => ({ ...activeSubscription(), status: "CANCELLED" }));

    await submitPendingCharges({ database, adminForShop, now, createRecord, readSubscription });

    expect(charge).toMatchObject({ status: "VOID", errorMessage: "SUBSCRIPTION_INACTIVE" });
    expect(database.agreement).toMatchObject({ status: "CANCELLED", endedAt: now });
  });

  test("keeps retrying a frozen subscription rather than voiding it", async () => {
    const { database, charge } = setup();
    const createRecord = vi.fn(async () => ({ errors: ["Failed to create usage charge"] }));
    const readSubscription = vi.fn(async () => ({ ...activeSubscription(), status: "FROZEN" }));

    await submitPendingCharges({ database, adminForShop, now, createRecord, readSubscription });

    expect(charge).toMatchObject({ status: "PENDING", attempts: 1 });
  });

  test.each([
    ["the agreement has ended", { agreement: { status: "SUPERSEDED" } }],
    ["the shop is uninstalled", { installed: false }],
  ])("voids without calling Shopify when %s", async (_name, options) => {
    const { database, charge } = setup(options);
    const createRecord = vi.fn();

    await submitPendingCharges({ database, adminForShop, now, createRecord, readSubscription: vi.fn() });

    expect(createRecord).not.toHaveBeenCalled();
    expect(charge.status).toBe("VOID");
  });

  test("backs off after an error and stops retrying after the attempt limit", async () => {
    const { database, charge } = setup({ charge: { attempts: MAX_CHARGE_ATTEMPTS - 1 } });
    const createRecord = vi.fn(async () => { throw new Error("network"); });

    await submitPendingCharges({ database, adminForShop, now, createRecord, readSubscription: vi.fn() });
    expect(charge).toMatchObject({ status: "PENDING", attempts: MAX_CHARGE_ATTEMPTS });
    expect(reportFailure).toHaveBeenCalledWith("billing_charge_stuck", expect.any(Error), expect.objectContaining({ chargeId: "charge-1" }));

    await submitPendingCharges({ database, adminForShop, now: new Date(now.getTime() + 864e5), createRecord, readSubscription: vi.fn() });
    expect(createRecord).toHaveBeenCalledTimes(1);
  });
});
