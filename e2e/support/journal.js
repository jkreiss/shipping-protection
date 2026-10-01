import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STAGING_SHOP } from "./config.js";

export class RunJournal {
  /** @param {string} directory */
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, "rate-restore.json");
  }

  /** @param {string} originalPercent */
  start(originalPercent) {
    if (
      !/^\d+(?:\.\d{1,2})?$/.test(originalPercent) ||
      Number(originalPercent) <= 0 ||
      Number(originalPercent) > 100
    )
      throw new Error("The original protection percentage is invalid.");
    try {
      writeFileSync(
        this.path,
        JSON.stringify(
          {
            shopDomain: STAGING_SHOP,
            originalPercent,
            pid: process.pid,
            startedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST")
        throw new Error(
          "A run is active or was interrupted. Run npm run test:e2e:restore before starting another run.",
        );
      throw error;
    }
  }

  finish() {
    unlinkSync(this.path);
  }

  /** @param {string} directory */
  static pending(directory) {
    let data;
    try {
      data = JSON.parse(
        readFileSync(join(directory, "rate-restore.json"), "utf8"),
      );
    } catch {
      throw new Error("No interrupted run journal could be read.");
    }
    if (
      data.shopDomain !== STAGING_SHOP ||
      !/^\d+(?:\.\d{1,2})?$/.test(data.originalPercent) ||
      Number(data.originalPercent) <= 0 ||
      Number(data.originalPercent) > 100 ||
      !Number.isSafeInteger(data.pid) ||
      data.pid <= 0
    )
      throw new Error(
        "Recovery journal does not describe the staging store, a valid percentage, and a process ID.",
      );
    return /** @type {{shopDomain: string, originalPercent: string, pid: number, startedAt: string}} */ (
      data
    );
  }
}
