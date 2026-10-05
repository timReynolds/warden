import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  WARDEN_WEBHOOK_SECRET: z.string().min(16),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WARDEN_APP_ID: z.coerce.number().int().positive(),
  WARDEN_PRIVATE_KEY: z.string().optional(),
  WARDEN_PRIVATE_KEY_FILE: z.string().optional(),
  WARDEN_GITHUB_API_URL: z.url().default("https://api.github.com"),
  WARDEN_JOB_LEASE_SECONDS: z.coerce.number().int().min(5).max(600).default(60),
  WARDEN_WORKER_POLL_MS: z.coerce.number().int().min(50).default(1000),
});
export async function readEnv() {
  const env = schema.parse(process.env);
  const privateKey = env.WARDEN_PRIVATE_KEY_FILE
    ? await Bun.file(env.WARDEN_PRIVATE_KEY_FILE).text()
    : env.WARDEN_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!privateKey)
    throw new Error("Set WARDEN_PRIVATE_KEY_FILE or WARDEN_PRIVATE_KEY");
  return { ...env, privateKey };
}
export type Env = Awaited<ReturnType<typeof readEnv>>;
