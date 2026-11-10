import { expect, test } from "@playwright/test";
import { at, canvas, imageReady, mockImage, vertex } from "./fixture";

test.beforeEach(async ({ context, page }) => {
  await mockImage(context);
  await page.route("**/api/polygons", (route) => route.fulfill({ json: [] }));
  await page.goto("/");
  await imageReady(page);
});

test("finishes a triangle with one final point from a double-click", async ({
  page,
}) => {
  await vertex(page, 0.25, 0.25);
  await vertex(page, 0.75, 0.25);
  await canvas(page).scrollIntoViewIfNeeded();
  const last = await at(page, 0.5, 0.75);
  await page.mouse.dblclick(last.x, last.y);

  await expect(page.getByLabel("Polygon name")).toBeFocused();
  await expect(page.locator(".vertex-handle")).toHaveCount(3);
});

for (const handle of ["first", "last"] as const) {
  test(`keeps the name form focused after double-clicking the ${handle} handle`, async ({
    page,
  }) => {
    await vertex(page, 0.25, 0.25);
    await vertex(page, 0.75, 0.25);
    await vertex(page, 0.5, 0.75);
    const handles = page.locator(".vertex-handle");
    await handles[handle]().dblclick();

    await expect(page.getByLabel("Polygon name")).toBeFocused();
    await expect(handles).toHaveCount(3);
  });
}
