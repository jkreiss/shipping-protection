import { test, expect } from "./support/fixtures.js";

test("merchant pages load and a rate change survives refresh", async ({
  staging,
}) => {
  await staging.merchant.overview(true);
  await staging.merchant.settings();
  await staging.merchant.setRate("1");
  await staging.merchant.settings();
  expect(await staging.merchant.rate()).toBe("1");
  const before = await staging.database.activeRule();
  await staging.merchant.invalidRate();
  expect((await staging.database.activeRule()).id).toBe(before.id);
  expect(await staging.merchant.rate()).toBe("1");
});
