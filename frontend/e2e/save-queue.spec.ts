import { randomUUID } from "node:crypto";
import type { Locator } from "@playwright/test";
import { canvas, draw, expect, imageReady, mockImage, test } from "./fixture";

async function position(locator: Locator) {
  return locator.evaluate((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return [x + window.scrollX, y + window.scrollY, width, height].map(
      Math.round,
    );
  });
}

for (const width of [320, 1920]) {
  test(`drains three saves without moving the active draft at ${String(width)} px`, async ({
    page,
    context,
    api,
    request,
  }) => {
    await mockImage(context);
    await page.setViewportSize({ width, height: 900 });
    const initial = width === 1920 ? 8 : 0;
    for (let index = 0; index < initial; index++) {
      const result = await request.post(`${api.url}/api/polygons`, {
        data: {
          name: `Existing lane ${String(index)}`,
          points: [
            [10, 10],
            [80, 10],
            [10, 80],
          ],
        },
      });
      expect(result.status()).toBe(201);
    }
    const first = Promise.withResolvers<undefined>();
    const names: string[] = [];
    await page.route("**/api/polygons", async (route) => {
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON() as { name: string };
        names.push(body.name);
        if (names.length === 1) await first.promise;
      }
      await route.continue();
    });

    try {
      await page.goto("/");
      await imageReady(page);
      await expect(page.locator("[data-polygon-id]")).toHaveCount(initial);
      const refresh = page.getByRole("button", { name: "Refresh list" });
      const queue = page.getByRole("button", { name: "Save queue" });
      const chrome = [canvas(page), refresh, queue];
      for (const name of ["First lane", "Second lane", "Third lane"]) {
        await draw(page, name);
        const beforeEnqueue = await Promise.all(chrome.map(position));
        await page.getByRole("button", { name: "Save polygon" }).click();
        await expect(
          page.getByRole("button", { name: "New polygon" }),
        ).toBeEnabled();
        expect(await Promise.all(chrome.map(position))).toEqual(beforeEnqueue);
      }
      await expect.poll(() => names).toEqual(["First lane"]);
      await draw(page, "Unsubmitted lane");
      const name = page.getByLabel("Polygon name");
      await expect(name).toBeFocused();
      const targets = [...chrome, name];
      if (initial)
        targets.push(
          page.getByRole("button", { name: "Delete Existing lane 0" }),
        );
      const before = await Promise.all(targets.map(position));
      const scroll = await page.evaluate(() => window.scrollY);

      first.resolve(undefined);
      await expect(page.getByText("0 · Empty")).toBeVisible();
      expect(names).toEqual(["First lane", "Second lane", "Third lane"]);
      expect(await Promise.all(targets.map(position))).toEqual(before);
      await expect(name).toHaveValue("Unsubmitted lane");
      await expect(name).toBeFocused();
      expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
      if (initial)
        await page.getByRole("button", { name: "Next page" }).click();
      await expect(
        page.getByRole("button", { name: "Delete Third lane" }),
      ).toBeVisible();
      expect((await fetch(`${api.url}/healthz`)).ok).toBe(true);
    } finally {
      first.resolve(undefined);
    }
  });
}

test("migrates and replays a legacy v1 submission with its existing key", async ({
  page,
  api,
  request,
}) => {
  const key = randomUUID();
  const body = {
    name: "Legacy lane",
    points: [
      [480, 270],
      [1440, 270],
      [960, 810],
    ],
  };
  await page.route("**/seed-workspace", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>Seed workspace</title>",
    }),
  );
  await page.goto("/seed-workspace");
  await page.evaluate(
    async ({ key, body }) => {
      const image =
        '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"/>';
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("notraffic", 1);
        open.onerror = () => {
          reject(open.error ?? new Error("Could not seed v1"));
        };
        open.onupgradeneeded = () => {
          const database = open.result;
          database.createObjectStore("workspace").put(
            {
              revision: 4,
              imageId: "legacy-image",
              draft: {
                id: "legacy-draft",
                phase: "submitted",
                ...body,
                submission: { key, body },
              },
            },
            "current",
          );
          database.createObjectStore("images").put(
            {
              bytes: new TextEncoder().encode(image).buffer,
              type: "image/svg+xml",
            },
            "legacy-image",
          );
        };
        open.onsuccess = () => {
          open.result.close();
          resolve();
        };
      });
    },
    { key, body },
  );
  const replay = page.waitForRequest(
    (outgoing) =>
      outgoing.method() === "POST" && outgoing.url().endsWith("/api/polygons"),
  );
  await page.goto("/");
  await imageReady(page);
  const outgoing = await replay;
  expect(outgoing.headers()["idempotency-key"]).toBe(key);
  expect(outgoing.postDataJSON()).toEqual(body);
  await expect(page.getByRole("button", { name: "New polygon" })).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Delete Legacy lane" }),
  ).toBeVisible();
  const stored = await request.get(`${api.url}/api/polygons`);
  expect(await stored.json()).toEqual([expect.objectContaining(body)]);
});

test("an open tab takes over a committed attempt when the sending tab closes", async ({
  page,
  context,
  api,
  request,
}) => {
  await mockImage(context);
  await page.goto("/");
  await imageReady(page);
  await expect(page.getByText("No saved polygons yet.")).toBeVisible();
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByText("No saved polygons yet.")).toBeVisible();

  const committed = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const keys: (string | undefined)[] = [];
  await context.route("**/api/polygons", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    keys.push(route.request().headers()["idempotency-key"]);
    if (keys.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      committed.resolve(undefined);
      await release.promise;
      await route.abort().catch(() => {});
    } else {
      await route.continue();
    }
  });

  try {
    await draw(page, "Handed off lane");
    await page.getByRole("button", { name: "Save polygon" }).click();
    await committed.promise;
    await expect(other.getByText("1 · Saving…")).toBeVisible();
    await expect
      .poll(async () =>
        other.evaluate(async () => {
          const { pending } = await navigator.locks.query();
          return pending?.some(({ name }) =>
            name?.startsWith("notraffic:polygon-delivery:"),
          );
        }),
      )
      .toBe(true);
    await page.close();
    release.resolve(undefined);
    await expect(
      other.getByRole("button", { name: "Delete Handed off lane" }),
    ).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const stored = await request.get(`${api.url}/api/polygons`);
    expect(await stored.json()).toHaveLength(1);
  } finally {
    release.resolve(undefined);
  }
});
