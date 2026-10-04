import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "./db";
import { enqueue } from "./db/queue";
import {
  dateOf,
  isEmptyEvaluation,
  pending,
  settledSuccess,
  stabilityRemaining,
} from "./discovery";
import { evaluate } from "./evaluator";
import type { GitHub } from "./github";
import {
  type Decision,
  type PullRequest,
  type Snapshot,
  sameSubject,
  type Target,
  targetKey,
} from "./model";
import { snapshotFor } from "./observations";
import { configFor } from "./policy-store";
import { applySignals } from "./signals";

export async function deliveryBlocked(
  db: Pick<Database, "execute">,
  value: unknown,
): Promise<boolean> {
  if (!Array.isArray(value) || !value.length) return false;
  const ids = value.map(String);
  const row = (
    await db.execute(
      sql`SELECT count(*) AS count,bool_and(completed) AS done FROM warden_jobs WHERE id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`,`,
      )})`,
    )
  )[0];
  return Number(row?.count) !== ids.length || row?.done !== true;
}
export async function peersFor(
  db: Pick<Database, "execute">,
  github: GitHub,
  t: Target,
  sha: string,
) {
  const known = await db.execute(
    sql`SELECT number FROM warden_prs WHERE installation_id=${t.installationId} AND repository_id=${t.repositoryId} AND sha=${sha} AND state='open'`,
  );
  return [
    ...new Set(
      known
        .map((row) => Number(row.number))
        .concat(await github.associated(t, sha)),
    ),
  ];
}
// Reuse the caller's SHA lock and transaction; never take a peer PR lock here.
export async function evaluateSharedHead(
  db: Database,
  tx: Pick<Database, "execute">,
  github: GitHub,
  t: Target,
  p: PullRequest,
  decision: Decision,
  peerHead: Snapshot,
  now: () => Date,
  // Retain discovered deadlines even if a later peer observation throws.
  deadlines: { number: number; at: number }[],
) {
  let blocked = false;
  for (const number of (await peersFor(tx, github, t, p.sha)).filter(
    (n) => n !== t.number,
  )) {
    let pt = { ...t, number };
    const peer = await github.pull(pt);
    pt = { ...pt, owner: peer.owner, repo: peer.repo };
    if (peer.sha !== p.sha || peer.state !== "open") continue;
    const peerPolicy = await configFor(db, github, pt, peer.baseSha);
    // Also include a peer's distinct current merge candidate, if any.
    const peerSnapshot = await applySignals(
      tx,
      pt,
      await snapshotFor(github, pt, peer, {
        checks: peerHead.checks.filter((item) => item.sha === p.sha),
        statuses: peerHead.statuses.filter((item) => item.sha === p.sha),
        suites: peerHead.suites.filter((item) => item.sha === p.sha),
        workflows: peerHead.workflows.filter((item) => item.sha === p.sha),
      }),
      peerPolicy,
    );
    let peerDecision: Decision = evaluate(
      peerSnapshot,
      peerPolicy,
      github.appId,
    );
    const peerCurrent = await github.pull(pt);
    const peerNow = now();
    const peerRow = (
      await tx.execute(
        sql`SELECT * FROM warden_prs WHERE key=${targetKey(pt)} AND owner=${peer.owner} AND repo=${peer.repo} AND sha=${peer.sha} AND base_sha=${peer.baseSha} AND base_ref=${peer.baseRef} AND state='open' AND merge_sha IS NOT DISTINCT FROM ${peer.mergeSha}`,
      )
    )[0];
    const peerStable = dateOf(peerRow?.stable_since);
    const peerStart = dateOf(peerRow?.window_start);
    const peerExpired =
      peerStart &&
      peerNow.getTime() - peerStart.getTime() >=
        peerPolicy.reconciliation.max_duration_seconds * 1000;
    const peerSettled =
      settledSuccess(peerRow?.last_decision) &&
      peerRow?.fingerprint === peerDecision.fingerprint;
    if (
      peerStart &&
      !peerSettled &&
      peerRow?.fingerprint === peerDecision.fingerprint
    )
      deadlines.push({
        number,
        at:
          peerStart.getTime() +
          peerPolicy.reconciliation.max_duration_seconds * 1000,
      });
    if (await deliveryBlocked(tx, peerRow?.delivery_error_jobs)) {
      peerDecision = {
        ...peerDecision,
        state: "failure",
        reason: "Failed webhook delivery has not recovered",
      };
    }
    const peerLabelsMatch =
      peerRow?.labels_hash ===
      createHash("sha256")
        .update(JSON.stringify([...peer.labels].sort()))
        .digest("hex");
    const peerReady =
      peerRow &&
      peerRow.fingerprint === peerDecision.fingerprint &&
      peerLabelsMatch &&
      peerStable &&
      peerStart &&
      (!peerExpired || peerSettled) &&
      stabilityRemaining(peerPolicy, peerStart, peerStable, peerNow) === 0;
    if (
      (!peerRow ||
        peerRow.fingerprint !== peerDecision.fingerprint ||
        !peerStable ||
        !peerLabelsMatch) &&
      (!peerExpired ||
        (settledSuccess(peerRow?.last_decision) &&
          peerRow?.fingerprint !== peerDecision.fingerprint))
    )
      await enqueue(tx, pt);
    if (
      isEmptyEvaluation(peerDecision) &&
      peerPolicy.empty_checks.policy === "pass_after_attempts" &&
      Number(peerRow?.empty_scans ?? 0) >=
        peerPolicy.empty_checks.pass_after_attempts
    )
      peerDecision = { ...peerDecision, state: "success" };
    if (!sameSubject(peerCurrent, peer))
      peerDecision = {
        ...peerDecision,
        state: "pending",
        reason: "Peer subject changed",
      };
    if (peerDecision.state !== "success" || !peerReady) {
      const reason =
        peerDecision.state === "success" && !peerReady
          ? "Discovery/stability has not completed for this PR"
          : peerDecision.reason;
      const blockers = [
        ...decision.blockers,
        `PR #${number}: ${reason}`,
        ...peerDecision.blockers.map((blocker) => `PR #${number}: ${blocker}`),
      ];
      const details = [
        ...(decision.details ?? []),
        ...(peerDecision.details ?? []).map((detail) => ({
          ...detail,
          name: `PR #${number}: ${detail.name}`,
        })),
      ];
      if (peerDecision.state === "failure")
        decision = {
          ...decision,
          state: "failure",
          phase: "failed",
          reason: "Shared head has another PR with blockers",
          blockers,
          details,
        };
      else if (decision.state === "success")
        decision = {
          ...pending(
            decision,
            "Shared head has another PR with blockers",
            blockers,
          ),
          details,
        };
      else decision = { ...decision, blockers, details };
      blocked = true;
    }
  }
  return { decision, blocked };
}
