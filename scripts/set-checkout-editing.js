import process from "node:process";
import prisma from "../app/db.server.js";
import { setProtectionEditing } from "../app/merchant/rate-editing.server.js";
import { UserFacingError } from "../app/user-facing-error.js";

try {
  const [shopDomain, setting, mode, ...extra] = process.argv.slice(2);
  if (
    extra.length ||
    !shopDomain ||
    !["pricing", "copy"].includes(setting) ||
    !["locked", "editable"].includes(mode)
  ) {
    throw new UserFacingError(
      "Usage: npm run merchant:checkout-editing -- store.myshopify.com pricing|copy locked|editable",
    );
  }
  await setProtectionEditing(shopDomain, setting, mode === "editable");
  console.log(
    `Checkout ${setting} editing for ${shopDomain}: ${mode}. Saved offer settings are unchanged.`,
  );
} catch (error) {
  console.error(
    error instanceof UserFacingError
      ? error.message
      : "Unable to update checkout editing access. Check operator database access and migrations.",
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
