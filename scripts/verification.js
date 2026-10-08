import process from "node:process";

// Preserve the primary failure while attempting every independent cleanup.
export async function runVerification({
  database,
  verify,
  cleanup = [],
  env = process.env,
}) {
  let primary;
  const failures = [];
  let ready = false;
  try {
    if (env.VERIFY_ISOLATED_DB !== "1") {
      throw new Error(
        "Set VERIFY_ISOLATED_DB=1 only for an isolated disposable test database.",
      );
    }
    if ((await database.shop.count()) !== 0) {
      throw new Error(
        "Verification requires an empty Shop table in a disposable database.",
      );
    }
    ready = true;
    await verify();
  } catch (error) {
    primary = error;
  } finally {
    // A refused preflight must never run fixture cleanup against unrelated data.
    if (ready) {
      for (const clean of cleanup) {
        try {
          await clean();
        } catch (error) {
          failures.push(error);
        }
      }
    }
    try {
      await database.$disconnect();
    } catch (error) {
      failures.push(error);
    }
  }
  if (primary && failures.length) {
    throw new AggregateError(
      [primary, ...failures],
      "Verification and cleanup failed.",
      { cause: primary },
    );
  }
  if (primary) throw primary;
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, "Verification cleanup failed.");
}

// A failed transaction may never signal its barrier. Race its outcome as well
// as a deadline so the caller can release other transactions and clean up.
export async function waitForVerificationBarrier(
  barrier,
  operation,
  { label = "Verification barrier", timeoutMs = 5000 } = {},
) {
  let timer;
  try {
    return await Promise.race([
      barrier,
      operation.then(() => {
        throw new Error(
          `${label}: operation completed before reaching the barrier.`,
        );
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`${label}: timed out waiting for the barrier.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
