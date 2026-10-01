import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { AUTH_DIRECTORY } from "./config.js";

export const SIGN_IN_TIMEOUT = 600_000;

/** @param {string} url */
export function isStagingAdmin(url) {
  const parsed = new URL(url);
  return (
    parsed.hostname === "admin.shopify.com" &&
    parsed.pathname.startsWith("/store/app-test-kwvgodpl/apps/")
  );
}

function installedChrome() {
  const candidates =
    process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : process.platform === "win32"
        ? ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"].map((key) =>
            join(
              process.env[key] ?? "",
              "Google/Chrome/Application/chrome.exe",
            ),
          )
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/opt/google/chrome/chrome",
          ];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable)
    throw new Error("Install Google Chrome before using --chrome.");
  return executable;
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not reserve a local Chrome port.");
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve(undefined))),
  );
  return address.port;
}

/** @param {string} adminAppUrl @param {boolean} regularChrome */
export async function openAuthBrowser(adminAppUrl, regularChrome = false) {
  mkdirSync(AUTH_DIRECTORY, { recursive: true, mode: 0o700 });
  const profile = new URL("browser-profile/", AUTH_DIRECTORY).pathname;
  if (!regularChrome) {
    const context = await chromium.launchPersistentContext(profile, {
      headless: false,
      locale: "en-AU",
    });
    return { context, close: () => context.close() };
  }

  const port = await availablePort();
  // Start ordinary Chrome. Do not attach Playwright during the provider's sign-in.
  // Only this isolated profile is exposed, and only on the loopback interface.
  const child = spawn(
    installedChrome(),
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--lang=en-AU",
      adminAppUrl,
    ],
    { stdio: "ignore" },
  );
  let launchError = false;
  child.on("error", () => {
    launchError = true;
  });
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
  };
  const shutdown = async () => {
    stop();
    const deadline = Date.now() + 5000;
    while (
      child.exitCode === null &&
      child.signalCode === null &&
      Date.now() < deadline
    )
      await delay(50);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const endpoint = `http://127.0.0.1:${port}`;
  /** @type {import("@playwright/test").Browser | undefined} */
  let browser;
  try {
    const deadline = Date.now() + SIGN_IN_TIMEOUT;
    let signedIn = false;
    while (Date.now() < deadline) {
      if (launchError || child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          "The Chrome sign-in window closed before sign-in completed.",
        );
      try {
        const response = await fetch(`${endpoint}/json/list`, {
          signal: AbortSignal.timeout(2000),
        });
        const pages = /** @type {{type: string, url: string}[]} */ (
          await response.json()
        );
        signedIn = pages.some(
          (page) => page.type === "page" && isStagingAdmin(page.url),
        );
      } catch {
        // Chrome may still be starting. Never print provider URLs or OAuth parameters.
      }
      if (signedIn) break;
      await delay(500);
    }
    if (!signedIn)
      throw new Error("Shopify sign-in did not complete within ten minutes.");
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context)
      throw new Error("Chrome did not expose the test sign-in context.");
    return {
      context,
      close: async () => {
        await browser?.close();
        await shutdown();
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      },
    };
  } catch (error) {
    await browser?.close();
    await shutdown();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    throw error;
  }
}
