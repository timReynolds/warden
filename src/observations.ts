import { sql } from "drizzle-orm";
import type { Policy } from "./config";
import type { Database } from "./db";
import { dateOf } from "./discovery";
import { evaluate } from "./evaluator";
import type { GitHub } from "./github";
import {
  CHECK_NAME,
  type PullRequest,
  type Snapshot,
  type Target,
  targetKey,
} from "./model";
import { applySignals } from "./signals";

export async function snapshotFor(
  github: GitHub,
  t: Target,
  p: PullRequest,
  cachedHead?: Snapshot,
): Promise<Snapshot> {
  const head = cachedHead ?? (await github.snapshot(t, p.sha));
  if (!p.mergeSha || p.mergeSha === p.sha) return head;
  const merge = await github.snapshot(t, p.mergeSha);
  return {
    checks: head.checks.concat(merge.checks),
    statuses: head.statuses.concat(merge.statuses),
    suites: head.suites.concat(merge.suites),
    workflows: head.workflows.concat(merge.workflows),
  };
}
async function trackedSnapshot(
  db: Pick<Database, "execute">,
  t: Target,
  p: PullRequest,
  generation: number,
): Promise<{ snapshot: Snapshot; at: Date } | null> {
  const row = (
    await db.execute(sql`SELECT snapshot,observed_at FROM warden_observations
    WHERE pr_key=${targetKey(t)} AND sha=${p.sha} AND generation=${generation}
    AND base_sha=${p.baseSha} AND merge_sha IS NOT DISTINCT FROM ${p.mergeSha}
    AND source IN ('github','final-verification') ORDER BY id DESC LIMIT 1`)
  )[0];
  const at = dateOf(row?.observed_at);
  // Only Warden's fully-read snapshots are stored under these sources. Event
  // observations never become a discovery baseline, including after a restart.
  return row && at ? { snapshot: row.snapshot as Snapshot, at } : null;
}
function ownedGateIds(snapshot: Snapshot, sha: string, appId: number) {
  return new Set(
    snapshot.checks
      .filter(
        (check) =>
          check.sha === sha &&
          check.appId === appId &&
          check.name === CHECK_NAME,
      )
      .map((check) => check.id),
  );
}

export async function recordObservation(
  tx: Pick<Database, "execute">,
  t: Target,
  p: PullRequest,
  generation: number,
  source: "events" | "github" | "final-verification",
  snapshot: Snapshot,
) {
  await tx.execute(
    sql`INSERT INTO warden_observations(pr_key,sha,generation,base_sha,merge_sha,source,snapshot) VALUES(${targetKey(t)},${p.sha},${generation},${p.baseSha},${p.mergeSha},${source},${JSON.stringify(snapshot)}::jsonb)`,
  );
  if (source === "final-verification") return;
  const key = targetKey(t);
  for (const [kind, items] of Object.entries(snapshot))
    for (const item of items) {
      const outcome =
        "state" in item
          ? String(item.state)
          : String(item.conclusion ?? item.status);
      await tx.execute(
        sql`INSERT INTO warden_attempts(pr_key,sha,kind,identity,outcome,data) VALUES(${key},${item.sha},${kind},${String(item.id)},${outcome},${JSON.stringify(item)}::jsonb)`,
      );
    }
}

// The caller holds lifecycle, PR, and SHA locks for the complete observation.
export async function readObservation(
  tx: Pick<Database, "execute">,
  github: GitHub,
  t: Target,
  p: PullRequest,
  policy: Policy,
  generation: number,
  events: boolean,
  now: () => Date,
) {
  const baseline = events ? await trackedSnapshot(tx, t, p, generation) : null;
  let tracked = baseline !== null;
  let snapshot = await applySignals(
    tx,
    t,
    baseline?.snapshot ?? (await snapshotFor(github, t, p)),
    policy,
    tracked,
  );
  // New jobs can require workflow/job metadata which a check webhook lacks.
  // Resolve that metadata rather than guessing an ignored workflow.
  if (
    tracked &&
    policy.checks.ignore_workflows.length &&
    snapshot.checks.some(
      (check) =>
        check.appId !== github.appId &&
        !baseline?.snapshot.checks.some(
          (old) => old.id === check.id && old.sha === check.sha,
        ),
    )
  ) {
    tracked = false;
    snapshot = await applySignals(
      tx,
      t,
      await snapshotFor(github, t, p),
      policy,
    );
  }
  const at = now();
  const lastRead = tracked ? (baseline?.at ?? null) : at;
  const observedGateIds = tracked
    ? null
    : ownedGateIds(snapshot, p.sha, github.appId);
  return {
    snapshot,
    tracked,
    at,
    lastRead,
    observedGateIds,
  };
}

export async function verifyObservation(
  tx: Pick<Database, "execute">,
  github: GitHub,
  t: Target,
  p: PullRequest,
  policy: Policy,
  now: () => Date,
) {
  const snapshot = await applySignals(
    tx,
    t,
    await snapshotFor(github, t, p),
    policy,
  );
  const observedGateIds = ownedGateIds(snapshot, p.sha, github.appId);
  const evaluation = evaluate(snapshot, policy, github.appId);
  const at = now();
  return { snapshot, observedGateIds, evaluation, at };
}
