import { run, start } from "./process.mjs";

const apiPort = process.env.API_PORT ?? "8000";
const frontPort = process.env.FRONTEND_PORT ?? "5173";
const postgresPort = process.env.POSTGRES_PORT ?? "55432";
const env = {
  ...process.env,
  DATABASE_URL:
    process.env.DATABASE_URL ??
    `postgresql+psycopg://notraffic:notraffic-local@127.0.0.1:${postgresPort}/notraffic`,
};
if (!process.env.DATABASE_URL)
  run("docker", ["compose", "up", "-d", "--wait", "postgres"]);
run(
  "uv",
  ["run", "--locked", "--directory", "backend", "alembic", "upgrade", "head"],
  { env },
);

const services = [
  start(
    "uv",
    [
      "run",
      "--locked",
      "--directory",
      "backend",
      "uvicorn",
      "app.main:app",
      "--reload",
      "--host",
      "127.0.0.1",
      "--port",
      apiPort,
    ],
    { env },
  ),
  start(
    "pnpm",
    [
      "--filter",
      "@notraffic/frontend",
      "dev",
      "--port",
      frontPort,
      "--strictPort",
    ],
    {
      env: { ...env, API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
    },
  ),
];
function stop() {
  for (const { child } of services) child.kill("SIGTERM");
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  process.exitCode =
    (await Promise.race(services.map(({ done }) => done))) ?? 0;
} finally {
  stop();
  await Promise.allSettled(services.map(({ done }) => done));
}
