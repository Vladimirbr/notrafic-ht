import { randomBytes } from "node:crypto";
import { run } from "./process.mjs";

const project = `notraffic-smoke-${randomBytes(5).toString("hex")}`;
run(
  "pnpm",
  ["--filter", "@notraffic/frontend", "e2e", "--project", "compose"],
  {
    env: { ...process.env, COMPOSE_SMOKE_PROJECT: project },
  },
);
