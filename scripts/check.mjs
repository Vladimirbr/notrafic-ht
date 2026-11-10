import { readFileSync } from "node:fs";
import { run } from "./process.mjs";

const uv = (args) =>
  run("uv", ["run", "--locked", "--directory", "backend", ...args]);
const pnpm = (args) => run("pnpm", args);
const testDatabase = process.env.TEST_DATABASE_URL;
if (!testDatabase)
  run("docker", ["compose", "up", "-d", "--wait", "postgres-test"]);

pnpm(["install", "--frozen-lockfile"]);
uv(["ruff", "check"]);
uv(["ruff", "format", "--check"]);
pnpm(["exec", "pyright", "-p", "backend"]);
pnpm(["lint:frontend"]);
pnpm(["exec", "prettier", "--check", "."]);
uv([
  "pytest",
  "--cov=app",
  "--cov-branch",
  "--cov-report=term-missing",
  "--cov-report=json:coverage.json",
]);
const { totals } = JSON.parse(readFileSync("backend/coverage.json", "utf8"));
for (const [label, covered, total] of [
  ["lines", totals.covered_lines, totals.num_statements],
  ["branches", totals.covered_branches, totals.num_branches],
]) {
  const percent = (covered / total) * 100;
  console.log(
    `Backend ${label} coverage ${percent.toFixed(2)}% (${covered}/${total})`,
  );
  if (!(percent >= 90))
    throw new Error(`Backend ${label} coverage must reach 90%`);
}
pnpm(["--filter", "@notraffic/frontend", "coverage"]);
pnpm(["--filter", "@notraffic/frontend", "build"]);
pnpm(["test:e2e"]);
uv(["pip-audit", "--local"]);
pnpm(["audit", "--audit-level", "low"]);
