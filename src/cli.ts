import { connect } from "./db";
import { readEnv } from "./env";
import { createApp, GitHub } from "./github";
import { onboardInstallation } from "./installations";

const installationId = Number(process.argv[2]);
if (!Number.isSafeInteger(installationId) || installationId <= 0)
  throw new Error("Usage: bun run onboard <installation-id>");
const env = await readEnv();
const { db, close } = connect(env.DATABASE_URL);
const app = createApp(env);
try {
  const github = new GitHub(
    await app.getInstallationOctokit(installationId),
    env.WARDEN_APP_ID,
  );
  console.log(
    JSON.stringify({
      service: "warden-cli",
      installationId,
      enqueued: await onboardInstallation(db, github, installationId),
    }),
  );
} finally {
  await close();
}
