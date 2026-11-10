import type { Page } from "@playwright/test";
import { draw, expect, imageReady, mockImage, test } from "./fixture";

function polygonResponse(page: Page, method: string) {
  return page.waitForResponse((response) => {
    const path = new URL(response.url()).pathname;
    return (
      path.startsWith("/api/polygons") && response.request().method() === method
    );
  });
}

test("the browser sees the default delay on list, create and delete", async ({
  page,
  context,
  api,
}) => {
  await api.restart("default");
  await mockImage(context);
  const list = polygonResponse(page, "GET");
  await page.goto("/");
  await imageReady(page);
  expect(
    (await fetch(`${api.url}/healthz`, { signal: AbortSignal.timeout(1500) }))
      .ok,
  ).toBe(true);
  const listed = await list;
  expect(listed.status()).toBe(200);
  expect(listed.request().timing().responseStart).toBeGreaterThanOrEqual(4900);

  await draw(page, "Timed polygon");
  const create = polygonResponse(page, "POST");
  await page.getByRole("button", { name: "Save polygon" }).click();
  const created = await create;
  expect(created.status()).toBe(201);
  expect(created.request().timing().responseStart).toBeGreaterThanOrEqual(4900);
  const remove = polygonResponse(page, "DELETE");
  await page.getByRole("button", { name: "Delete Timed polygon" }).click();
  const deleted = await remove;
  expect(deleted.status()).toBe(204);
  expect(deleted.request().timing().responseStart).toBeGreaterThanOrEqual(4900);
  await expect(page.getByText("No saved polygons yet.")).toBeVisible();
});
