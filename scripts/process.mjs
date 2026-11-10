import { spawn, spawnSync } from "node:child_process";

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? result.signal})`,
    );
}

export function start(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  return { child, done };
}
