import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import {
  expect,
  test as base,
  type BrowserContext,
  type Page,
} from "@playwright/test";

export const PICSUM = "https://picsum.photos/1920/1080";

export async function mockImage(context: BrowserContext, color = "#2f5366") {
  await context.route(PICSUM, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="${color}"/></svg>`,
    }),
  );
}

export class ApiProcess {
  readonly url: string;
  private child: ChildProcess | undefined;

  constructor(private readonly port = process.env.E2E_API_PORT ?? "58000") {
    this.url = `http://127.0.0.1:${port}`;
  }

  async start(delay: number | "default" = 0.04) {
    const database = process.env.E2E_DATABASE_URL;
    if (!database) {
      throw new Error(
        "Start E2E via pnpm test:e2e with a disposable _browser_test database.",
      );
    }
    const backend = resolve(import.meta.dirname, "../../backend");
    const python = resolve(
      backend,
      process.platform === "win32"
        ? ".venv/Scripts/python.exe"
        : ".venv/bin/python",
    );
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: database };
    execFileSync(python, ["-m", "tests.guard_e2e_database"], {
      cwd: backend,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    delete env.CRUD_DELAY_SECONDS;
    if (delay !== "default")
      Object.assign(env, { CRUD_DELAY_SECONDS: String(delay) });
    const child = spawn(
      python,
      [
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        this.port,
      ],
      {
        cwd: backend,
        env,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    this.child = child;
    let output = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      output = (output + chunk).slice(-4000);
    });
    child.on("error", (error) => {
      output += error.message;
    });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        // Uvicorn only emits this for the child after it successfully binds.
        if (
          output.includes(`Uvicorn running on ${this.url}`) &&
          (
            await fetch(`${this.url}/healthz`, {
              signal: AbortSignal.timeout(500),
            })
          ).ok
        )
          return;
      } catch {
        // The process has not opened its socket yet.
      }
      await setTimeout(50);
    }
    throw new Error(`Uvicorn did not become healthy. ${output}`);
  }

  async stop() {
    const child = this.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
      return;
    const done = once(child, "exit");
    child.kill("SIGTERM");
    await done;
  }

  async restart(delay: number | "default" = 0.04) {
    await this.stop();
    await this.start(delay);
  }

  async clear() {
    const response = await fetch(`${this.url}/api/polygons`);
    const polygons = (await response.json()) as { id: number }[];
    for (const { id } of polygons) {
      const removed = await fetch(`${this.url}/api/polygons/${String(id)}`, {
        method: "DELETE",
      });
      if (removed.status !== 204)
        throw new Error(`Could not reset test polygon ${String(id)}.`);
    }
  }
}

export const test = base.extend<{ api: ApiProcess }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright inspects the destructured fixture dependencies.
  api: async ({}, serveApi) => {
    const api = new ApiProcess();
    try {
      await api.start();
      await api.clear();
      await serveApi(api);
    } finally {
      await api.stop();
    }
  },
});

export function canvas(page: Page) {
  return page.getByRole("img", { name: "Polygon drawing canvas" });
}

export async function at(page: Page, x: number, y: number) {
  const bounds = await canvas(page).boundingBox();
  if (!bounds) throw new Error("The drawing canvas is hidden.");
  return { x: bounds.x + x * bounds.width, y: bounds.y + y * bounds.height };
}

export async function vertex(page: Page, x: number, y: number) {
  await canvas(page).scrollIntoViewIfNeeded();
  const point = await at(page, x, y);
  await page.mouse.click(point.x, point.y);
}

export async function draw(page: Page, name: string) {
  await page.getByRole("button", { name: "New polygon" }).click();
  await vertex(page, 0.25, 0.25);
  await vertex(page, 0.75, 0.25);
  await vertex(page, 0.5, 0.75);
  await page.getByRole("button", { name: "Finish shape" }).click();
  await page.getByLabel("Polygon name").fill(name);
}

export async function imageReady(page: Page) {
  await expect(page.locator(".canvas-surface canvas").first()).toBeVisible();
}

export { expect };
