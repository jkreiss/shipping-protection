import { beforeEach, describe, expect, test, vi } from "vitest";
import { reportFailure } from "../observability.server.js";
import { createBillingCharge, recordBillingEntries } from "./ledger.server.js";
import { submitPendingCharges } from "./usage-charges.server.js";
import { runBillingPass } from "./billing-pass.server.js";

vi.mock("../observability.server.js", () => ({ logEvent: vi.fn(), reportCondition: vi.fn(), reportFailure: vi.fn() }));
vi.mock("./ledger.server.js", () => ({ recordBillingEntries: vi.fn(), createBillingCharge: vi.fn() }));
vi.mock("./usage-charges.server.js", () => ({ submitPendingCharges: vi.fn() }));

const now = new Date("2026-10-05T13:00:00Z");
const agreements = [{ id: "a1", shopId: "s1" }, { id: "a2", shopId: "s2" }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(recordBillingEntries).mockResolvedValue(2);
  vi.mocked(createBillingCharge).mockResolvedValue({ id: "charge" });
  vi.mocked(submitPendingCharges).mockResolvedValue({ billed: 2, retry: 0, refused: 0, void: 0 });
});

describe("the billing pass", () => {
  test("enters, charges each active paid agreement, then submits due charges", async () => {
    const database = { billingAgreement: { findMany: vi.fn(async () => agreements) } };
    const adminForShop = vi.fn();
    const onProgress = vi.fn();

    const result = await runBillingPass({ database, adminForShop, now, onProgress });

    expect(database.billingAgreement.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: "ACTIVE", mode: { not: "FREE" } },
    }));
    expect(recordBillingEntries).toHaveBeenCalledWith({ database, agreement: agreements[0] });
    expect(createBillingCharge).toHaveBeenCalledWith({ database, agreement: agreements[1], now });
    expect(submitPendingCharges).toHaveBeenCalledWith({ database, adminForShop, now });
    expect(vi.mocked(submitPendingCharges).mock.invocationCallOrder[0])
      .toBeGreaterThan(vi.mocked(createBillingCharge).mock.invocationCallOrder[1]);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ agreements: 2, entries: 4, charges: 2, billed: 2, retry: 0, refused: 0, void: 0 });
  });

  test("one shop's ledger failure does not stop the others", async () => {
    const database = { billingAgreement: { findMany: vi.fn(async () => agreements) } };
    vi.mocked(recordBillingEntries).mockRejectedValueOnce(new Error("db"));

    const result = await runBillingPass({ database, adminForShop: vi.fn(), now });

    expect(reportFailure).toHaveBeenCalledWith("billing_ledger_failed", expect.any(Error), { shopId: "s1", agreementId: "a1" });
    expect(createBillingCharge).toHaveBeenCalledTimes(1);
    expect(result.charges).toBe(1);
  });
});
