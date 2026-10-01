import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import { readConfig, AUTH_DIRECTORY } from "./config.js";
import { StagingDatabase } from "./database.js";
import { Checkout, newBuyerContext } from "./checkout.js";
import { openMerchant } from "./merchant.js";
import { RunJournal } from "./journal.js";

/** @typedef {{config: ReturnType<typeof readConfig>, context: import("@playwright/test").BrowserContext, buyerBrowser: import("@playwright/test").Browser, merchant: import("./merchant.js").Merchant, database: StagingDatabase, runId: string}} Staging */

export const test = base.extend(
  /** @type {import("@playwright/test").Fixtures<{checkout: Checkout}, {staging: Staging}, import("@playwright/test").PlaywrightTestArgs & import("@playwright/test").PlaywrightTestOptions, import("@playwright/test").PlaywrightWorkerArgs & import("@playwright/test").PlaywrightWorkerOptions>} */ ({
    staging: [
      async ({ browser }, use) => {
        const config = readConfig();
        const database = new StagingDatabase(config);
        const journal = new RunJournal(fileURLToPath(AUTH_DIRECTORY));
        let opened;
        let originalPercent;
        try {
          await database.preflight();
          opened = await openMerchant(browser, config);
          const { merchant, context } = opened;
          const buyerBrowser = context.browser();
          if (!buyerBrowser)
            throw new Error("The staging browser is unavailable.");
          const response = await context.request.get(
            `${config.appOrigin}/healthz`,
          );
          expect(response.ok()).toBe(true);
          expect(await response.json()).toEqual({ ok: true });
          originalPercent = await merchant.healthy();
          config.testGatewayCardName = await merchant.verifyTestGateway();
          const runId = randomUUID();
          // Validate published fixtures and checkout placement before changing any setting.
          const probeContext = await newBuyerContext(buyerBrowser);
          try {
            const probe = new Checkout(await probeContext.newPage(), config);
            await probe.start("mixed", runId, "preflight", true);
            await expect(probe.offer()).toBeVisible();
          } finally {
            await probeContext.close();
          }
          journal.start(originalPercent);
          try {
            await use({
              config,
              context,
              buyerBrowser,
              merchant,
              database,
              runId,
            });
          } finally {
            // Keep this journal when restoration fails; recovery must not silently lose it.
            await merchant.setRate(originalPercent);
            expect((await database.activeRule()).rateBasisPoints).toBe(
              Math.round(Number(originalPercent) * 100),
            );
            journal.finish();
          }
        } finally {
          if (opened) await opened.close();
          await database.close();
        }
      },
      { scope: "worker", timeout: 300_000 },
    ],
    checkout: async ({ staging, viewport, isMobile, hasTouch }, use) => {
      const context = await newBuyerContext(staging.buyerBrowser, {
        viewport,
        isMobile,
        hasTouch,
      });
      try {
        await use(new Checkout(await context.newPage(), staging.config));
      } finally {
        await context.close();
      }
    },
  }),
);

export { expect };
