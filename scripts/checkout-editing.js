import prisma from "../app/db.server.js";
import { setProtectionEditing } from "../app/merchant/rate-editing.server.js";
import { UserFacingError } from "../app/user-facing-error.js";

export async function runEditingCommand({
  args,
  legacy = false,
  database = prisma,
  output = console.log,
  errorOutput = console.error,
}) {
  let status = 0;
  let message;
  const report = (error) =>
    errorOutput(
      error instanceof UserFacingError
        ? error.message
        : "Unable to update checkout editing access. Check operator database access and migrations.",
    );
  try {
    const [shopDomain, setting, mode, ...extra] = legacy
      ? [args[0], "pricing", ...args.slice(1)]
      : args;
    if (
      extra.length ||
      !shopDomain ||
      !["pricing", "copy"].includes(setting) ||
      !["locked", "editable"].includes(mode)
    ) {
      throw new UserFacingError(
        legacy
          ? "Usage: npm run merchant:rate-editing -- store.myshopify.com locked|editable"
          : "Usage: npm run merchant:checkout-editing -- store.myshopify.com pricing|copy locked|editable",
      );
    }
    await setProtectionEditing(shopDomain, setting, mode === "editable", {
      database,
    });
    message = `Checkout ${setting} editing for ${shopDomain}: ${mode}. Saved offer settings are unchanged.`;
  } catch (error) {
    status = 1;
    report(error);
  } finally {
    try {
      await database.$disconnect();
    } catch (error) {
      status = 1;
      report(error);
    }
  }
  if (status === 0) output(message);
  return status;
}
