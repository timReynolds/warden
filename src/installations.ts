import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./db";
import {
  discoveryReset,
  lockCurrentHead,
  lockHeads,
  lockLifecycle,
} from "./db/prs";
import { enqueue } from "./db/queue";
import type { GitHub } from "./github";
import {
  type LifecycleState,
  type RepositoryIdentity,
  type Target,
  targetKey,
} from "./model";

export async function lifecycleActive(
  db: Pick<Database, "execute">,
  t: Target,
) {
  const row = (
    await db.execute(sql`SELECT
    EXISTS(SELECT 1 FROM warden_installations WHERE id=${t.installationId} AND state<>'active') OR
    EXISTS(SELECT 1 FROM warden_repositories WHERE installation_id=${t.installationId} AND id=${t.repositoryId} AND state<>'active') AS inactive`)
  )[0];
  return row?.inactive === false;
}

export async function changeLifecycle(
  db: Database,
  installationId: number,
  repositoryId: number | null,
  requested:
    | LifecycleState
    | (() => Promise<LifecycleState | RepositoryIdentity>),
) {
  return db.transaction(async (tx) => {
    const installationLock = `warden-installation:${installationId}`;
    if (repositoryId === null)
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${installationLock},2))`,
      );
    else {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${installationLock},2))`,
      );
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`warden-repository:${installationId}/${repositoryId}`},2))`,
      );
    }
    // Read authoritative lifecycle state while holding its mutation lock.
    const resolved =
      typeof requested === "function" ? await requested() : requested;
    const state = typeof resolved === "string" ? resolved : resolved.state;
    const identity = typeof resolved === "string" ? null : resolved;
    const scope = sql`installation_id=${installationId}${repositoryId === null ? sql`` : sql` AND repository_id=${repositoryId}`}`;
    const members = await tx.execute(
      sql`SELECT owner,repo,number,installation_id,repository_id,sha FROM warden_prs WHERE ${scope} ORDER BY repository_id,sha,number`,
    );
    // Membership/readiness transitions share the locks used by publication.
    // Do not take peer PR locks while holding head locks.
    for (const member of members) {
      await lockHeads(
        tx,
        {
          installationId,
          repositoryId: Number(member.repository_id),
          owner: String(member.owner),
          repo: String(member.repo),
          number: Number(member.number),
        },
        [String(member.sha)],
      );
    }
    if (repositoryId === null)
      await tx.execute(
        sql`INSERT INTO warden_installations(id,state) VALUES(${installationId},${state}) ON CONFLICT(id) DO UPDATE SET state=excluded.state`,
      );
    else
      await tx.execute(
        sql`INSERT INTO warden_repositories(installation_id,id,owner,name,state) VALUES(${installationId},${repositoryId},${identity?.owner ?? ""},${identity?.repo ?? ""},${state}) ON CONFLICT(installation_id,id) DO UPDATE SET state=excluded.state,owner=CASE WHEN ${identity !== null} THEN excluded.owner ELSE warden_repositories.owner END,name=CASE WHEN ${identity !== null} THEN excluded.name ELSE warden_repositories.name END`,
      );
    const changed = await tx.execute(sql`UPDATE warden_prs SET
      state=${state === "active" ? "open" : "suspended"},generation=generation+1,
      ${discoveryReset()},published_hash=NULL,
      bypass_actor=NULL,bypass_sha=NULL,bypass_application_id=NULL,updated_at=now()
      WHERE ${scope} AND state=${state === "active" ? "suspended" : "open"}
      RETURNING owner,repo,number,repository_id`);
    if (state === "active")
      for (const member of changed)
        await enqueue(
          tx,
          {
            installationId,
            repositoryId: Number(member.repository_id),
            owner: String(member.owner),
            repo: String(member.repo),
            number: Number(member.number),
          },
          0,
          true,
        );
    return state;
  });
}

export async function onboardRepository(
  db: Database,
  github: GitHub,
  t: Target,
) {
  const resolved: { value: RepositoryIdentity | null } = { value: null };
  const state = await changeLifecycle(
    db,
    t.installationId,
    t.repositoryId,
    async () => {
      resolved.value = await github.repository(t);
      return resolved.value;
    },
  );
  if (state !== "active") return 0;
  if (!resolved.value) throw new Error("Repository identity unavailable");
  t = { ...t, owner: resolved.value.owner, repo: resolved.value.repo };
  const pulls = await github.openPulls(t);
  for (const pull of pulls) {
    const target = {
      ...t,
      number: z.object({ number: z.number().int().positive() }).parse(pull)
        .number,
    };
    await db.transaction(async (tx) => {
      await lockLifecycle(tx, target);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${targetKey(target)},0))`,
      );
      await lockCurrentHead(tx, target);
      await tx.execute(
        sql`UPDATE warden_prs SET ${discoveryReset()},delivery_error_jobs='{}' WHERE key=${targetKey(target)}`,
      );
      await enqueue(tx, target);
    });
  }
  return pulls.length;
}
export async function onboardInstallation(
  db: Database,
  github: GitHub,
  installationId: number,
) {
  const state = await changeLifecycle(db, installationId, null, () =>
    github.installationState(installationId),
  );
  if (state !== "active") return 0;
  const t = { installationId, repositoryId: 0, owner: "", repo: "", number: 0 };
  const repos = await github.repositories();
  let count = 0;
  for (const repo of repos) {
    const r = z
      .object({
        id: z.number(),
        name: z.string(),
        owner: z.object({ login: z.string() }),
      })
      .parse(repo);
    count += await onboardRepository(db, github, {
      ...t,
      repositoryId: r.id,
      owner: r.owner.login,
      repo: r.name,
    });
  }
  return count;
}
