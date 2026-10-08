import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { Session } from "@shopify/shopify-api";
import prisma from "../app/db.server.js";
import { ShopAwareSessionStorage } from "../app/session-storage.server.js";
import {
  markShopUninstalled,
  withShopSettingsLock,
} from "../app/shop.server.js";
import { withInstalledShopWrite } from "../app/settings-lease-context.server.js";
import { runVerification } from "./verification.js";

const other = new PrismaClient();
const domain = "merchant-auth-verification.myshopify.com";
const identity = {
  shop: { id: "gid://shopify/Shop/1", myshopifyDomain: domain },
  currentAppInstallation: { id: "gid://shopify/AppInstallation/1" },
};
const session = (token = "test-token") =>
  new Session({
    id: `offline_${domain}`,
    shop: domain,
    state: "test",
    isOnline: false,
    accessToken: token,
    refreshToken: "test-refresh",
  });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const storage = (database, verifySession = async () => identity) =>
  new ShopAwareSessionStorage(database, { verifySession });
const reset = async () => {
  await prisma.session.deleteMany({ where: { shop: domain } });
  await prisma.shop.deleteMany({ where: { shopDomain: domain } });
};

// The barriers hold a real transaction open. Observe PostgreSQL's lock wait,
// rather than guessing that the second operation is blocked after a timeout.
async function waitUntilBlocked(pid) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const [row] =
      await prisma.$queryRaw`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`;
    if (row?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected a PostgreSQL row lock wait.");
}

