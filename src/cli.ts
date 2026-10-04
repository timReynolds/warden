import { connect } from "./db";
import { readEnv } from "./env";
import { GitHub } from "./github";
import { onboardInstallation } from "./installations";

const installationId = Number(process.argv[2]);
if (!Number.isSafeInteger(installationId) || installationId <= 0)
  throw new Error("Usage: bun run onboard <installation-id>");
const env = await readEnv();
const { db, close } = connect(env.DATABASE_URL);
const github = new GitHub(env);
try {
  console.log(
    JSON.stringify({
      service: "warden-cli",
      installationId,
      enqueued: await github.withClient(installationId, () =>
        onboardInstallation(db, github, installationId),
      ),
    }),
  );
} finally {
  await close();
}
