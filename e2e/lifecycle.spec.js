import { test, expect } from "./support/fixtures.js";
import { Checkout, newBuyerContext } from "./support/checkout.js";

test("test purchases, historical rates, control orders, and fee refunds reach the Overview", async ({
  staging,
}, testInfo) => {
  test.setTimeout(900_000);
  await staging.merchant.setRate("1");
  const liveBaseline = await staging.merchant.metrics(false);
  const baseline = await staging.merchant.metrics(true);
  /** @type {import("@playwright/test").BrowserContext[]} */
  const contexts = [];
  const purchase = async (label = "", protectedOrder = true, fee = 1) => {
    const context = await newBuyerContext(staging.buyerBrowser, {
      viewport: { width: 1440, height: 1000 },
    });
    contexts.push(context);
    const checkout = new Checkout(await context.newPage(), staging.config);
    try {
      const email = await checkout.start("physical", staging.runId, label);
      await checkout.expectOffer(fee, false);
      if (protectedOrder) {
        await checkout.selectProtection(true);
        await checkout.expectProtectionLine(fee);
      } else await checkout.expectNoProtectionLine();
      await checkout.pay();
      const gid = await staging.merchant.findOrder(email);
      const order = await staging.database.waitForOrder(gid, protectedOrder);
      await testInfo.attach(`${label}-order`, {
        body: JSON.stringify({ shop: staging.config.shopDomain, order: gid }),
        contentType: "application/json",
      });
      expect(order.isTest).toBe(true);
      expect(order.paidEligible).toBe(true);
      if (protectedOrder) {
        expect(order.protectionPurchase?.feeAmount.toFixed(4)).toBe(
          `${fee.toFixed(4)}`,
        );
        expect(order.protectionPurchase?.currencyCode).toBe(order.currencyCode);
        expect(order.protectionPurchase?.pricingCheck).toBe("MATCHED");
        expect(order.protectionPurchase?.attributionStatus).toBe("ATTRIBUTED");
        expect(order.protectionPurchase?.rateBasisPoints).toBe(fee * 100);
        expect(order.protectionPurchase?.basis).toBe("SHIPPABLE_PRE_DISCOUNT");
        expect(
          order.protectionPurchase?.eligibleSubtotalAmount?.toFixed(4),
        ).toBe("100.0000");
        expect(order.protectionPurchase?.pricingRuleId).toBe(
          (await staging.database.activeRule()).id,
        );
        expect(await staging.database.purchaseCount(gid)).toBe(1);
      } else expect(order.protectionPurchase).toBeNull();
      return { gid, order };
    } catch (error) {
      const screenshot = await checkout.page
        .screenshot()
        .catch(() => undefined);
      if (screenshot)
        await testInfo.attach(`${label} buyer failure`, {
          body: screenshot,
          contentType: "image/png",
        });
      throw error;
    }
  };
  try {
    const first = await test.step("buy protection at 1%", () =>
      purchase("protected-v1"));
    const original = first.order.protectionPurchase;
    await test.step("change to 2% and preserve the paid snapshot", async () => {
      await staging.merchant.setRate("2");
      const unchanged = await staging.database.order(first.gid);
      expect(unchanged?.protectionPurchase).toEqual(original);
      const second = await purchase("protected-v2", true, 2);
      expect(second.order.protectionPurchase?.ruleVersion).toBeGreaterThan(
        original?.ruleVersion ?? 0,
      );
    });
    await test.step("ingest an unprotected control order", () =>
      purchase("unprotected", false, 2));
    await staging.merchant.expectMetrics({
      revenue: baseline.revenue + 3,
      protectedOrders: baseline.protectedOrders + 2,
      eligibleOrders: baseline.eligibleOrders + 3,
      netRevenue: baseline.netRevenue + 3,
    });
    await test.step("refund only the first protection line", async () => {
      await staging.merchant.refundProtection(first.gid, 1, first.order.currencyCode);
      const refunds = await staging.database.waitForRefund(first.gid);
      expect(refunds).toHaveLength(1);
      expect(refunds[0].amount.toFixed(4)).toBe("1.0000");
      expect(refunds[0].currencyCode).toBe(first.order.currencyCode);
      expect(
        (await staging.database.order(first.gid))?.protectionPurchase,
      ).toEqual(original);
    });
    await staging.merchant.expectMetrics({
      revenue: baseline.revenue + 3,
      protectedOrders: baseline.protectedOrders + 2,
      eligibleOrders: baseline.eligibleOrders + 3,
      netRevenue: baseline.netRevenue + 2,
    });
    await expect(
      staging.merchant.frame
        .locator("s-table-row")
        .filter({ hasText: /Protection refunded/ })
        .filter({ hasText: first.order.name }),
    ).toBeVisible();
    expect(await staging.merchant.metrics(false)).toEqual(liveBaseline);
  } finally {
    for (const context of contexts) await context.close();
  }
});
