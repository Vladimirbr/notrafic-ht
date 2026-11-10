import AxeBuilder from "@axe-core/playwright";
import {
  at,
  canvas,
  expect,
  imageReady,
  mockImage,
  test,
  vertex,
} from "./fixture";

test.describe("touch input", () => {
  test.use({
    viewport: { width: 390, height: 460 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });

  test("a tap adds one vertex and a vertical gesture scrolls without adding one", async ({
    page,
    context,
    api,
  }) => {
    await mockImage(context);
    await page.goto("/");
    await imageReady(page);
    await expect(page.getByText("No saved polygons yet.")).toBeVisible();
    await page.getByRole("button", { name: "New polygon" }).tap();
    await canvas(page).scrollIntoViewIfNeeded();
    const p = await at(page, 0.3, 0.55);
    await page.touchscreen.tap(p.x, p.y);
    await expect(page.getByText("1 vertex", { exact: true })).toBeVisible();

    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    const start = await at(page, 0.5, 0.83);
    const before = await page.evaluate(() => window.scrollY);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [start],
    });
    for (const dy of [15, 40, 70, 110]) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: start.x, y: start.y - dy }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });

    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(before);
    await expect(page.getByText("1 vertex", { exact: true })).toBeVisible();

    await canvas(page).scrollIntoViewIfNeeded();
    const canceled = await at(page, 0.4, 0.4);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [canceled],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    });
    await expect(page.getByText("1 vertex", { exact: true })).toBeVisible();
    const first = { ...(await at(page, 0.3, 0.4)), id: 0 };
    const sameCanvas = (await at(page, 0.7, 0.4)).x;
    for (const x of [sameCanvas, 2]) {
      const second = { x, y: first.y, id: 1 };
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [first],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [first, second],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await expect(page.getByText("1 vertex", { exact: true })).toBeVisible();
    }
    expect((await fetch(`${api.url}/healthz`)).ok).toBe(true);
  });
  test("drags a vertex by touch, restores a canceled drag, and taps the first vertex to close", async ({
    page,
    context,
    api,
  }) => {
    await mockImage(context);
    await page.goto("/");
    await imageReady(page);
    await expect(page.getByText("No saved polygons yet.")).toBeVisible();
    await page.getByRole("button", { name: "New polygon" }).tap();
    await canvas(page).scrollIntoViewIfNeeded();
    for (const [x, y] of [
      [0.25, 0.3],
      [0.75, 0.3],
      [0.5, 0.75],
    ] as const) {
      const point = await at(page, x, y);
      await page.touchscreen.tap(point.x, point.y);
    }
    await expect(page.getByText("3 vertices")).toBeVisible();
    const cdp = await context.newCDPSession(page);
    const handle = page.locator(".vertex-handle").nth(1);
    const initial = await handle.boundingBox();
    if (!initial) throw new Error("The vertex is hidden.");
    const start = {
      x: initial.x + initial.width / 2,
      y: initial.y + initial.height / 2,
    };
    const moved = { x: start.x + 25, y: start.y + 15 };
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [start],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [moved],
    });
    await expect
      .poll(async () => (await handle.boundingBox())?.x)
      .toBeGreaterThan(initial.x + 15);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    });
    await expect
      .poll(async () => (await handle.boundingBox())?.x)
      .toBeCloseTo(initial.x);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [start],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [moved],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect
      .poll(async () => (await handle.boundingBox())?.x)
      .toBeGreaterThan(initial.x + 15);
    const first = await at(page, 0.25, 0.3);
    await page.touchscreen.tap(first.x, first.y);
    await expect(page.getByLabel("Polygon name")).toBeVisible();
    await expect(page.getByText("3 vertices")).toBeVisible();
    expect((await fetch(`${api.url}/healthz`)).ok).toBe(true);
  });
});

test("the responsive layout keeps the scene and controls usable", async ({
  page,
  context,
  api,
}) => {
  await mockImage(context);
  await page.goto("/");
  await imageReady(page);
  await expect(page.getByText("No saved polygons yet.")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "New polygon" })).toBeFocused();
  await page.keyboard.press("Enter");
  await vertex(page, 0.2, 0.2);
  await vertex(page, 0.8, 0.2);

  for (const viewport of [
    { width: 320, height: 550 },
    { width: 390, height: 375 },
    { width: 768, height: 390 },
    { width: 1440, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(async () => {
        const bounds = await canvas(page).boundingBox();
        return bounds ? bounds.width / bounds.height : 0;
      })
      .toBeCloseTo(16 / 9, 2);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width);
    await expect(page.getByText("2 vertices")).toBeVisible();
    const finish = await page
      .getByRole("button", { name: "Finish shape" })
      .boundingBox();
    expect(finish?.height).toBeGreaterThanOrEqual(44);
  }

  await vertex(page, 0.5, 0.8);
  await page.getByRole("button", { name: "Finish shape" }).click();
  await page.getByLabel("Polygon name").fill("Accessible lane");
  const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
  expect(
    (await new AxeBuilder({ page }).withTags(tags).analyze()).violations,
  ).toEqual([]);
  await page.getByRole("button", { name: "Save polygon" }).click();
  await expect(
    page.getByRole("button", { name: "Delete Accessible lane" }),
  ).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(tags).analyze()).violations,
  ).toEqual([]);
  expect((await fetch(`${api.url}/healthz`)).ok).toBe(true);
});
