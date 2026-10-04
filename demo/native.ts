// Uses existing local PostgreSQL. This proves processes/HTTP, not container builds.
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (
  !url ||
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname) ||
  !/^\/warden_demo(?:_[a-z0-9_]+)?$/.test(new URL(url).pathname)
)
  throw new Error(
    "Native demo requires a fresh local warden_demo PostgreSQL database",
  );
const runtime = process.execPath;
const environment = {
  ...process.env,
  DATABASE_URL: url,
  WARDEN_DEMO: "true",
  WARDEN_APP_ID: "1",
  WARDEN_WEBHOOK_SECRET: "warden-local-webhook-secret",
  WARDEN_GITHUB_API_URL: "http://127.0.0.1:3810",
  WARDEN_API_URL: "http://127.0.0.1:3800",
  WARDEN_PRIVATE_KEY: "",
  WARDEN_PRIVATE_KEY_FILE: "",
  WARDEN_WORKER_POLL_MS: "100",
  WARDEN_JOB_LEASE_SECONDS: "10",
  WARDEN_WORKER_HEALTH_PORT: "3830",
};
const services: Bun.Subprocess[] = [];
function start(
  path: string,
  extra: Record<string, string> = {},
  mode?: "api" | "worker",
) {
  const process = Bun.spawn([runtime, "run", path, ...(mode ? [mode] : [])], {
    env: { ...environment, ...extra },
    stdout: Bun.file(join(tmpdir(), `warden-native-${mode ?? "github"}.log`)),
    stderr: "inherit",
  });
  services.push(process);
  return process;
}
async function run(path: string, args: string[] = []) {
  const child = Bun.spawn([runtime, "run", path, ...args], {
    env: environment,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${path} failed (${code})`);
}
async function ready(url: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`Not ready: ${url}`);
}
try {
  await run("build");
  await run("dist/db/migrate.js");
  start("demo/github.ts", { PORT: "3810" });
  await ready("http://127.0.0.1:3810/health");
  start("dist/app.js", { PORT: "3800" }, "api");
  await ready("http://127.0.0.1:3800/ready");
  let worker = start("dist/app.js", {}, "worker");
  await run("demo/run.ts");
  worker.kill("SIGTERM");
  await worker.exited;
  await run("demo/run.ts", ["prepare-restart"]);
  worker = start("dist/app.js", {}, "worker");
  await run("demo/run.ts", ["verify-restart"]);
} finally {
  for (const service of services) {
    if (service.exitCode === null) service.kill("SIGTERM");
  }
  await Promise.all(services.map((service) => service.exited));
}
