import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "./db";
import type { GitHub } from "./github";
import { type Decision, type Target, targetKey } from "./model";

export async function recordDecision(
  tx: Pick<Database, "execute">,
  t: Target,
  sha: string,
  generation: number,
  decision: Decision,
) {
  await tx.execute(
    sql`INSERT INTO warden_decisions(pr_key,sha,generation,decision) VALUES(${targetKey(t)},${sha},${generation},${JSON.stringify(decision)}::jsonb)`,
  );
}

// Use the outer connection: desired writes must survive reconciliation rollback.
export async function recordOutput(
  db: Database,
  t: Target,
  sha: string,
  generation: number,
  decision: Decision,
) {
  const hash = createHash("sha256")
    .update(JSON.stringify({ sha, decision }))
    .digest("hex");
  const out = (
    await db.execute(
      sql`INSERT INTO warden_outputs(pr_key,sha,generation,hash,desired) VALUES(${targetKey(t)},${sha},${generation},${hash},${JSON.stringify(decision)}::jsonb) ON CONFLICT(pr_key,generation,hash) DO UPDATE SET desired=excluded.desired RETURNING id`,
    )
  )[0];
  return { hash, outputId: out?.id };
}

async function effect(
  db: Database,
  t: Target,
  kind: string,
  desired: unknown,
  write: () => Promise<number>,
): Promise<number> {
  const row = (
    await db.execute(
      sql`INSERT INTO warden_effects(pr_key,kind,desired) VALUES(${targetKey(t)},${kind},${JSON.stringify(desired)}::jsonb) RETURNING id`,
    )
  )[0];
  try {
    const id = await write();
    await db.execute(
      sql`UPDATE warden_effects SET result=${JSON.stringify({ id })}::jsonb,completed_at=now() WHERE id=${row?.id}`,
    );
    return id;
  } catch (error) {
    await db.execute(
      sql`UPDATE warden_effects SET error=${String(error).slice(0, 2000)},completed_at=now() WHERE id=${row?.id}`,
    );
    await db.execute(
      sql`INSERT INTO warden_metrics(name,value) VALUES('publication_errors',1) ON CONFLICT(name) DO UPDATE SET value=warden_metrics.value+1`,
    );
    throw error;
  }
}
const notFound = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  error.status === 404;
export async function publishGate(
  db: Database,
  tx: Pick<Database, "execute">,
  github: GitHub,
  t: Target,
  sha: string,
  decision: Decision,
  hash: string,
  observedGateIds: Set<number> | null = null,
): Promise<number | null> {
  await tx.execute(
    sql`INSERT INTO warden_gates(installation_id,repository_id,sha) VALUES(${t.installationId},${t.repositoryId},${sha}) ON CONFLICT DO NOTHING`,
  );
  const gate = (
    await tx.execute(
      sql`SELECT * FROM warden_gates WHERE installation_id=${t.installationId} AND repository_id=${t.repositoryId} AND sha=${sha}`,
    )
  )[0];
  let checkId = gate?.check_id ? Number(gate.check_id) : null;
  if (
    gate?.published_hash !== hash ||
    (checkId !== null &&
      observedGateIds !== null &&
      !observedGateIds.has(checkId))
  ) {
    checkId = await publishOwnedOutput(
      db,
      t,
      "check",
      sha,
      decision,
      checkId,
      () => github.findCheck(t, sha),
      (id) => github.publishCheck(t, sha, decision, id),
    );
    await tx.execute(
      sql`UPDATE warden_gates SET check_id=${checkId},published_hash=${hash} WHERE installation_id=${t.installationId} AND repository_id=${t.repositoryId} AND sha=${sha}`,
    );
  }
  return checkId;
}

async function publishOwnedOutput(
  db: Database,
  t: Target,
  kind: "check" | "comment",
  sha: string,
  decision: Decision,
  knownId: number | null,
  find: () => Promise<number | null>,
  publish: (id: number | null) => Promise<number>,
): Promise<number> {
  let id = knownId ?? (await find());
  const write = () =>
    effect(db, t, kind, { sha, decision, id }, () => publish(id));
  try {
    return await write();
  } catch (error) {
    if (!notFound(error)) throw error;
    id = await find();
    return write();
  }
}

export async function publishComment(
  db: Database,
  github: GitHub,
  t: Target,
  sha: string,
  decision: Decision,
  id: number | null,
  timing: { last: string; next: string | null },
): Promise<number> {
  return publishOwnedOutput(
    db,
    t,
    "comment",
    sha,
    decision,
    id,
    () => github.findComment(t),
    (currentId) => github.publishComment(t, sha, decision, currentId, timing),
  );
}
