import { describe, expect, test } from "vitest";
import { isPastRetention, retentionCutoff } from "./order-retention.js";

describe("retention cutoff", () => {
  test("is the same moment 24 calendar months earlier", () => {
    expect(retentionCutoff(new Date("2026-10-07T03:04:05.006Z"))).toEqual(new Date("2024-10-07T03:04:05.006Z"));
  });

  test("clamps 29 February to the last day of February", () => {
    expect(retentionCutoff(new Date("2028-02-29T03:00:00.000Z"))).toEqual(new Date("2026-02-28T03:00:00.000Z"));
  });

  test("leaves other February dates unchanged", () => {
    expect(retentionCutoff(new Date("2026-02-28T00:00:00.000Z"))).toEqual(new Date("2024-02-28T00:00:00.000Z"));
    expect(retentionCutoff(new Date("2030-02-28T00:00:00.000Z"))).toEqual(new Date("2028-02-28T00:00:00.000Z"));
  });

  test("counts an order placed exactly at the cutoff as retained", () => {
    const now = new Date("2026-10-07T00:00:00.000Z");
    expect(isPastRetention(new Date("2024-10-07T00:00:00.000Z"), now)).toBe(false);
    expect(isPastRetention(new Date("2024-10-06T23:59:59.999Z"), now)).toBe(true);
  });
});
