import { run } from "./process.mjs";

const port = process.env.TEST_POSTGRES_PORT ?? "55433";
const args = process.argv.slice(2);
const live = args[0] === "--live-image";
if (!process.env.E2E_DATABASE_URL) {
  run("docker", ["compose", "up", "-d", "--wait", "postgres-test"]);
  run(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres-test",
      "psql",
      "-U",
      "notraffic",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    {
      input:
        "SELECT 'CREATE DATABASE notraffic_browser_test' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'notraffic_browser_test')\\gexec\n",
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
}

const env = {
  ...process.env,
  E2E_DATABASE_URL:
    process.env.E2E_DATABASE_URL ??
    `postgresql+psycopg://notraffic:notraffic-local@127.0.0.1:${port}/notraffic_browser_test`,
  ...(live ? { LIVE_PICSUM: "1" } : {}),
};
run(
  "uv",
  [
    "run",
    "--locked",
    "--directory",
    "backend",
    "python",
    "-m",
    "tests.guard_e2e_database",
  ],
  { env },
);

run(
  "uv",
  ["run", "--locked", "--directory", "backend", "alembic", "upgrade", "head"],
  {
    env: { ...env, DATABASE_URL: env.E2E_DATABASE_URL },
  },
);
run(
  "pnpm",
  [
    "--filter",
    "@notraffic/frontend",
    "e2e",
    ...(live ? ["--project", "live", ...args.slice(1)] : args),
  ],
  { env },
);
