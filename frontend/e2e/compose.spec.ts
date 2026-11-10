import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { imageReady, mockImage } from "./fixture";

test("Compose recovers from a missing and recreated API and retains database data", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(240_000);
  const project = process.env.COMPOSE_SMOKE_PROJECT;
  if (!project || !/^notraffic-smoke-[a-f0-9]{10}$/.test(project)) {
    throw new Error("Run the isolated deployment smoke via pnpm test:compose.");
  }
  const cwd = resolve(import.meta.dirname, "../..");
  const env = { ...process.env, FRONTEND_PORT: "0", POSTGRES_PORT: "0" };
  // Explicit IPAM lets the test reserve the old address so it cannot pass on DNS reuse.
  const subnet = `10.219.${String(randomInt(1, 255))}.0/24`;
  const override = `networks:\n  default:\n    ipam:\n      config:\n        - subnet: ${subnet}\n`;
  const docker = (args: string[], input?: string) =>
    execFileSync("docker", args, {
      cwd,
      env,
      input,
      encoding: "utf8",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"],
    }).trim();
  const compose = (...args: string[]) =>
    docker(
      ["compose", "-p", project, "-f", "compose.yaml", "-f", "-", ...args],
      override,
    );
  const apiAddress = () => {
    const container = compose("ps", "-q", "api");
    return docker([
      "inspect",
      "-f",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      container,
    ]);
  };
  const holder = `${project}-old-api-address`;
  let holdingAddress = false;

  try {
    compose("up", "-d", "--build", "--wait", "--no-deps", "frontend");
    const base = `http://${compose("port", "frontend", "80")}`;
    expect(
      (
        await request.get(`${base}/api/polygons`, {
          headers: { Host: "unrelated.example" },
        })
      ).status(),
    ).toBe(400);
    expect((await request.get(base)).headers()["x-frame-options"]).toBe("DENY");
    await mockImage(context);
    await page.goto(base);
    await imageReady(page);
    await expect(
      page.getByText("The polygon list could not be loaded."),
    ).toBeVisible();
    expect((await request.get(`${base}/api/polygons`)).status()).toBe(502);

    compose("up", "-d", "--build", "--wait", "api");
    await expect
      .poll(async () => (await request.get(`${base}/healthz`)).status())
      .toBe(200);
    await page.getByRole("button", { name: "Retry list" }).click();
    await expect(page.getByText("No saved polygons yet.")).toBeVisible({
      timeout: 9000,
    });

    const firstAddress = apiAddress();
    expect(firstAddress).toMatch(/^10\.219\./);
    compose("rm", "-f", "-s", "api");
    docker([
      "run",
      "-d",
      "--rm",
      "--name",
      holder,
      "--network",
      `${project}_default`,
      "--ip",
      firstAddress,
      "--entrypoint",
      "sleep",
      "postgres:18.6-bookworm",
      "300",
    ]);
    holdingAddress = true;
    compose("up", "-d", "--wait", "--no-deps", "api");
    const secondAddress = apiAddress();
    expect(secondAddress).toMatch(/^10\.219\./);
    expect(secondAddress).not.toBe(firstAddress);
    console.log(
      `Compose API address changed from ${firstAddress} to ${secondAddress}.`,
    );
    await expect
      .poll(async () => (await request.get(`${base}/healthz`)).status())
      .toBe(200);
    await page.getByRole("button", { name: "Refresh list" }).click();
    await expect(
      page.getByRole("button", { name: "Refresh list" }),
    ).toBeEnabled({ timeout: 9000 });

    const endpoint = `${base}/api/polygons`;
    const points = [
      [100, 100],
      [400, 100],
      [200, 500],
    ];
    const live = {
      data: { name: "Volume polygon", points },
      headers: { "Idempotency-Key": randomUUID() },
    };
    const deleted = {
      data: { name: "Volume tombstone", points },
      headers: { "Idempotency-Key": randomUUID() },
    };
    const [liveResponse, deletedResponse] = await Promise.all([
      request.post(endpoint, live),
      request.post(endpoint, deleted),
    ]);
    expect(liveResponse.status()).toBe(201);
    expect(deletedResponse.status()).toBe(201);
    const stored: unknown = await liveResponse.json();
    const removed = (await deletedResponse.json()) as { id: number };
    expect(
      (await request.delete(`${endpoint}/${String(removed.id)}`)).status(),
    ).toBe(204);

    const oldDatabase = compose("ps", "-q", "postgres");
    compose("up", "-d", "--wait", "--no-deps", "--force-recreate", "postgres");
    expect(compose("ps", "-q", "postgres")).not.toBe(oldDatabase);
    await expect
      .poll(async () => (await request.get(`${base}/healthz`)).status())
      .toBe(200);

    const [listed, replay, tombstone] = await Promise.all([
      request.get(endpoint),
      request.post(endpoint, live),
      request.post(endpoint, deleted),
    ]);
    expect(listed.status()).toBe(200);
    expect(await listed.json()).toEqual([stored]);
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual(stored);
    expect(tombstone.status()).toBe(410);
    expect(await tombstone.json()).toMatchObject({
      error: { code: "idempotency_result_deleted" },
    });
    await page.getByRole("button", { name: "Refresh list" }).click();
    await expect(
      page.getByRole("button", { name: "Delete Volume polygon" }),
    ).toBeVisible({ timeout: 9000 });
  } finally {
    try {
      if (holdingAddress) docker(["rm", "-f", holder]);
    } finally {
      compose("down", "--volumes", "--rmi", "local", "--remove-orphans");
    }
  }
});
