import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  WARDEN_WEBHOOK_SECRET: z.string().min(16),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WARDEN_APP_ID: z.coerce.number().int().positive(),
  WARDEN_PRIVATE_KEY: z.string().optional(),
  WARDEN_PRIVATE_KEY_FILE: z.string().optional(),
  WARDEN_GITHUB_API_URL: z.url().default("https://api.github.com"),
  WARDEN_DEMO: z.enum(["true", "false"]).default("false"),
  WARDEN_JOB_LEASE_SECONDS: z.coerce.number().int().min(5).max(600).default(60),
  WARDEN_WORKER_POLL_MS: z.coerce.number().int().min(50).default(1000),
});
export async function readEnv() {
  const env = schema.parse(process.env);
  const privateKey = env.WARDEN_PRIVATE_KEY_FILE
    ? await Bun.file(env.WARDEN_PRIVATE_KEY_FILE).text()
    : env.WARDEN_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (env.WARDEN_DEMO === "false" && !privateKey)
    throw new Error("Set WARDEN_PRIVATE_KEY_FILE or WARDEN_PRIVATE_KEY");
  if (env.WARDEN_DEMO === "true") {
    const url = new URL(env.WARDEN_GITHUB_API_URL);
    if (
      url.protocol !== "http:" ||
      !["github", "localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw new Error("Demo authentication requires a local HTTP fixture host");
  }
  return { ...env, privateKey };
}
export type Env = Awaited<ReturnType<typeof readEnv>>;
