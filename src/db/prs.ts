import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { type PullRequest, type Target, targetKey } from "../model";
import type { Database } from "./index";

// Lifecycle locks come first, then the PR lock, then sorted SHA locks. Shared
// lifecycle locks allow unrelated PR work while excluding bulk membership edits.
export async function lockLifecycle(
  db: Pick<Database, "execute">,
  t: Pick<Target, "installationId" | "repositoryId">,
) {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`warden-installation:${t.installationId}`},2))`,
  );
  await db.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`warden-repository:${t.installationId}/${t.repositoryId}`},2))`,
  );
}
export async function lockHeads(
  db: Pick<Database, "execute">,
  t: Target,
  heads: string[],
) {
  for (const sha of [...new Set(heads)].sort())
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${t.installationId}/${t.repositoryId}:${sha}`},1))`,
    );
}
// Caller holds the PR lock. Readiness invalidation must also serialize with
// publications by other PRs sharing its current head.
export async function lockCurrentHead(
  db: Pick<Database, "execute">,
  t: Target,
) {
  const row = (
    await db.execute(sql`SELECT sha FROM warden_prs WHERE key=${targetKey(t)}`)
  )[0];
  if (typeof row?.sha === "string") await lockHeads(db, t, [row.sha]);
}

// Assignment fragment only: callers keep lifecycle, PR and SHA locks around the
// entire transition. Generation, publication, bypass and barriers are explicit
// caller decisions because those transitions have different semantics.
export function discoveryReset(start?: Date) {
  const window = start ? sql`${start.toISOString()}` : sql`clock_timestamp()`;
  return sql`fingerprint=NULL,stable_since=NULL,window_start=${window},
    empty_scans=0,empty_next_at=NULL,scan_attempt=0`;
}

export async function ensurePr(
  db: Pick<Database, "execute">,
  t: Target,
  p: PullRequest,
) {
  const subjectChanged = sql`warden_prs.owner<>excluded.owner OR
    warden_prs.repo<>excluded.repo OR warden_prs.sha<>excluded.sha OR
    warden_prs.base_sha<>excluded.base_sha OR
    warden_prs.base_ref IS DISTINCT FROM excluded.base_ref OR
    warden_prs.merge_sha IS DISTINCT FROM excluded.merge_sha OR
    warden_prs.state<>excluded.state OR
    warden_prs.labels_hash IS DISTINCT FROM excluded.labels_hash`;
  const key = targetKey(t);
  const labelsHash = createHash("sha256")
    .update(JSON.stringify([...p.labels].sort()))
    .digest("hex");
  await db.execute(sql`INSERT INTO warden_prs(key,owner,repo,number,installation_id,repository_id,sha,base_sha,base_ref,merge_sha,labels_hash,state) VALUES(${key},${t.owner},${t.repo},${t.number},${t.installationId},${t.repositoryId},${p.sha},${p.baseSha},${p.baseRef},${p.mergeSha},${labelsHash},${p.state})
 ON CONFLICT(key) DO UPDATE SET
 check_id=CASE WHEN warden_prs.sha<>excluded.sha THEN NULL ELSE warden_prs.check_id END,
 published_hash=CASE WHEN ${subjectChanged} THEN NULL ELSE warden_prs.published_hash END,
 fingerprint=CASE WHEN ${subjectChanged} THEN NULL ELSE warden_prs.fingerprint END,
 stable_since=CASE WHEN ${subjectChanged} THEN NULL ELSE warden_prs.stable_since END,
 window_start=CASE WHEN ${subjectChanged} THEN clock_timestamp() ELSE warden_prs.window_start END,
 empty_scans=CASE WHEN ${subjectChanged} THEN 0 ELSE warden_prs.empty_scans END,
 empty_next_at=CASE WHEN ${subjectChanged} THEN NULL ELSE warden_prs.empty_next_at END,
 scan_attempt=CASE WHEN ${subjectChanged} THEN 0 ELSE warden_prs.scan_attempt END,
 generation=warden_prs.generation+CASE WHEN ${subjectChanged} THEN 1 ELSE 0 END,
 bypass_actor=CASE WHEN warden_prs.sha<>excluded.sha THEN NULL ELSE warden_prs.bypass_actor END,
 bypass_sha=CASE WHEN warden_prs.sha<>excluded.sha THEN NULL ELSE warden_prs.bypass_sha END,
 bypass_application_id=CASE WHEN warden_prs.sha<>excluded.sha THEN NULL ELSE warden_prs.bypass_application_id END,
 owner=excluded.owner,repo=excluded.repo,sha=excluded.sha,base_sha=excluded.base_sha,base_ref=excluded.base_ref,merge_sha=excluded.merge_sha,labels_hash=excluded.labels_hash,state=excluded.state,installation_id=excluded.installation_id,updated_at=now()`);
}
