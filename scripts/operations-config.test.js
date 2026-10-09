// @vitest-environment node
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parseTOML, parseYAML } from "confbox";
import { expect, test } from "vitest";

const read = (file) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const definitions = {
  shipping_protection_config: {
    type: "json",
    name: "Shipping protection configuration",
    description:
      "Checkout-only shipping protection product and pricing contract",
  },
  shipping_protection_offer: {
    type: "json",
    name: "Shipping protection checkout offer",
    description:
      "Per-store selection preference and customer-facing checkout text",
  },
};
test.each([
  "shopify.app.toml",
  "shopify.app.production.toml",
  "shopify.app.staging.toml",
  "shopify.app.staging.toml.example",
])("%s declares the same protection contracts", (file) => {
  expect(parseTOML(read(file)).shop.metafields.app).toEqual(definitions);
});
test.each(["shopify.app.staging.toml", "shopify.app.staging.toml.example"])(
  "%s deploys its app configuration",
  (file) => {
    expect(parseTOML(read(file)).build.include_config_on_deploy).toBe(true);
  },
);
test("checkout subscribes to both app-owned protection contracts", () => {
  expect(
    parseTOML(read("extensions/insurance-ext/shopify.extension.toml"))
      .extensions[0].metafields,
  ).toEqual(
    Object.keys(definitions).map((key) => ({ namespace: "$app", key })),
  );
});
test("local PostgreSQL is accessible only through loopback", () => {
  expect(parseYAML(read("compose.yaml")).services.postgres.ports).toEqual([
    "127.0.0.1:5432:5432",
  ]);
});
const ci = parseYAML(read(".github/workflows/ci.yml"));
test("application checks migrate and compare PostgreSQL 17 with fresh dependencies", () => {
  const job = ci.jobs.checks;
  expect(job?.services.postgres.image).toBe("postgres:17");
  const install = job.steps.find((step) => step.run === "npm ci");
  expect(install).toBeDefined();
  expect(install.if).toBeUndefined();
  expect(
    job.steps.some((step) => step.uses?.startsWith("actions/cache@")),
  ).toBe(false);
  expect(
    job.steps.find((step) => step.uses?.startsWith("actions/setup-node@")).with
      .cache,
  ).toBe("npm");
  expect(
    job.steps.findIndex((step) => step.run === "npm run verify:schema"),
  ).toBeGreaterThan(
    job.steps.findIndex((step) => step.run === "npx prisma migrate deploy"),
  );
});
test("Docker builds the same Node version as CI and loads the image for runtime verification", () => {
  const node = ci.jobs.checks?.steps.find((step) =>
    step.uses?.startsWith("actions/setup-node@"),
  ).with["node-version"];
  expect(read("Dockerfile").match(/^FROM (.+)$/gm)).toEqual([
    `FROM node:${node}-alpine AS build`,
    `FROM node:${node}-alpine`,
  ]);
  const runtime = read("Dockerfile").split("FROM ")[2];
  expect(runtime.indexOf("COPY prisma ./prisma")).toBeGreaterThan(
    runtime.indexOf("RUN npm ci"),
  );
  expect(
    ci.jobs.docker.steps.find((step) =>
      step.uses?.startsWith("docker/build-push-action@"),
    ).with.load,
  ).toBe(true);
  expect(
    ci.jobs.docker.steps.some(
      (step) => step.run === "bash scripts/verify-container.sh insurance-ci",
    ),
  ).toBe(true);
});
test.each(["success", "failure", "skipped", "cancelled"])(
  "aggregate gate handles %s dependencies",
  (status) => {
    const job = ci.jobs.verify;
    expect(job.needs).toEqual(["checks", "docker"]);
    expect(job.if).toBe("always()");
    for (const [checks, docker] of [
      [status, "success"],
      ["success", status],
    ]) {
      const command = job.steps[0].run
        .replaceAll("${{ needs.checks.result }}", checks)
        .replaceAll("${{ needs.docker.result }}", docker);
      expect(spawnSync("bash", ["-c", command]).status).toBe(
        status === "success" ? 0 : 1,
      );
    }
  },
);
