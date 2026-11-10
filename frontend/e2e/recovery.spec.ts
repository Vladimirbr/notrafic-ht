import { canvas, draw, expect, imageReady, mockImage, test } from "./fixture";

for (const initialListFails of [false, true]) {
  test(`replays a committed save after a lost response and API restart (initial GET failure: ${initialListFails ? "fails" : "succeeds"})`, async ({
    page,
    context,
    api,
    request,
  }) => {
    await mockImage(context);
    await page.goto("/");
    await imageReady(page);
    await expect(page.getByText("No saved polygons yet.")).toBeVisible();
    await draw(page, "Recovered lane");

    let firstKey: string | undefined;
    let firstBody: string | null;
    let createdId: number | undefined;
    let rejectList = false;
    await page.route("**/api/polygons", async (route) => {
      const outgoing = route.request();
      if (outgoing.method() === "GET" && rejectList) {
        await route.fulfill({ status: 502, body: "Proxy unavailable" });
      } else if (outgoing.method() === "POST" && !firstKey) {
        firstKey = outgoing.headers()["idempotency-key"];
        firstBody = outgoing.postData();
        const committed = await route.fetch();
        expect(committed.status()).toBe(201);
        const polygon = (await committed.json()) as { id: number };
        createdId = polygon.id;
        await route.abort("connectionreset");
      } else {
        if (outgoing.method() === "POST") {
          expect(outgoing.headers()["idempotency-key"]).toBe(firstKey);
          expect(outgoing.postData()).toBe(firstBody);
        }
        await route.continue();
      }
    });

    await page.getByRole("button", { name: "Save polygon" }).click();
    await expect(page.getByText("1 · Retrying")).toBeVisible();
    expect(firstKey).toMatch(/^[a-f\d-]{36}$/i);
    await api.restart();
    rejectList = initialListFails;
    const replay = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/polygons") &&
        response.request().method() === "POST",
    );
    await page.reload();
    const response = await replay;
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ id: createdId });
    await expect(page.getByRole("listitem")).toHaveCount(1);
    await expect(page.getByRole("listitem")).toHaveAttribute(
      "data-polygon-id",
      String(createdId),
    );
    await expect(canvas(page)).toHaveAttribute(
      "aria-description",
      "1 saved polygons",
    );
    const stored = await request.get(`${api.url}/api/polygons`);
    expect(await stored.json()).toEqual([await response.json()]);

    if (initialListFails) {
      await expect(
        page.getByText("Refresh failed. Showing the local copy."),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Delete Recovered lane" }),
      ).toBeDisabled();
      rejectList = false;
      await page.getByRole("button", { name: "Retry list" }).click();
      await expect(
        page.getByRole("button", { name: "Delete Recovered lane" }),
      ).toBeEnabled();
      await expect(page.getByRole("listitem")).toHaveCount(1);
    }
  });
}

test("a stale tab cannot send a second creation for the shared draft", async ({
  page,
  context,
  api,
  request,
}) => {
  await mockImage(context);
  await page.goto("/");
  await imageReady(page);
  await expect(page.getByText("No saved polygons yet.")).toBeVisible();
  await draw(page, "Shared lane");
  await expect(page.getByText("Draft saved in this browser.")).toBeVisible();
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByLabel("Polygon name")).toHaveValue("Shared lane");
  await expect(
    other.getByRole("button", { name: "Save polygon" }),
  ).toBeEnabled();

  const started = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let posts = 0;
  await context.route("**/api/polygons", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    posts++;
    started.resolve(undefined);
    await release.promise;
    await route.continue();
  });

  try {
    await page.getByRole("button", { name: "Save polygon" }).click();
    await started.promise;
    await other.getByRole("button", { name: "Save polygon" }).click();
    await expect(
      other.getByRole("button", { name: "Reload workspace" }),
    ).toBeVisible();
    expect(posts).toBe(1);
  } finally {
    release.resolve(undefined);
  }
  await expect(page.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "New polygon" })).toBeEnabled();
  await other.getByRole("button", { name: "Reload workspace" }).click();
  await expect(
    other.getByRole("button", { name: "New polygon" }),
  ).toBeEnabled();
  await other.getByRole("button", { name: "Refresh list" }).click();
  await expect(other.getByRole("listitem")).toHaveCount(1);
  const collection = await request.get(`${api.url}/api/polygons`);
  expect(await collection.json()).toHaveLength(1);
});
