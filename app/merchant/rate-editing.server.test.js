import { describe, expect, test } from "vitest";
import {
  setProtectionRateEditing,
  setProtectionEditing,
} from "./rate-editing.server.js";

// Exercise the real per-shop settings lock against an in-memory database boundary.
function database() {
  const shops = new Map([
    [
      "one.myshopify.com",
      { id: "one", installationState: "INSTALLED", settingsLockedUntil: null },
    ],
    [
      "two.myshopify.com",
      { id: "two", installationState: "INSTALLED", settingsLockedUntil: null },
    ],
  ]);
  const configurations = new Map([
    [
      "one",
      {
        shopId: "one",
        protectionEnabled: true,
        protectionRateEditable: true,
        attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
      },
    ],
    [
      "two",
      { shopId: "two", protectionEnabled: true, protectionRateEditable: true },
    ],
  ]);
  const db = {
    shops,
    configurations,
    shop: {
      findUnique: async ({ where }) => shops.get(where.shopDomain) ?? null,
      updateMany: async ({ where, data }) => {
        const shop =
          shops.get(where.shopDomain) ??
          [...shops.values()].find((row) => row.id === where.id);
        if (!shop) return { count: 0 };
        if (
          where.OR &&
          shop.settingsLockedUntil > where.OR[1].settingsLockedUntil.lte
        )
          return { count: 0 };
        if (
          where.settingsLockedUntil &&
          where.settingsLockedUntil.gt &&
          !(shop.settingsLockedUntil > where.settingsLockedUntil.gt)
        )
          return { count: 0 };
        Object.assign(shop, data);
        return { count: 1 };
      },
    },
    shopConfiguration: {
      upsert: async ({ where, create, update }) => {
        const existing = configurations.get(where.shopId);
        const result = existing
          ? { ...existing, ...update }
          : { protectionEnabled: false, ...create };
        configurations.set(where.shopId, result);
        return result;
      },
    },
  };
  db.$transaction = async (run) => run(db);
  return db;
}

describe("operator rate editing configuration", () => {
  test("locks copy for one tenant without changing pricing permissions", async () => {
    const db = database();
    await setProtectionEditing("one.myshopify.com", "copy", false, {
      database: db,
    });
    expect(db.configurations.get("one")).toMatchObject({
      protectionRateEditable: true,
      protectionCopyEditable: false,
    });
    expect(db.configurations.get("two")).not.toHaveProperty(
      "protectionCopyEditable",
    );
    await expect(
      setProtectionEditing("one.myshopify.com", "protectionEnabled", true, {
        database: db,
      }),
    ).rejects.toThrow();
  });
  test("locks one store, preserves its setup, and leaves another store editable", async () => {
    const db = database();
    await setProtectionRateEditing("one.myshopify.com", false, {
      database: db,
    });
    expect(db.configurations.get("one")).toEqual({
      shopId: "one",
      protectionEnabled: true,
      protectionRateEditable: false,
      attachmentStrategy: "CHECKOUT_UI_CART_TRANSFORM",
    });
    expect(db.configurations.get("two").protectionRateEditable).toBe(true);
    expect(db.shops.get("one.myshopify.com").settingsLockedUntil).toBeNull();
    await setProtectionRateEditing("one.myshopify.com", true, { database: db });
    expect(db.configurations.get("one").protectionRateEditable).toBe(true);
  });

  test("can lock an installed store before first setup without enabling protection", async () => {
    const db = database();
    db.configurations.delete("one");
    await setProtectionRateEditing("one.myshopify.com", false, {
      database: db,
    });
    expect(db.configurations.get("one")).toMatchObject({
      protectionEnabled: false,
      protectionRateEditable: false,
    });
  });

  test("rejects unknown and uninstalled stores without creating configuration", async () => {
    const db = database();
    await expect(
      setProtectionRateEditing("unknown.myshopify.com", false, {
        database: db,
      }),
    ).rejects.toThrow("installed store");
    db.shops.get("one.myshopify.com").installationState = "UNINSTALLED";
    await expect(
      setProtectionRateEditing("one.myshopify.com", false, { database: db }),
    ).rejects.toThrow("installed store");
    expect(db.configurations.size).toBe(2);
    expect(db.configurations.get("one").protectionRateEditable).toBe(true);
  });

  test.each([
    ["", false],
    [undefined, false],
    ["one.example.com", false],
    ["one.myshopify.com", "false"],
    ["one.myshopify.com", undefined],
  ])(
    "rejects invalid operator input %s / %s before writing",
    async (domain, editable) => {
      const db = database();
      await expect(
        setProtectionRateEditing(domain, editable, { database: db }),
      ).rejects.toThrow();
      expect(db.configurations.get("one").protectionRateEditable).toBe(true);
      expect(db.shops.get("one.myshopify.com").settingsLockedUntil).toBeNull();
    },
  );

  test("refuses access changes while a rate change holds the store's lock", async () => {
    const db = database();
    const lease = new Date(Date.now() + 60_000);
    db.shops.get("one.myshopify.com").settingsLockedUntil = lease;
    await expect(
      setProtectionRateEditing("one.myshopify.com", false, { database: db }),
    ).rejects.toThrow("Another settings change");
    expect(db.configurations.get("one").protectionRateEditable).toBe(true);
    expect(db.shops.get("one.myshopify.com").settingsLockedUntil).toBe(lease);
  });
});