await runVerification({
  database: prisma,
  cleanup: [reset, () => other.$disconnect()],
  verify: async () => {
    const first = storage(prisma);
    const second = storage(other);
    await Promise.all([
      first.storeSession(session()),
      second.storeSession(
        new Session({ ...session().toObject(), id: "online-test" }),
      ),
    ]);
    assert.equal(await prisma.session.count({ where: { shop: domain } }), 2);
    assert.equal(
      (await prisma.shop.findUnique({ where: { shopDomain: domain } }))
        .installationGeneration,
      0,
    );
    await prisma.shopConfiguration.create({
      data: {
        shopId: (
          await prisma.shop.findUnique({ where: { shopDomain: domain } })
        ).id,
        protectionRateEditable: false,
      },
    });
    await markShopUninstalled(domain, other);
    await first.storeSession(session("reinstalled-token"));
    const reinstalled = await prisma.shop.findUnique({
      where: { shopDomain: domain },
      include: { configuration: true },
    });
    assert.equal(reinstalled.installationGeneration, 2);
    assert.equal(reinstalled.configuration.protectionRateEditable, false);
    assert.equal(
      (await first.loadSession(session().id)).refreshToken,
      "test-refresh",
    );
    await reset();

    for (const [firstWriter, existing] of [
      ["session", false],
      ["uninstall", false],
      ["session", true],
      ["uninstall", true],
    ]) {
      if (existing) await first.storeSession(session());
      const entered = deferred(),
        release = deferred(),
        contender = deferred();
      const blockingDb = {
        shop: prisma.shop,
        session: prisma.session,
        $transaction: (run) =>
          prisma.$transaction(
            async (tx) => {
              return run({
                ...tx,
                session: {
                  ...tx.session,
                  upsert: async (args) => {
                    const result = await tx.session.upsert(args);
                    if (firstWriter === "session") {
                      entered.resolve();
                      await release.promise;
                    }
                    return result;
                  },
                },
                shop: {
                  ...tx.shop,
                  update: async (args) => {
                    const result = await tx.shop.update(args);
                    if (firstWriter === "uninstall") {
                      entered.resolve();
                      await release.promise;
                    }
                    return result;
                  },
                },
              });
            },
            { timeout: 15_000 },
          ),
      };
      const contenderDb = {
        shop: other.shop,
        session: other.session,
        $transaction: (run) =>
          other.$transaction(
            async (tx) => {
              const [{ pid }] =
                await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;
              contender.resolve(pid);
              return run(tx);
            },
            { timeout: 15_000 },
          ),
      };
      const leading =
        firstWriter === "session"
          ? storage(blockingDb).storeSession(session())
          : markShopUninstalled(domain, blockingDb);
      await entered.promise;
      const trailing =
        firstWriter === "session"
          ? markShopUninstalled(domain, contenderDb)
          : storage(contenderDb).storeSession(session());
      const outcome = trailing.then(
        () => null,
        (error) => error,
      );
      try {
        await waitUntilBlocked(await contender.promise);
      } finally {
        release.resolve();
      }
      await leading;
      const error = await outcome;
      if (firstWriter === "uninstall") assert.equal(error?.response?.code, 401);
      else assert.equal(error, null);
      assert.equal(await prisma.session.count({ where: { shop: domain } }), 0);
      assert.equal(
        (await prisma.shop.findUnique({ where: { shopDomain: domain } }))
          .installationState,
        "UNINSTALLED",
      );
      await reset();
    }

    await first.storeSession(session());
    const verified = deferred(),
      resume = deferred();
    const stale = storage(other, async () => {
      verified.resolve();
      await resume.promise;
      return identity;
    }).storeSession(session("old-token"));
    const staleOutcome = stale.catch((error) => error);
    await verified.promise;
    await markShopUninstalled(domain, prisma);
    await first.storeSession(session("new-token"));
    resume.resolve();
    assert.equal((await staleOutcome).response.code, 401);
    assert.equal(
      (await first.loadSession(session().id)).accessToken,
      "new-token",
    );

    const held = deferred(),
      finish = deferred();
    let lease;
    const owner = withShopSettingsLock(domain, async (value) => {
      lease = value;
      held.resolve();
      await finish.promise;
      return "old";
    });
    const ownerOutcome = owner.catch((error) => error);
    await held.promise;
    await assert.rejects(
      withShopSettingsLock(domain, async () => "overlap", { database: other }),
    );
    await other.shop.update({
      where: { shopDomain: domain },
      data: { settingsLockedUntil: new Date(0) },
    });
    await withShopSettingsLock(
      domain,
      async () => {
        await assert.rejects(lease.assertHeld());
        finish.resolve();
        assert.match((await ownerOutcome).message, /interrupted/);
        const current = await other.shop.findUnique({
          where: { shopDomain: domain },
        });
        assert.ok(current.settingsLockToken);
        await withInstalledShopWrite(other, domain, (tx, shop) =>
          tx.shopConfiguration.upsert({
            where: { shopId: shop.id },
            create: { shopId: shop.id },
            update: { protectionRateEditable: true },
          }),
        );
      },
      { database: other },
    );
    assert.equal(
      (await prisma.shop.findUnique({ where: { shopDomain: domain } }))
        .settingsLockToken,
      null,
    );
    await assert.rejects(
      withShopSettingsLock(domain, async (lease) => {
        await withInstalledShopWrite(prisma, domain, async (tx, shop) => {
          await tx.shopConfiguration.update({
            where: { shopId: shop.id },
            data: { protectionRateEditable: false },
          });
          // Simulate a failed ownership/renewal query while a local mutation is
          // pending. Even if the callback catches it, the final guard rolls back.
          await assert.rejects(
            lease.assertHeld({
              shop: {
                updateMany: async () => {
                  throw new Error("lease database offline");
                },
              },
            }),
          );
          return "must not commit";
        });
      }),
      /interrupted/,
    );
    const preserved = await prisma.shop.findUnique({
      where: { shopDomain: domain },
      include: { configuration: true },
    });
    assert.equal(preserved.configuration.protectionRateEditable, true);
    await reset();
    assert.equal(await prisma.shop.count(), 0);
  },
});
console.log(
  "Merchant authentication PostgreSQL verification passed: independent connections, both existing-refresh and first-install row-lock orderings, first-install tombstone, stale reinstall save, preserved configuration/refresh tokens, and lease takeover.",
);
