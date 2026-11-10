import {
  at,
  canvas,
  expect,
  imageReady,
  mockImage,
  test,
  vertex,
} from "./fixture";

test("starts on the scene, blocks a nearly flat draft, and saves by Enter", async ({
  page,
  context,
  api,
}) => {
  await mockImage(context);
  await page.goto("/");
  await imageReady(page);
  await expect(page.getByText("No saved polygons yet.")).toBeVisible();
  const scene = page.getByRole("region", { name: "Scene" });
  await expect(
    scene.getByRole("button", { name: "New polygon" }),
  ).toBeVisible();
  await vertex(page, 0.25, 0.25);
  await expect(scene.getByText("1 vertex", { exact: true })).toBeVisible();
  await vertex(page, 0.75, 0.25);
  await vertex(page, 0.5, 0.75);
  await expect(canvas(page)).toBeFocused();
  await page.keyboard.press("Enter");
  const name = scene.getByLabel("Polygon name");
  await expect(name).toBeFocused();
  await name.fill("Keyboard lane");

  await canvas(page).scrollIntoViewIfNeeded();
  const lower = await at(page, 0.5, 0.75);
  const upper = await at(page, 0.5, 0.25);
  await page.mouse.move(lower.x, lower.y);
  await page.mouse.down();
  await page.mouse.move(upper.x, upper.y + 1, { steps: 6 });
  await page.mouse.up();
  await expect(
    scene.getByRole("button", { name: "Save polygon" }),
  ).toBeDisabled();
  await expect(
    scene.getByText(
      "The shape needs visible area and edges that do not cross.",
    ),
  ).toBeVisible();

  const handle = page.locator(".vertex-handle").nth(2);
  await handle.scrollIntoViewIfNeeded();
  const handleBounds = await handle.boundingBox();
  if (!handleBounds) throw new Error("The vertex is hidden.");
  const restoredPoint = await at(page, 0.5, 0.75);
  await page.mouse.move(
    handleBounds.x + handleBounds.width / 2,
    handleBounds.y + handleBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(restoredPoint.x, restoredPoint.y, { steps: 6 });
  await page.mouse.up();
  await expect(
    scene.getByRole("button", { name: "Save polygon" }),
  ).toBeEnabled();
  await name.press("Enter");
  await expect(
    page.getByRole("button", { name: "Delete Keyboard lane" }),
  ).toBeVisible();
  expect((await fetch(`${api.url}/healthz`)).ok).toBe(true);
});

test("paginates the list and deletes only the focused selection", async ({
  page,
  context,
  api,
  request,
}) => {
  await mockImage(context);
  for (let n = 1; n <= 9; n++) {
    const response = await request.post(`${api.url}/api/polygons`, {
      data: {
        name: `Lane ${String(n)}`,
        points:
          n === 1
            ? [
                [150, 150],
                [650, 150],
                [150, 650],
              ]
            : [
                [960, 270],
                [1500, 270],
                [1000, 900],
              ],
      },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto("/");
  await imageReady(page);
  await expect(page.getByRole("listitem")).toHaveCount(8);
  await expect(page.getByText("1–8 of 9")).toBeVisible();
  const controls = page.getByRole("navigation", {
    name: "Saved polygon list controls",
  });
  for (const width of [1366, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const buttons = await Promise.all(
      ["Previous page", "Next page", "Refresh list"].map(async (name) => {
        const button = controls.getByRole("button", { name });
        await expect(button).toBeVisible();
        const bounds = await button.boundingBox();
        if (!bounds)
          throw new Error("Expected the list control to be visible.");
        return bounds;
      }),
    );
    expect(new Set(buttons.map(({ y }) => y)).size).toBe(1);
    expect(
      buttons.every(
        ({ x, width: buttonWidth }) => x >= 0 && x + buttonWidth <= width,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1366, height: 900 });
  await vertex(page, 0.15, 0.25);
  await expect(
    page.getByRole("button", { name: "Lane 1", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Selected: Lane 1")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText("Selected: Lane 1")).toHaveCount(0);

  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByText("9–9 of 9")).toBeVisible();
  const ninth = page.getByRole("button", { name: "Lane 9", exact: true });
  await ninth.click();
  await ninth.press("Delete");
  await expect(page.getByRole("listitem")).toHaveCount(8);
  await expect(
    page.getByRole("button", { name: "Lane 1", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Next page" })).toHaveCount(0);

  await vertex(page, 0.15, 0.25);
  await page.keyboard.press("Delete");
  await expect(
    page.getByRole("button", { name: "Lane 1", exact: true }),
  ).toHaveCount(0);
});

for (const viewport of [
  { width: 1366, height: 900 },
  { width: 320, height: 740 },
]) {
  test(`keeps the scene stationary through start, naming and save at ${String(viewport.width)} px`, async ({
    page,
    context,
    api,
  }) => {
    await mockImage(context);
    await page.setViewportSize(viewport);
    await page.goto("/");
    await imageReady(page);
    await expect(page.getByText("No saved polygons yet.")).toBeVisible();
    const surface = canvas(page);
    const scenePosition = () =>
      surface.evaluate((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x: x + window.scrollX, y: y + window.scrollY, width, height };
      });
    const original = await scenePosition();
    await page.getByRole("button", { name: "New polygon" }).click();
    expect(await scenePosition()).toEqual(original);
    await vertex(page, 0.25, 0.25);
    await vertex(page, 0.75, 0.25);
    await vertex(page, 0.5, 0.75);
    const beforeNaming = await page.evaluate(() => window.scrollY);
    await page.keyboard.press("Enter");
    const name = page.getByLabel("Polygon name");
    await expect(name).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(beforeNaming);
    expect(await scenePosition()).toEqual(original);
    await name.fill("Stable polygon");
    await expect(page.getByText("Draft saved in this browser.")).toBeVisible();
    expect(await scenePosition()).toEqual(original);

    const save = page.getByRole("button", { name: "Save polygon" });
    await save.scrollIntoViewIfNeeded();
    const beforeSave = await page.evaluate(() => window.scrollY);
    const release = Promise.withResolvers<undefined>();
    await page.route("**/api/polygons", async (route) => {
      if (route.request().method() === "POST") await release.promise;
      await route.continue();
    });
    try {
      await save.click();
      await expect(
        page.getByRole("button", { name: "New polygon" }),
      ).toBeEnabled();
      await expect(page.getByText("1 · Saving…")).toBeVisible();
      await expect(name).toHaveCount(0);
      expect(await page.evaluate(() => window.scrollY)).toBe(beforeSave);
      expect(await scenePosition()).toEqual(original);
    } finally {
      release.resolve(undefined);
    }
    await expect(
      page.getByRole("button", { name: "Delete Stable polygon" }),
    ).toBeVisible();
    expect(await scenePosition()).toEqual(original);
    expect(await page.evaluate(() => window.scrollY)).toBe(beforeSave);
    expect((await fetch(`${api.url}/healthz`)).ok).toBe(true);
  });
}

test("brings the name field into view when the scene fills a short viewport", async ({
  page,
  context,
  api,
}) => {
  await mockImage(context);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto("/");
  await imageReady(page);
  await expect(page.getByText("No saved polygons yet.")).toBeVisible();
  await vertex(page, 0.25, 0.2);
  await vertex(page, 0.75, 0.2);
  await vertex(page, 0.5, 0.65);
  await expect(canvas(page)).toBeFocused();
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.keyboard.press("Enter");
  const name = page.getByLabel("Polygon name");
  await expect(name).toBeFocused();
  await expect(name).toBeInViewport({ ratio: 1 });
  expect((await fetch(`${api.url}/healthz`)).ok).toBe(true);
});
