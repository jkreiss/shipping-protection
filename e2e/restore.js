import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { readConfig, AUTH_DIRECTORY } from "./support/config.js";
import { StagingDatabase } from "./support/database.js";
import { RunJournal } from "./support/journal.js";
import { openMerchant } from "./support/merchant.js";

const config = readConfig(process.env, "restore");
const directory = fileURLToPath(AUTH_DIRECTORY);
const pending = RunJournal.pending(directory);
try {
  process.kill(pending.pid, 0);
  throw new Error(
    "The original test process is still running. Stop it before restoring its rate.",
  );
} catch (error) {
  if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH")
    throw error;
}
const database = new StagingDatabase(config);
const browser = await chromium.launch({ headless: false });
try {
  await database.preflight();
  const { merchant, close } = await openMerchant(browser, config);
  try {
    await merchant.setRate(pending.originalPercent);
    expect((await database.activeRule()).rateBasisPoints).toBe(
      Math.round(Number(pending.originalPercent) * 100),
    );
    new RunJournal(directory).finish();
    console.log(
      `Restored the staging protection percentage to ${pending.originalPercent}%.`,
    );
  } finally {
    await close();
  }
} finally {
  await database.close();
  await browser.close();
}
