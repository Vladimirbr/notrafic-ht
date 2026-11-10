import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_FRONTEND_PORT ?? 55173);
const apiPort = Number(process.env.E2E_API_PORT ?? 58000);
const composeSmoke = Boolean(process.env.COMPOSE_SMOKE_PROJECT);
const livePicsum = Boolean(process.env.LIVE_PICSUM);
const baseURL = `http://127.0.0.1:${String(port)}`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: composeSmoke
    ? "test-results/compose"
    : livePicsum
      ? "test-results/live"
      : "test-results/native",
  workers: 1,
  timeout: 45_000,
  use: { baseURL, trace: "retain-on-failure" },
  webServer: composeSmoke
    ? undefined
    : {
        command: `pnpm dev --host 127.0.0.1 --port ${String(port)} --strictPort`,
        url: baseURL,
        env: { API_PROXY_TARGET: `http://127.0.0.1:${String(apiPort)}` },
      },
  projects: composeSmoke
    ? [
        {
          name: "compose",
          testMatch: "compose.spec.ts",
          use: { ...devices["Desktop Chrome"] },
        },
      ]
    : livePicsum
      ? [
          {
            name: "live",
            testMatch: "live.spec.ts",
            use: { ...devices["Desktop Chrome"] },
          },
        ]
      : [
          {
            name: "chromium",
            testIgnore: ["live.spec.ts", "compose.spec.ts"],
            use: { ...devices["Desktop Chrome"] },
          },
          {
            name: "firefox",
            testMatch: [
              "smoke.spec.ts",
              "double-click.spec.ts",
              "save-queue.spec.ts",
            ],
            use: { ...devices["Desktop Firefox"] },
          },
          {
            name: "webkit",
            testMatch: [
              "smoke.spec.ts",
              "double-click.spec.ts",
              "save-queue.spec.ts",
            ],
            use: { ...devices["Desktop Safari"] },
          },
        ],
});
