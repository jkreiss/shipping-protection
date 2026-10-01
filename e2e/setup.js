import { existsSync } from "node:fs";
import { readConfig, AUTH_DIRECTORY } from "./support/config.js";

export default function setup() {
  // Fail before launching a browser when required staging inputs are absent.
  readConfig();
  if (existsSync(new URL("rate-restore.json", AUTH_DIRECTORY))) {
    throw new Error(
      "A run is active or was interrupted. Run npm run test:e2e:restore before starting another run.",
    );
  }
}
