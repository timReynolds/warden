import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { type Policy, parsePolicy } from "./config";
import type { Database } from "./db";
import type { GitHub } from "./github";
import type { Target } from "./model";

export async function configFor(
  db: Pick<Database, "execute">,
  github: GitHub,
  t: Target,
  revision: string,
): Promise<Policy> {
  const cached = (
    await db.execute(
      sql`SELECT content,error FROM warden_config_revisions WHERE installation_id=${t.installationId} AND repository_id=${t.repositoryId} AND revision=${revision}`,
    )
  )[0];
  if (cached) {
    if (cached.error) throw new Error(`Warden configuration: ${cached.error}`);
    return parsePolicy(cached.content === null ? null : String(cached.content));
  }
  const content = await github.config(t, revision);
  const hash = createHash("sha256")
    .update(content ?? "<absent>")
    .digest("hex");
  try {
    const policy = parsePolicy(content);
    await db.execute(
      sql`INSERT INTO warden_config_revisions(installation_id,repository_id,revision,hash,content,effective) VALUES(${t.installationId},${t.repositoryId},${revision},${hash},${content},${JSON.stringify(policy)}::jsonb) ON CONFLICT DO NOTHING`,
    );
    return policy;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.execute(
      sql`INSERT INTO warden_config_revisions(installation_id,repository_id,revision,hash,content,error) VALUES(${t.installationId},${t.repositoryId},${revision},${hash},${content},${message.slice(0, 4000)}) ON CONFLICT DO NOTHING`,
    );
    throw new Error(`Warden configuration: ${message}`);
  }
}
