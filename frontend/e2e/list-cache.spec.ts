import { canvas, expect, imageReady, mockImage, test } from "./fixture";

for (const width of [320, 1920]) {
  test(`keeps cached polygons visible and list controls stable during refresh at ${String(width)} px`, async ({
    page,
    context,
    api,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockImage(context);
    const endpoint = `${api.url}/api/polygons`;
    const creation = await request.post(endpoint, {
      data: {
        name: "Cached lane",
        points: [
          [100, 100],
          [400, 100],
          [180, 400],
        ],
      },
    });
    expect(creation.status()).toBe(201);
    const { id } = (await creation.json()) as { id: number };
    await page.goto("/");
    await imageReady(page);
    const remove = page.getByRole("button", { name: "Delete Cached lane" });
    await expect(remove).toBeEnabled();
    const refresh = page.getByRole("button", { name: "Refresh list" });
    const controlPosition = await refresh.boundingBox();
    const rowPosition = await remove.boundingBox();
    expect(controlPosition).not.toBeNull();
    expect(rowPosition).not.toBeNull();
    expect((await request.delete(`${endpoint}/${String(id)}`)).status()).toBe(
      204,
    );

    const firstRead = Promise.withResolvers<undefined>();
    let failRefresh = true;
    await page.route("**/api/polygons", async (route) => {
      if (route.request().method() === "GET" && failRefresh) {
        await firstRead.promise;
        await route.fulfill({ status: 502, body: "Temporary proxy failure" });
        return;
      }
      await route.continue();
    });

    try {
      await page.reload();
      await imageReady(page);
      await expect(
        page.getByText("Checking for updates. Showing the local copy."),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Cached lane", exact: true }),
      ).toBeVisible();
      await expect(canvas(page)).toHaveAttribute(
        "aria-description",
        "1 saved polygons",
      );
      await expect(remove).toBeDisabled();
      expect(await refresh.boundingBox()).toEqual(controlPosition);
      const during = await remove.boundingBox();
      expect(during?.y).toBeCloseTo(rowPosition?.y ?? 0, 0);
    } finally {
      firstRead.resolve(undefined);
    }
    await expect(
      page.getByText("Refresh failed. Showing the local copy."),
    ).toBeVisible();
    await expect(remove).toBeDisabled();
    failRefresh = false;
    const retry = page.getByRole("button", { name: "Retry list" });
    expect(await retry.boundingBox()).toEqual(controlPosition);
    await retry.click();
    await expect(page.getByText("No saved polygons yet.")).toBeVisible();
    expect(await refresh.boundingBox()).toEqual(controlPosition);
    await expect(canvas(page)).toHaveAttribute(
      "aria-description",
      "0 saved polygons",
    );
  });
}
