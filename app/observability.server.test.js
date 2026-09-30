import { afterEach, describe, expect, test, vi } from "vitest";
import process from "node:process";
import { failureCode, reportFailure } from "./observability.server.js";

function capture() {
  const writes = [];
  vi.spyOn(process.stderr, "write").mockImplementation((line) => { writes.push(String(line)); return true; });
  return () => writes.map((line) => JSON.parse(line));
}

afterEach(() => vi.restoreAllMocks());

class PrismaClientInitializationError extends Error {
  constructor(message, errorCode) {
    super(message);
    this.name = "PrismaClientInitializationError";
    this.errorCode = errorCode;
  }
}

describe("failure reports", () => {
  test("name the error class and the loop without the error message", () => {
    const logged = capture();
    const error = new Error("order #1001 for jane@example.com failed");

    reportFailure("worker_loop_failed", error, { loop: "delivery" });

    const [entry] = logged();
    expect(entry).toMatchObject({ event: "worker_loop_failed", code: "PROCESSING_ERROR", errorName: "Error", loop: "delivery" });
    expect(JSON.stringify(entry)).not.toContain("jane@example.com");
    expect(JSON.stringify(entry)).not.toContain("1001");
  });

  test("use the Prisma error code from errors that report it as errorCode", () => {
    const error = new PrismaClientInitializationError("Error querying the database: FATAL", "P1001");
    expect(failureCode(error)).toBe("P1001");

    const logged = capture();
    reportFailure("worker_loop_failed", error);
    expect(logged()[0]).toMatchObject({ code: "P1001", errorName: "PrismaClientInitializationError" });
  });

  test("never log an error name that could carry data", () => {
    const logged = capture();
    const error = new Error("boom");
    error.name = "jane@example.com";

    reportFailure("worker_loop_failed", error);

    expect(logged()[0].errorName).toBe("Error");
  });

  test("reports non-Error values without failing", () => {
    const logged = capture();
    reportFailure("worker_loop_failed", "a string with order data");
    expect(logged()[0]).toMatchObject({ code: "PROCESSING_ERROR", errorName: "Unknown" });
    expect(JSON.stringify(logged()[0])).not.toContain("order data");
  });
});
