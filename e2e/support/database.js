import { PrismaClient } from "@prisma/client";
import { expect } from "@playwright/test";
import { assertReadOnlyRole, INGESTION_TIMEOUT } from "./config.js";

export class StagingDatabase {
  /** @param {ReturnType<typeof import("./config.js").readConfig>} config */
  constructor(config) {
    this.client = new PrismaClient({
      datasourceUrl: config.databaseUrl,
      errorFormat: "minimal",
    });
    this.shopDomain = config.shopDomain;
    this.shopId = "";
  }
  async preflight() {
    const rows =
      /** @type {{superuser: boolean, canWrite: boolean, canReadSessions: boolean, canCreate: boolean}[]} */ (
        await this.client.$queryRaw`
      SELECT r.rolsuper AS "superuser",
        EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p')
          AND has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')) AS "canWrite",
        has_table_privilege(current_user,'public."Session"','SELECT') AS "canReadSessions",
        has_schema_privilege(current_user,'public','CREATE') AS "canCreate"
      FROM pg_roles r WHERE r.rolname=current_user
    `
      );
    if (rows.length !== 1)
      throw new Error("Could not verify the staging database login.");
    assertReadOnlyRole(rows[0]);
    const shop = await this.client.shop.findUnique({
      where: { shopDomain: this.shopDomain },
      select: { id: true, installationState: true },
    });
    if (!shop || shop.installationState !== "INSTALLED")
      throw new Error(
        "The staging database does not contain the installed staging tenant.",
      );
    this.shopId = shop.id;
    await expect
      .poll(
        () =>
          this.client.webhookDelivery.count({
            where: {
              shopId: this.shopId,
              status: { in: ["PENDING", "PROCESSING"] },
            },
          }),
        {
          timeout: INGESTION_TIMEOUT,
          message:
            "Wait for the staging worker to drain deliveries before measuring Overview changes.",
        },
      )
      .toBe(0);
  }
  async activeRule() {
    const shop = await this.client.shop.findUniqueOrThrow({
      where: { shopDomain: this.shopDomain },
      include: { activePricingRule: true },
    });
    if (
      !shop.activePricingRule ||
      shop.activePricingRule.shopId !== this.shopId
    )
      throw new Error("No tenant-owned active pricing rule.");
    return shop.activePricingRule;
  }
  async order(gid = "") {
    return this.client.order.findUnique({
      where: {
        shopId_shopifyOrderId: { shopId: this.shopId, shopifyOrderId: gid },
      },
      include: { protectionPurchase: true },
    });
  }
  async purchaseCount(gid = "") {
    return this.client.protectionPurchase.count({
      where: { shopId: this.shopId, order: { shopifyOrderId: gid } },
    });
  }
  async waitForOrder(gid = "", protectedOrder = true) {
    try {
      await expect
        .poll(
          async () => {
            const order = await this.order(gid);
            const delivered = await this.client.webhookDelivery.count({
              where: {
                shopId: this.shopId,
                shopifyOrderId: gid,
                topic: "ORDERS_PAID",
                status: "PROCESSED",
              },
            });
            return Boolean(
              delivered &&
              order?.firstPaidAt &&
              (protectedOrder
                ? order.protectionPurchase?.purchasedAt
                : !order.protectionPurchase),
            );
          },
          {
            timeout: INGESTION_TIMEOUT,
            intervals: [2000, 5000, 10000],
            message: `Paid order ${gid} was not processed by the staging webhook worker.`,
          },
        )
        .toBe(true);
    } catch (error) {
      await this.diagnostics(gid);
      throw error;
    }
    return this.client.order.findUniqueOrThrow({
      where: {
        shopId_shopifyOrderId: { shopId: this.shopId, shopifyOrderId: gid },
      },
      include: { protectionPurchase: true },
    });
  }
  async waitForRefund(gid = "") {
    const scope = {
      shopId: this.shopId,
      order: { shopifyOrderId: gid },
      status: /** @type {"CONFIRMED"} */ ("CONFIRMED"),
    };
    try {
      await expect
        .poll(
          async () => {
            const delivered = await this.client.webhookDelivery.count({
              where: {
                shopId: this.shopId,
                shopifyOrderId: gid,
                topic: "REFUNDS_CREATE",
                status: "PROCESSED",
              },
            });
            return Boolean(
              delivered &&
              (await this.client.protectionRefund.count({ where: scope })),
            );
          },
          {
            timeout: INGESTION_TIMEOUT,
            intervals: [2000, 5000, 10000],
            message: `Protection refund for ${gid} was not processed.`,
          },
        )
        .toBe(true);
    } catch (error) {
      await this.diagnostics(gid);
      throw error;
    }
    return this.client.protectionRefund.findMany({ where: scope });
  }
  async diagnostics(gid = "") {
    const deliveries = await this.client.webhookDelivery.findMany({
      where: { shopId: this.shopId, shopifyOrderId: gid },
      select: { topic: true, status: true, attempts: true, processedAt: true },
    });
    console.error(
      JSON.stringify({ shop: this.shopDomain, order: gid, deliveries }),
    );
  }
  async close() {
    await this.client.$disconnect();
  }
}
