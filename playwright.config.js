import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.js",
  globalSetup: "./e2e/setup.js",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  maxFailures: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: ".playwright/results",
  reporter: [
    ["list"],
    ["html", { outputFolder: ".playwright/report", open: "never" }],
  ],
  use: {
    browserName: "chromium",
    locale: "en-AU",
    timezoneId: "Australia/Sydney",
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: "mobile-checkout",
      testMatch: "**/checkout.spec.js",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
