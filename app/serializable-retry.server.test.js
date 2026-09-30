import { describe, expect, test } from "vitest";
import { retrySerializationFailures } from "./serializable-retry.server";

const conflict = () => Object.assign(new Error("Transaction failed due to a write conflict"), { code: "P2034" });

describe("retrySerializationFailures", () => {
  test("reruns a transaction that lost a serialization conflict", async () => {
    let runs = 0;
    const result = await retrySerializationFailures(async () => {
      runs += 1;
      if (runs < 3) throw conflict();
      return "stored";
    }, { sleep: async () => {} });
    expect(result).toBe("stored");
    expect(runs).toBe(3);
  });

  test("gives up after three attempts", async () => {
    let runs = 0;
    await expect(retrySerializationFailures(async () => { runs += 1; throw conflict(); }, { sleep: async () => {} }))
      .rejects.toMatchObject({ code: "P2034" });
    expect(runs).toBe(3);
  });

  test("does not rerun other failures", async () => {
    let runs = 0;
    await expect(retrySerializationFailures(async () => { runs += 1; throw new Error("lease lost"); }, { sleep: async () => {} }))
      .rejects.toThrow("lease lost");
    expect(runs).toBe(1);
  });
});
