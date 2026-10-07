// @vitest-environment node
import { expect, test } from "vitest";
import { runEditingCommand } from "./checkout-editing.js";
// Execute the real setter and per-shop lock through a database boundary.
function database() {
  const shop = {
    id: "one",
    installationState: "INSTALLED",
    settingsLockedUntil: null,
  };
  let saved = {
    shopId: "one",
    protectionRateEditable: true,
    protectionCopyEditable: true,
    protectionEnabled: true,
    protectionRatePercent: "1.25",
    protectionOfferLabel: "Saved wording",
  };
  let disconnects = 0;
  return {
    saved: () => saved,
    disconnects: () => disconnects,
    shop: {
      findUnique: async ({ where }) =>
        where.shopDomain === "one.myshopify.com" ? shop : null,
      updateMany: async ({ data }) => {
        Object.assign(shop, data);
        return { count: 1 };
      },
    },
    shopConfiguration: {
      upsert: async ({ update }) => (saved = { ...saved, ...update }),
    },
    $disconnect: async () => {
      disconnects++;
    },
  };
}
async function command(args, legacy = false, db = database()) {
  const output = [],
    errors = [];
  const status = await runEditingCommand({
    args,
    legacy,
    database: db,
    output: (value) => output.push(value),
    errorOutput: (value) => errors.push(value),
  });
  return { db, output, errors, status };
}
test.each(["locked", "editable"])(
  "legacy and current pricing commands are equivalent (%s)",
  async (mode) => {
    const a = await command(["one.myshopify.com", mode], true);
    const b = await command(["one.myshopify.com", "pricing", mode]);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(a.db.saved()).toEqual(b.db.saved());
    expect(a.db.saved()).toMatchObject({
      protectionRateEditable: mode === "editable",
      protectionCopyEditable: true,
      protectionRatePercent: "1.25",
      protectionOfferLabel: "Saved wording",
      protectionEnabled: true,
    });
    expect(a.db.disconnects()).toBe(1);
    expect(b.db.disconnects()).toBe(1);
  },
);
test("copy editing remains independent of pricing and saved settings", async () => {
  const result = await command(["one.myshopify.com", "copy", "locked"]);
  expect(result.status).toBe(0);
  expect(result.db.saved()).toMatchObject({
    protectionCopyEditable: false,
    protectionRateEditable: true,
    protectionRatePercent: "1.25",
    protectionOfferLabel: "Saved wording",
  });
});
test.each([
  [[], false],
  [["one.myshopify.com", "locked"], false],
  [["one.myshopify.com", "copy", "editable", "extra"], false],
  [["one.myshopify.com", "copy", "invalid"], false],
  [["one.myshopify.com", "pricing", "locked"], true],
  [["one.example.com", "locked"], true],
  [["unknown.myshopify.com", "copy", "editable"], false],
])(
  "invalid editing arguments fail and disconnect (%j)",
  async (args, legacy) => {
    const result = await command(args, legacy);
    expect(result.status).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.db.disconnects()).toBe(1);
    expect(result.db.saved().protectionRateEditable).toBe(true);
    expect(result.db.saved().protectionCopyEditable).toBe(true);
  },
);
test("database and disconnect errors fail with a safe operator message", async () => {
  const db = database();
  db.$disconnect = async () => {
    throw new Error("secret connection string");
  };
  const result = await command(
    ["one.myshopify.com", "copy", "locked"],
    false,
    db,
  );
  expect(result.status).toBe(1);
  expect(result.errors.join(" ")).not.toContain("secret connection");
});
