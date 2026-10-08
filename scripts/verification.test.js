// @vitest-environment node
import { expect, test } from "vitest";
import { runVerification } from "./verification.js";

function database(count = 0) {
  const events = [];
  return {
    events,
    shop: {
      count: async () => {
        events.push("count");
        return count;
      },
    },
    $disconnect: async () => {
      events.push("disconnect");
    },
  };
}
test("missing isolation flag refuses database operations but disconnects", async () => {
  const db = database();
  await expect(
    runVerification({
      database: db,
      env: {},
      verify: async () => db.events.push("write"),
    }),
  ).rejects.toThrow(/VERIFY_ISOLATED_DB/);
  expect(db.events).toEqual(["disconnect"]);
});
test("a nonempty Shop table is refused before fixture writes", async () => {
  const db = database(1);
  await expect(
    runVerification({
      database: db,
      env: { VERIFY_ISOLATED_DB: "1" },
      verify: async () => db.events.push("write"),
    }),
  ).rejects.toThrow(/empty/);
  expect(db.events).toEqual(["count", "disconnect"]);
});
test("preserves the assertion failure and tries every cleanup and disconnect", async () => {
  const db = database(),
    assertion = new Error("assertion"),
    cleanup = new Error("cleanup"),
    disconnect = new Error("disconnect");
  db.$disconnect = async () => {
    db.events.push("disconnect");
    throw disconnect;
  };
  let error;
  try {
    await runVerification({
      database: db,
      env: { VERIFY_ISOLATED_DB: "1" },
      verify: async () => {
        throw assertion;
      },
      cleanup: [
        async () => {
          db.events.push("first");
          throw cleanup;
        },
        async () => db.events.push("second"),
      ],
    });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.cause).toBe(assertion);
  expect(error.errors).toEqual([assertion, cleanup, disconnect]);
  expect(db.events).toEqual(["count", "first", "second", "disconnect"]);
});
test("an assertion without cleanup failures retains its identity", async () => {
  const db = database(),
    assertion = new Error("assertion");
  await expect(
    runVerification({
      database: db,
      env: { VERIFY_ISOLATED_DB: "1" },
      verify: async () => {
        throw assertion;
      },
    }),
  ).rejects.toBe(assertion);
  expect(db.events.at(-1)).toBe("disconnect");
});
test("cleanup failure fails an otherwise successful verification", async () => {
  const db = database(),
    cleanup = new Error("cleanup");
  await expect(
    runVerification({
      database: db,
      env: { VERIFY_ISOLATED_DB: "1" },
      verify: async () => {},
      cleanup: [
        async () => {
          throw cleanup;
        },
        async () => db.events.push("later"),
      ],
    }),
  ).rejects.toBe(cleanup);
  expect(db.events).toEqual(["count", "later", "disconnect"]);
});
