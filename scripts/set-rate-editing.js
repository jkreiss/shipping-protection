import process from "node:process";
import prisma from "../app/db.server.js";
import { setProtectionRateEditing } from "../app/merchant/rate-editing.server.js";
import { UserFacingError } from "../app/user-facing-error.js";

try {
  const [shopDomain, mode, ...extra] = process.argv.slice(2);
  if (extra.length || !shopDomain || !["locked", "editable"].includes(mode)) {
    throw new UserFacingError(
      "Usage: npm run merchant:rate-editing -- store.myshopify.com locked|editable",
    );
  }
  await setProtectionRateEditing(shopDomain, mode === "editable");
  console.log(
    `Protection rate editing for ${shopDomain}: ${mode}. The current rate is unchanged.`,
  );
} catch (error) {
  console.error(
    error instanceof UserFacingError
      ? error.message
      : "Unable to update rate-editing access. Check operator database access and migrations.",
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
