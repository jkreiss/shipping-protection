// @vitest-environment node
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunJournal } from "./support/journal.js";

const directories = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "insurance-e2e-journal-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

test("preserves the original rate on disk before any browser mutation", () => {
  const path = directory();
  const journal = new RunJournal(path);
  journal.start("0.25");
  expect(
    JSON.parse(readFileSync(join(path, "rate-restore.json"), "utf8"))
      .originalPercent,
  ).toBe("0.25");
  journal.finish();
});
test("refuses overlapping runs or an interrupted run whose rate was not restored", () => {
  const path = directory();
  new RunJournal(path).start("0.25");
  expect(() => new RunJournal(path).start("1")).toThrow(/restore/);
});
test("retains the journal after failed restoration and removes it only on success", () => {
  const path = directory();
  const journal = new RunJournal(path);
  journal.start("1.25");
  expect(RunJournal.pending(path).originalPercent).toBe("1.25");
  journal.finish();
  expect(() => RunJournal.pending(path)).toThrow(/No interrupted/);
});
test("rejects a journal for another store before restoring anything", () => {
  const path = directory();
  const journal = new RunJournal(path);
  journal.start("0.25");
  const file = join(path, "rate-restore.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  data.shopDomain = "other.myshopify.com";
  // Exercise a genuinely persisted, incorrect recovery target.
  writeFileSync(file, JSON.stringify(data));
  expect(() => RunJournal.pending(path)).toThrow(/staging store/);
});

test("refuses a malformed process ID instead of probing the process group", () => {
  const path = directory();
  new RunJournal(path).start("0.25");
  const file = join(path, "rate-restore.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  for (const pid of [0, -1, "123", null]) {
    writeFileSync(file, JSON.stringify({ ...data, pid }));
    expect(() => RunJournal.pending(path)).toThrow(/process ID/);
  }
});
