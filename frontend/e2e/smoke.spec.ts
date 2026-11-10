import { once } from "node:events";
import { createServer } from "node:http";
import {
  ApiProcess,
  canvas,
  draw,
  expect,
  imageReady,
  mockImage,
  PICSUM,
  test,
  vertex,
} from "./fixture";

test("does not use an existing API when the test port is occupied", async () => {
  let requests = 0;
  const existing = createServer((_request, response) => {
    requests++;
    response.writeHead(200).end('{"status":"ok"}');
  });
  existing.listen(0, "127.0.0.1");
  await once(existing, "listening");
  const address = existing.address();
  if (!address || typeof address === "string") {
    existing.close();
    throw new Error("Expected a TCP test listener");
  }
  const api = new ApiProcess(String(address.port));
  try {
    await expect(api.start()).rejects.toThrow(/address already in use/i);
    expect(requests).toBe(0);
  } finally {
    await api.stop();
    existing.close();
  }
});

test("draws, restores and removes a named polygon on the real canvas", async ({
  page,
  context,
  api,
  request,
}) => {
  await mockImage(context);
  const imageRequest = page.waitForRequest(PICSUM);
  await page.goto("/");
  await imageRequest;
  await imageReady(page);
  await expect(page.getByText("No saved polygons yet.")).toBeVisible();

  await page.getByRole("button", { name: "New polygon" }).click();
  await vertex(page, 0.25, 0.25);
  await vertex(page, 0.75, 0.25);
  await page.getByRole("button", { name: "Undo point" }).click();
  await expect(page.getByText("1 vertex", { exact: true })).toBeVisible();
  await expect(page.getByText("Draft saved in this browser.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("1 vertex", { exact: true })).toBeVisible();
  await imageReady(page);
  await vertex(page, 0.75, 0.25);
  await vertex(page, 0.5, 0.75);
  await page.getByRole("button", { name: "Finish shape" }).click();
  await page.getByLabel("Polygon name").fill("Lane A");
  await page.getByRole("button", { name: "Back to drawing" }).click();
  await page.getByRole("button", { name: "Finish shape" }).click();
  await expect(page.getByLabel("Polygon name")).toHaveValue("Lane A");

  await expect(page.getByText("Draft saved in this browser.")).toBeVisible();
  await context.route(PICSUM, (route) => route.abort());
  await page.reload();
  await imageReady(page);
  await expect(page.getByLabel("Polygon name")).toHaveValue("Lane A");
  await page.getByRole("button", { name: "Save polygon" }).click();
  const row = page.getByRole("listitem").filter({ hasText: "Lane A" });
  await expect(row).toHaveCount(1);
  await expect(canvas(page)).toHaveAttribute(
    "aria-description",
    "1 saved polygons",
  );
  const id = Number(await row.getAttribute("data-polygon-id"));
  const response = await request.get(`${api.url}/api/polygons`);
  const saved = (await response.json()) as {
    id: number;
    name: string;
    points: [number, number][];
  }[];
  expect(saved.map((polygon) => [polygon.id, polygon.name])).toEqual([
    [id, "Lane A"],
  ]);
  const expected = [
    [480, 270],
    [1440, 270],
    [960, 810],
  ];
  saved[0]?.points.forEach(([x, y], index) => {
    expect(Math.abs(x - (expected[index]?.[0] ?? 0))).toBeLessThan(5);
    expect(Math.abs(y - (expected[index]?.[1] ?? 0))).toBeLessThan(5);
  });

  await page.reload();
  await expect(row).toHaveCount(1);
  await imageReady(page);
  await draw(page, "Unsaved");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "New polygon" })).toBeEnabled();
  await expect(page.getByRole("listitem")).toHaveCount(1);
  await page.getByRole("button", { name: "Delete Lane A" }).click();
  await expect(page.getByText("No saved polygons yet.")).toBeVisible();
  await expect(canvas(page)).toHaveAttribute(
    "aria-description",
    "0 saved polygons",
  );
});

test("closes the contour at its first vertex and saves adjusted draft points", async ({
  page,
  context,
  api,
  request,
}) => {
  await mockImage(context);
  await page.goto("/");
  await imageReady(page);
  await expect(
    page.getByText("Click or tap empty space to start."),
  ).toBeVisible();
  await page.getByRole("button", { name: "New polygon" }).click();
  await expect(
    page.getByText("Click or tap the image to add a vertex.", { exact: false }),
  ).toBeVisible();
  await vertex(page, 0.25, 0.25);
  await vertex(page, 0.25, 0.25);
  await expect(page.getByText("1 vertex", { exact: true })).toBeVisible();
  await vertex(page, 0.75, 0.25);
  await vertex(page, 0.5, 0.75);

  async function drag(from: [number, number], to: [number, number]) {
    await canvas(page).scrollIntoViewIfNeeded();
    const bounds = await canvas(page).boundingBox();
    if (!bounds) throw new Error("The canvas is hidden.");
    await page.mouse.move(
      bounds.x + from[0] * bounds.width,
      bounds.y + from[1] * bounds.height,
    );
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + to[0] * bounds.width,
      bounds.y + to[1] * bounds.height,
      { steps: 5 },
    );
    await page.mouse.up();
  }
  await drag([0.75, 0.25], [0.8, 0.3]);
  await expect(page.getByText("3 vertices", { exact: true })).toBeVisible();
  await vertex(page, 0.25, 0.25);
  await expect(page.getByLabel("Polygon name")).toBeVisible();
  await page.getByLabel("Polygon name").fill("Adjusted lane");
  await drag([0.5, 0.75], [0.6, 0.8]);
  await expect(page.getByText("Draft saved in this browser.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Polygon name")).toHaveValue("Adjusted lane");
  await page.getByRole("button", { name: "Save polygon" }).click();
  await expect(
    page.getByRole("button", { name: "Delete Adjusted lane" }),
  ).toBeVisible();
  const response = await request.get(`${api.url}/api/polygons`);
  const saved = (await response.json()) as { points: [number, number][] }[];
  expect(saved).toHaveLength(1);
  const points = saved[0]?.points ?? [];
  expect(points).toHaveLength(3);
  const expected = [
    [480, 270],
    [1536, 324],
    [1152, 864],
  ];
  points.forEach(([x, y], index) => {
    expect(Math.abs(x - (expected[index]?.[0] ?? 0))).toBeLessThan(5);
    expect(Math.abs(y - (expected[index]?.[1] ?? 0))).toBeLessThan(5);
  });
});
