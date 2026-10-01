import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import {
  readConfig,
  AUTH_DIRECTORY,
  assertAdminUrl,
} from "./support/config.js";
import { stagingFrame } from "./support/merchant.js";
import {
  isStagingAdmin,
  openAuthBrowser,
  SIGN_IN_TIMEOUT,
} from "./support/auth-browser.js";

const config = readConfig(process.env, "auth");
const regularChrome = !process.argv.includes("--bundled");
console.log(
  `Sign into Shopify and open protection-staging in ${config.shopDomain}. No login trace is recorded.`,
);
let opened;
try {
  opened = await openAuthBrowser(config.adminAppUrl, regularChrome);
  const { context } = opened;
  const page =
    context.pages().find((candidate) => isStagingAdmin(candidate.url())) ??
    context.pages()[0] ??
    (await context.newPage());
  if (!isStagingAdmin(page.url())) await page.goto(config.adminAppUrl);
  // Give the human time to complete normal sign-in/MFA. No passwords are scripted.
  await page.waitForURL((url) => isStagingAdmin(url.href), {
    timeout: SIGN_IN_TIMEOUT,
  });
  await stagingFrame(page, config, SIGN_IN_TIMEOUT);
  const adminAppUrl = page
    .url()
    .match(
      /^https:\/\/admin\.shopify\.com\/store\/app-test-kwvgodpl\/apps\/[^/?]+/,
    )?.[0];
  if (!adminAppUrl)
    throw new Error("The staging Admin app URL could not be saved.");
  assertAdminUrl(adminAppUrl);
  mkdirSync(AUTH_DIRECTORY, { recursive: true, mode: 0o700 });
  const authFile = new URL("shopify.json", AUTH_DIRECTORY);
  await context.storageState({ path: authFile.pathname, indexedDB: true });
  chmodSync(authFile, 0o600);
  writeFileSync(
    new URL("metadata.json", AUTH_DIRECTORY),
    JSON.stringify(
      {
        shopDomain: config.shopDomain,
        appOrigin: config.appOrigin,
        clientId: config.clientId,
        adminAppUrl,
        browserMode: regularChrome ? "regular-chrome" : "playwright",
        savedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    "Staging sign-in saved. Run npm run test:e2e:headed to watch the suite.",
  );
} catch {
  // Playwright errors include navigation logs containing OAuth secrets.
  console.error(
    "Staging sign-in was not saved. Install Google Chrome, keep its sign-in window open, complete sign-in, and open protection-staging. Run npm run test:e2e:auth to try again.",
  );
  process.exitCode = 1;
} finally {
  await opened?.close();
}
