import { expect, imageReady, PICSUM, test } from "./fixture";

test("loads the supplied live Picsum scene", async ({ page, api }) => {
  const response = page.waitForResponse((event) => event.url() === PICSUM);
  await page.goto("/");
  expect((await response).status()).toBeGreaterThanOrEqual(200);
  await imageReady(page);
  await expect(page.getByRole("button", { name: "New polygon" })).toBeEnabled();
  expect((await fetch(`${api.url}/healthz`)).ok).toBe(true);
});
