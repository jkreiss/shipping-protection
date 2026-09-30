const ATTEMPTS = 3;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Serializable transactions can abort when concurrent work on the same shop
// overlaps (Prisma P2034). The transaction rolled back, so rerunning it is
// safe; do so a few times with a short jittered pause before giving up.
export async function retrySerializationFailures(run, { sleep = defaultSleep } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (error?.code !== "P2034" || attempt >= ATTEMPTS) throw error;
      await sleep(25 * attempt + Math.floor(Math.random() * 50));
    }
  }
}
