// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { expect, test } from "vitest";

// Only the caller may authorize a disposable database. No .env loading here.
const isolated =
  process.env.VERIFY_ISOLATED_DB === "1" && Boolean(process.env.DATABASE_URL);
const root = fileURLToPath(new URL("../", import.meta.url));
const run = (file, { env = process.env, cwd = root, args = [] } = {}) =>
  spawnSync(process.execPath, [join(root, file), ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 90_000,
  });

test.each(["verify-postgres.js", "verify-webhook-postgres.js", "verify-merchant-auth-postgres.js"])(
  "%s refuses a missing isolation flag before connection",
  (file) => {
    const result = run(`scripts/${file}`, {
      env: {
        ...process.env,
        VERIFY_ISOLATED_DB: "",
        DATABASE_URL: "postgresql://dummy:dummy@127.0.0.1:1/no_database",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("VERIFY_ISOLATED_DB=1");
    expect(result.stderr).not.toContain("Can't reach database");
  },
  30_000,
);

test.skipIf(!isolated)(
  "Prisma 6 comparison exits 0 for migrated schema and 2 for an unmigrated model",
  () => {
    const temporary = mkdtempSync(join(tmpdir(), "insurance-schema-"));
    try {
      const args = [
        "migrate",
        "diff",
        "--from-schema-datasource",
        join(root, "prisma/schema.prisma"),
        "--to-schema-datamodel",
        join(root, "prisma/schema.prisma"),
        "--exit-code",
      ];
      expect(run("node_modules/prisma/build/index.js", { args }).status).toBe(
        0,
      );
      const schema = join(temporary, "schema.prisma");
      writeFileSync(
        schema,
        readFileSync(join(root, "prisma/schema.prisma"), "utf8") +
          "\nmodel UnmigratedRegression {\n  id Int @id\n}\n",
      );
      args[5] = schema;
      const drift = run("node_modules/prisma/build/index.js", { args });
      expect(drift.status).toBe(2);
      expect(drift.stdout).toContain("UnmigratedRegression");
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
  30_000,
);

test.skipIf(!isolated)(
  "all verifiers refuse nonempty shops without changes, then pass from another directory with no fixtures left",
  async () => {
    const { PrismaClient } = await import("@prisma/client");
    const db = new PrismaClient();
    const temporary = mkdtempSync(join(tmpdir(), "insurance-verifiers-"));
    let fixture;
    try {
      expect(await db.shop.count()).toBe(0);
      fixture = await db.shop.create({
        data: { shopDomain: "existing-verifier-regression.invalid" },
      });
      for (const file of ["verify-postgres.js", "verify-webhook-postgres.js", "verify-merchant-auth-postgres.js"]) {
        const result = run(`scripts/${file}`);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("empty Shop table");
        expect(await db.shop.count()).toBe(1);
        expect(await db.order.count()).toBe(0);
      }
      await db.shop.delete({ where: { id: fixture.id } });
      fixture = null;
      for (const file of ["verify-postgres.js", "verify-webhook-postgres.js", "verify-merchant-auth-postgres.js"]) {
        const result = run(`scripts/${file}`, { cwd: temporary });
        expect(result.stderr, result.stdout).not.toContain(
          "Cannot find module",
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("verification passed");
        expect(await db.shop.count()).toBe(0);
        expect(await db.order.count()).toBe(0);
      }
    } finally {
      if (fixture) await db.shop.delete({ where: { id: fixture.id } });
      rmSync(temporary, { recursive: true, force: true });
      await db.$disconnect();
    }
  },
  180_000,
);
