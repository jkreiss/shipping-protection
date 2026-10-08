import { adminApiVersion } from "./shopify/api-version.server.js";
// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import { ShopAwareSessionStorage } from "./session-storage.server.js";
import { ensureInstalledShop, markShopUninstalled } from "./shop.server.js";

afterEach(() => vi.unstubAllGlobals());

const domain = "one.myshopify.com";
const identity = {
  shop: { id: "gid://shopify/Shop/1", myshopifyDomain: domain },
  currentAppInstallation: { id: "gid://shopify/AppInstallation/1" },
};
function fixture(initial = null, realVerification = false) {
  let row = initial && {
    id: "shop-1",
    shopDomain: domain,
    installationState: "INSTALLED",
    installationGeneration: 0,
    ...initial,
  };
  const sessions = new Map();
  const db = {
    shop: {
      findUnique: vi.fn(async () => row && { ...row }),
      upsert: vi.fn(async ({ create, update }) => {
        if (!row)
          row = {
            id: "shop-1",
            installationState: "INSTALLED",
            installationGeneration: 0,
            ...create,
          };
        else Object.assign(row, update);
        return { ...row };
      }),
      update: vi.fn(async ({ data }) => {
        for (const [key, value] of Object.entries(data))
          row[key] =
            value && typeof value === "object" && "increment" in value
              ? row[key] + value.increment
              : value;
        return { ...row };
      }),
      updateMany: vi.fn(async ({ data }) => {
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    session: {
      count: async () => sessions.size,
      upsert: vi.fn(async ({ create }) => {
        sessions.set(create.id, create);
      }),
      deleteMany: vi.fn(async () => {
        sessions.clear();
      }),
    },
    $queryRaw: vi.fn(async () => (row ? [{ ...row }] : [])),
    $transaction: async (run) => run(db),
  };
  db.shop.createMany = async ({ data }) =>
    db.shop.upsert({ create: data, update: {} });
  const delegateFactory = (database) => ({
    storeSession: async (session) => {
      await database.session.upsert({
        where: { id: session.id },
        create: session,
        update: session,
      });
      return true;
    },
    loadSession: async (id) => sessions.get(id),
    isReady: async () => true,
  });
  const verifySession = vi.fn(async () => identity);
  const storage = new ShopAwareSessionStorage(db, {
    ...(realVerification ? {} : { verifySession }),
    delegateFactory,
  });
  const session = {
    id: `offline_${domain}`,
    shop: domain,
    accessToken: "test-token",
  };
  return { db, storage, session, sessions, verifySession, row: () => row };
}

describe("installation session lifecycle", () => {
  test("first verified authentication records identity and session", async () => {
    const f = fixture();
    expect(await f.storage.storeSession(f.session)).toBe(true);
    expect(f.row()).toMatchObject({
      installationState: "INSTALLED",
      installationGeneration: 0,
      shopGid: identity.shop.id,
    });
    expect(f.verifySession).toHaveBeenCalledOnce();
    expect(f.sessions.size).toBe(1);
  });
  test("concurrent initial authentication stores both verified sessions", async () => {
    const f = fixture();
    await Promise.all([
      f.storage.storeSession(f.session),
      f.storage.storeSession({ ...f.session, id: "online" }),
    ]);
    expect(f.sessions.size).toBe(2);
    expect(f.row().installationGeneration).toBe(0);
  });
  test("ordinary refresh preserves the generation", async () => {
    const f = fixture({ installationGeneration: 4, shopGid: identity.shop.id });
    await f.storage.storeSession(f.session);
    expect(f.row().installationGeneration).toBe(4);
    expect(f.db.shop.update).not.toHaveBeenCalled();
  });
  test("verified reinstall preserves merchant state and increments generation", async () => {
    const f = fixture({
      installationState: "UNINSTALLED",
      installationGeneration: 1,
      activePricingRuleId: "history",
    });
    await f.storage.storeSession(f.session);
    expect(f.row()).toMatchObject({
      installationState: "INSTALLED",
      installationGeneration: 2,
      activePricingRuleId: "history",
    });
  });
  test.each(["invalid", "mismatch", "no installation"])(
    "rejects %s token without persisting",
    async (kind) => {
      const f = fixture();
      if (kind === "invalid")
        f.verifySession.mockRejectedValue(new Error("Unauthorized"));
      else
        f.verifySession.mockResolvedValue(
          kind === "mismatch"
            ? {
                ...identity,
                shop: {
                  ...identity.shop,
                  myshopifyDomain: "other.myshopify.com",
                },
              }
            : { ...identity, currentAppInstallation: null },
        );
      await expect(f.storage.storeSession(f.session)).rejects.toThrow();
      expect(f.sessions.size).toBe(0);
      expect(f.row()).toBeNull();
    },
  );
  test.each([false, true])(
    "uninstall wins over in-flight save (initial=%s)",
    async (initial) => {
      const f = fixture(initial ? null : {});
      f.verifySession.mockImplementation(async () => {
        await markShopUninstalled(domain, f.db);
        return identity;
      });
      await expect(f.storage.storeSession(f.session)).rejects.toMatchObject({
        response: { code: 401 },
      });
      expect(f.row()).toMatchObject({
        installationState: "UNINSTALLED",
        installationGeneration: 1,
      });
      expect(f.sessions.size).toBe(0);
    },
  );
  test("uninstall after persistence deletes sessions and clears the lease", async () => {
    const f = fixture({
      settingsLockToken: "owner",
      settingsLockedUntil: new Date(),
    });
    await f.storage.storeSession(f.session);
    await markShopUninstalled(domain, f.db);
    expect(f.sessions.size).toBe(0);
    expect(f.row()).toMatchObject({
      installationState: "UNINSTALLED",
      installationGeneration: 1,
      settingsLockToken: null,
      settingsLockedUntil: null,
    });
    await markShopUninstalled(domain, f.db);
    expect(f.row().installationGeneration).toBe(1);
  });
  test("late old-generation save after reinstall loses access", async () => {
    const f = fixture();
    let finish;
    f.verifySession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const old = f.storage.storeSession(f.session);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await markShopUninstalled(domain, f.db);
    await f.storage.storeSession({ ...f.session, accessToken: "new-token" });
    finish(identity);
    await expect(old).rejects.toMatchObject({ response: { code: 401 } });
    expect(f.sessions.get(f.session.id).accessToken).toBe("new-token");
  });
  test("SDK token invalidation cannot overwrite a reinstalled session", async () => {
    const f = fixture({});
    await f.storage.storeSession(f.session);
    const loaded = await f.storage.loadSession(f.session.id);
    await markShopUninstalled(domain, f.db);
    await f.storage.storeSession({ ...f.session, accessToken: "new-token" });
    loaded.accessToken = undefined;
    await expect(f.storage.storeSession(loaded)).rejects.toMatchObject({
      response: { code: 401 },
    });
    expect(f.sessions.get(f.session.id).accessToken).toBe("new-token");
  });
  test("SDK token invalidation preserves an installed generation", async () => {
    const f = fixture({});
    await f.storage.storeSession(f.session);
    const loaded = await f.storage.loadSession(f.session.id);
    loaded.accessToken = undefined;
    await f.storage.storeSession(loaded);
    expect(f.row().installationGeneration).toBe(0);
    expect(f.sessions.get(f.session.id).accessToken).toBeUndefined();
  });
  test("page reads neither create nor reactivate installations and avoid ordinary writes", async () => {
    const absent = fixture();
    await expect(
      ensureInstalledShop(domain, undefined, absent.db),
    ).rejects.toThrow();
    const gone = fixture({ installationState: "UNINSTALLED" });
    await expect(
      ensureInstalledShop(domain, undefined, gone.db),
    ).rejects.toThrow();
    const installed = fixture({ shopGid: identity.shop.id });
    await ensureInstalledShop(domain, identity.shop.id, installed.db);
    expect(installed.db.shop.upsert).not.toHaveBeenCalled();
    expect(installed.db.shop.update).not.toHaveBeenCalled();
  });
});

test("server transport verifies the supplied token and current installation", async () => {
  const f = fixture(null, true);
  const fetch = vi.fn(async (_url, options) => {
    expect(options.headers["X-Shopify-Access-Token"]).toBe(
      f.session.accessToken,
    );
    expect(JSON.parse(options.body).query).toContain(
      "currentAppInstallation { id }",
    );
    return { ok: true, json: async () => ({ data: identity }) };
  });
  vi.stubGlobal("fetch", fetch);
  await f.storage.storeSession(f.session);
  expect(fetch.mock.calls[0][0]).toBe(
    `https://${domain}/admin/api/${adminApiVersion}/graphql.json`,
  );
});

test("revoked token is lost access and does not create an installation", async () => {
  const f = fixture(null, true);
  vi.stubGlobal("fetch", async () => ({ ok: false, status: 401 }));
  await expect(f.storage.storeSession(f.session)).rejects.toMatchObject({
    response: { code: 401 },
  });
  expect(f.row()).toBeNull();
});

test("a Shopify outage does not report a revoked installation", async () => {
  const f = fixture(null, true);
  vi.stubGlobal("fetch", async () => ({ ok: false, status: 503 }));
  const failure = await f.storage
    .storeSession(f.session)
    .catch((error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure.response?.code).not.toBe(401);
  expect(f.row()).toBeNull();
});
