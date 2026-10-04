import { createApi } from "./api";
import { connect } from "./db";
import { type Env, readEnv } from "./env";
import { createGitHub, runWorker } from "./worker";

export async function start(mode: "app" | "api" | "worker", supplied?: Env) {
  const env = supplied ?? (await readEnv());
  const { db, close } = connect(env.DATABASE_URL);
  const controller = new AbortController();
  const github = createGitHub(db, env);
  const server = Bun.serve({
    port:
      mode === "worker"
        ? Number(process.env.WARDEN_WORKER_HEALTH_PORT ?? 3001)
        : env.PORT,
    fetch: createApi(db, mode === "worker" ? undefined : github.webhooks).fetch,
  });
  const worker =
    mode === "api"
      ? Promise.resolve()
      : runWorker(db, github, env, controller.signal);
  let shutdown: Promise<void> | undefined;
  const stop = () =>
    (shutdown ??= (async () => {
      controller.abort();
      await server.stop();
      await worker;
      await close();
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    })());
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  console.log(`Warden ${mode} listening on ${server.port}`);
  return { port: server.port, stop };
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "app";
  if (mode !== "app" && mode !== "api" && mode !== "worker")
    throw new Error("Usage: bun run start [app|api|worker]");
  await start(mode);
}
