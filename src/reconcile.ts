import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { parsePolicy } from "./config";
import type { Database } from "./db";
import {
  discoveryReset,
  ensurePr,
  lockCurrentHead,
  lockHeads,
  lockLifecycle,
} from "./db/prs";
import { enqueue } from "./db/queue";
import { evaluate } from "./evaluator";
import type { GitHub } from "./github";
import { lifecycleActive } from "./installations";
import {
  BYPASS_LABEL,
  CHECK_NAME,
  type Decision,
  type PullRequest,
  type Snapshot,
  sameSubject,
  type Target,
  targetKey,
} from "./model";
import { configFor } from "./policy-store";
import { applySignals } from "./signals";

function dateOf(value: unknown): Date | null {
  const date =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}
function settledSuccess(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    value.state === "success" &&
    "phase" in value &&
    value.phase === "passed"
  );
}
async function deliveryBlocked(
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
export type Controls = { now: () => Date; jitter: () => number };
export const controls: Controls = {
  now: () => new Date(),
  jitter: () => Math.random(),
};
function pending(d: Decision, reason: string, blockers: string[]): Decision {
  return { ...d, state: "pending", phase: "discovery", reason, blockers };
}
async function snapshotFor(
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
async function publishGate(
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
    if (checkId === null) checkId = await github.findCheck(t, sha);
    const write = () => github.publishCheck(t, sha, decision, checkId);
    try {
      checkId = await effect(
        db,
        t,
        "check",
        { sha: sha, decision, id: checkId },
        write,
      );
    } catch (error) {
      if (!notFound(error)) throw error;
      checkId = await github.findCheck(t, sha);
      checkId = await effect(
        db,
        t,
        "check",
        { sha: sha, decision, id: checkId },
        write,
      );
    }
    await tx.execute(
      sql`UPDATE warden_gates SET check_id=${checkId},published_hash=${hash} WHERE installation_id=${t.installationId} AND repository_id=${t.repositoryId} AND sha=${sha}`,
    );
  }
  return checkId;
}
async function peersFor(
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
async function reconcileLocked(
  db: Database,
  github: GitHub,
  t: Target,
  c: Controls,
  renew: boolean,
  remember: (row: Record<string, unknown>) => void,
  events: boolean,
): Promise<number | null> {
  return db.transaction(async (tx) => {
    const key = targetKey(t);
    await lockLifecycle(tx, t);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${key},0))`,
    );
    const suspended = (
      await tx.execute(sql`SELECT * FROM warden_prs WHERE key=${key}`)
    )[0];
    if (suspended) remember(suspended);
    if (suspended?.state === "suspended") return null;
    if (
      typeof suspended?.owner === "string" &&
      typeof suspended.repo === "string"
    )
      t = { ...t, owner: suspended.owner, repo: suspended.repo };
    const p = await github.pull(t);
    t = { ...t, owner: p.owner, repo: p.repo };
    const heads = [
      p.sha,
      ...(typeof suspended?.sha === "string" ? [suspended.sha] : []),
    ];
    await lockHeads(tx, t, heads);
    if (!(await lifecycleActive(tx, t))) return null;
    const currentState = (
      await tx.execute(sql`SELECT state FROM warden_prs WHERE key=${key}`)
    )[0];
    if (currentState?.state === "suspended") return null;
    let now = c.now();
    await ensurePr(tx, t, p);
    if (renew)
      await tx.execute(
        sql`UPDATE warden_prs SET ${discoveryReset(now)} WHERE key=${key}`,
      );
    if (
      suspended &&
      (suspended.sha !== p.sha ||
        suspended.state !== p.state ||
        suspended.base_sha !== p.baseSha ||
        suspended.base_ref !== p.baseRef ||
        suspended.merge_sha !== p.mergeSha)
    ) {
      const peers = await tx.execute(
        sql`SELECT number FROM warden_prs WHERE installation_id=${t.installationId} AND repository_id=${t.repositoryId} AND state='open' AND number<>${t.number} AND sha IN (${sql.join(
          heads.map((head) => sql`${head}`),
          sql`,`,
        )})`,
      );
      for (const peer of peers)
        await enqueue(tx, { ...t, number: Number(peer.number) }, 0, true);
    }
    if (p.state !== "open") return null;
    const row = (
      await tx.execute(sql`SELECT * FROM warden_prs WHERE key=${key}`)
    )[0];
    if (!row) throw new Error("Missing Warden PR state");
    let observedGateIds: Set<number> | null = null;
    let windowStart = dateOf(row.window_start) ?? now;
    const previouslySettled = settledSuccess(row.last_decision);
    let policy = parsePolicy(null);
    let decision: Decision;
    let verified = false;
    let fingerprint = "error";
    let observationError = false;
    let backoff = 0;
    let emptyScans = Number(row.empty_scans);
    const attempt = Number(row.scan_attempt);
    let delay = 30;
    let lastRead: Date | null = null;
    const peerDeadlines: { number: number; at: number }[] = [];
    try {
      policy = await configFor(db, github, t, p.baseSha);
      const intervals = policy.reconciliation.intervals_seconds;
      delay = Math.max(
        1,
        Math.round(
          (intervals[Math.min(attempt, intervals.length - 1)] ?? 300) *
            (0.9 + c.jitter() * 0.2),
        ),
      );
      if (
        Array.isArray(row.delivery_error_jobs) &&
        row.delivery_error_jobs.length
      ) {
        if (await deliveryBlocked(tx, row.delivery_error_jobs))
          throw new Error(
            "A failed webhook delivery must recover or be refreshed by operator onboarding",
          );
        await tx.execute(
          sql`UPDATE warden_prs SET delivery_error_jobs='{}' WHERE key=${key}`,
        );
      }
      const baseline = events
        ? await trackedSnapshot(tx, t, p, Number(row.generation))
        : null;
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
      now = c.now();
      lastRead = tracked ? (baseline?.at ?? null) : now;
      let peerHead = snapshot;
      observedGateIds = tracked
        ? null
        : ownedGateIds(snapshot, p.sha, github.appId);
      await tx.execute(
        sql`INSERT INTO warden_observations(pr_key,sha,generation,base_sha,merge_sha,source,snapshot) VALUES(${key},${p.sha},${Number(row.generation)},${p.baseSha},${p.mergeSha},${tracked ? "events" : "github"},${JSON.stringify(snapshot)}::jsonb)`,
      );
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
      decision = evaluate(snapshot, policy, github.appId);
      fingerprint = decision.fingerprint;
      if (previouslySettled && row.fingerprint !== fingerprint) {
        windowStart = now;
        await tx.execute(
          sql`UPDATE warden_prs SET window_start=${now.toISOString()} WHERE key=${key}`,
        );
      }
      const stableSince =
        row.fingerprint === fingerprint && dateOf(row.stable_since)
          ? (dateOf(row.stable_since) ?? now)
          : now;
      const isEmpty =
        decision.applicable === 0 && decision.reason === "No applicable checks";
      if (!isEmpty) emptyScans = 0;
      else if (
        !tracked &&
        (!dateOf(row.empty_next_at) ||
          now.getTime() >= (dateOf(row.empty_next_at)?.getTime() ?? 0))
      )
        emptyScans++;
      const emptyNext = isEmpty
        ? tracked
          ? dateOf(row.empty_next_at)
          : new Date(now.getTime() + delay * 1000)
        : null;
      await tx.execute(
        sql`UPDATE warden_prs SET fingerprint=${fingerprint},stable_since=${stableSince.toISOString()},empty_scans=${emptyScans},empty_next_at=${emptyNext?.toISOString() ?? null},scan_attempt=scan_attempt+${tracked ? 0 : 1} WHERE key=${key}`,
      );
      if (
        isEmpty &&
        policy.empty_checks.policy === "pass_after_attempts" &&
        emptyScans >= policy.empty_checks.pass_after_attempts
      )
        decision = {
          ...decision,
          state: "success",
          phase: "passed",
          reason: `No eligible checks: passed after ${emptyScans} complete scheduled empty scans`,
          blockers: [],
        };
      else if (isEmpty)
        decision = pending(decision, "Discovering checks", [
          policy.empty_checks.policy === "block"
            ? "Empty-check policy blocks success"
            : `${emptyScans}/${policy.empty_checks.pass_after_attempts} complete scheduled empty scans`,
        ]);
      const elapsed = now.getTime() - windowStart.getTime();
      if (decision.state === "success") {
        const quiet = policy.reconciliation.quiet_period_seconds * 1000;
        const grace = policy.reconciliation.initial_grace_seconds * 1000;
        if (elapsed < grace || now.getTime() - stableSince.getTime() < quiet) {
          decision = pending(decision, "Verifying stable check results", [
            "Initial discovery grace and quiet period must complete",
          ]);
          delay = Math.min(
            delay,
            Math.max(
              1,
              Math.ceil(
                Math.max(
                  grace - elapsed,
                  quiet - (now.getTime() - stableSince.getTime()),
                ) / 1000,
              ),
            ),
          );
        } else {
          const finalSnapshot = await applySignals(
            tx,
            t,
            await snapshotFor(github, t, p),
            policy,
          );
          peerHead = finalSnapshot;
          observedGateIds = ownedGateIds(finalSnapshot, p.sha, github.appId);
          const final = evaluate(finalSnapshot, policy, github.appId);
          lastRead = c.now();
          await tx.execute(
            sql`INSERT INTO warden_observations(pr_key,sha,generation,base_sha,merge_sha,source,snapshot) VALUES(${key},${p.sha},${Number(row.generation)},${p.baseSha},${p.mergeSha},'final-verification',${JSON.stringify(finalSnapshot)}::jsonb)`,
          );
          if (final.fingerprint !== fingerprint) {
            decision =
              final.state === "failure"
                ? {
                    ...final,
                    blockers: [
                      ...final.blockers,
                      "Stability and empty scans reset",
                    ],
                  }
                : pending(
                    final,
                    "New work discovered during final verification",
                    [...final.blockers, "Stability and empty scans reset"],
                  );

            await tx.execute(
              sql`UPDATE warden_prs SET fingerprint=NULL,stable_since=NULL,empty_scans=0,empty_next_at=NULL WHERE key=${key}`,
            );
          } else verified = true;
        }
      }
      if (!p.labels.includes(BYPASS_LABEL))
        await tx.execute(
          sql`UPDATE warden_prs SET bypass_actor=NULL,bypass_sha=NULL,bypass_application_id=NULL WHERE key=${key}`,
        );
      if (
        p.labels.includes(BYPASS_LABEL) &&
        typeof row.bypass_actor === "string" &&
        row.bypass_sha === p.sha
      ) {
        const application = await github.labelApplication(t, BYPASS_LABEL);
        const permission = await github.permission(t, row.bypass_actor);
        if (
          application &&
          application.id === row.bypass_application_id &&
          application.actor === row.bypass_actor &&
          policy.bypass.allowed_permissions.some(
            (value) => value === permission,
          )
        ) {
          const peers = await peersFor(tx, github, t, p.sha);
          if (peers.length === 1 && peers[0] === t.number) {
            decision = {
              ...decision,
              state: "success",
              phase: "bypassed",
              reason: `Bypassed via skip warden by ${row.bypass_actor}`,
              blockers: [],
            };
            verified = true;
          } else {
            // A label cannot weaken a peer's gate. Normal verified evaluation
            // remains available when every subject passes without bypass.
            decision = {
              ...decision,
              reason: `${decision.reason}; bypass unavailable on a shared head`,
              blockers:
                decision.state === "success"
                  ? []
                  : [
                      ...decision.blockers,
                      "A shared head cannot be bypassed independently",
                    ],
            };
          }
        }
      } else if (p.labels.includes(BYPASS_LABEL))
        decision = {
          ...decision,
          blockers: [
            ...decision.blockers,
            "skip warden has no verified grant for this PR/head; normal evaluation applies",
          ],
        };
      if (
        decision.phase !== "bypassed" &&
        (elapsed < policy.reconciliation.max_duration_seconds * 1000 ||
          (previouslySettled && row.fingerprint === fingerprint))
      ) {
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
              workflows: peerHead.workflows.filter(
                (item) => item.sha === p.sha,
              ),
            }),
            peerPolicy,
          );
          let peerDecision = evaluate(peerSnapshot, peerPolicy, github.appId);
          const peerCurrent = await github.pull(pt);
          const peerNow = c.now();
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
            peerDeadlines.push({
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
            peerNow.getTime() - peerStart.getTime() >=
              peerPolicy.reconciliation.initial_grace_seconds * 1000 &&
            (!peerExpired || peerSettled) &&
            peerNow.getTime() - peerStable.getTime() >=
              peerPolicy.reconciliation.quiet_period_seconds * 1000;
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
            peerDecision.reason === "No applicable checks" &&
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
              ...peerDecision.blockers.map(
                (blocker) => `PR #${number}: ${blocker}`,
              ),
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
            verified = false;
          }
        }
      }
    } catch (error) {
      observationError = true;
      emptyScans = 0;
      const message = error instanceof Error ? error.message : String(error);
      const invalid = message.startsWith("Warden configuration:");
      decision = {
        state: "failure",
        phase: invalid ? "configuration_error" : "observation_error",
        reason: invalid
          ? "Invalid trusted-base Warden configuration"
          : "Warden observation error",
        blockers: [message.slice(0, 1500)],
        applicable: 0,
        fingerprint,
      };
      if (
        typeof error === "object" &&
        error !== null &&
        "retryAfter" in error &&
        typeof error.retryAfter === "number"
      )
        backoff = error.retryAfter;
      await tx.execute(
        sql`UPDATE warden_prs SET empty_scans=0,empty_next_at=NULL,fingerprint=NULL,stable_since=NULL WHERE key=${key}`,
      );
    }
    if (previouslySettled && decision.state !== "success") {
      windowStart = now;
      await tx.execute(
        sql`UPDATE warden_prs SET window_start=${now.toISOString()} WHERE key=${key}`,
      );
    }
    const current = await github.pull(t);
    if (!sameSubject(current, p) || current.state !== "open") {
      return 0;
    }
    t = { ...t, owner: current.owner, repo: current.repo };
    if (decision.phase === "bypassed") {
      const application = await github.labelApplication(t, BYPASS_LABEL);
      if (
        !application ||
        application.id !== row.bypass_application_id ||
        application.actor !== row.bypass_actor
      ) {
        await tx.execute(
          sql`UPDATE warden_prs SET bypass_actor=NULL,bypass_sha=NULL,bypass_application_id=NULL WHERE key=${key}`,
        );
        return 0;
      }
    }
    const elapsed = now.getTime() - windowStart.getTime();
    const expiredPeer = peerDeadlines.find(
      (peer) => c.now().getTime() >= peer.at,
    );
    const exhausted =
      Boolean(expiredPeer) ||
      (!(
        previouslySettled &&
        row.fingerprint === fingerprint &&
        decision.state === "success"
      ) &&
        elapsed + Math.max(0, c.now().getTime() - now.getTime()) >=
          policy.reconciliation.max_duration_seconds * 1000);
    if (exhausted && decision.phase !== "bypassed")
      decision = {
        ...decision,
        state: "failure",
        phase: "timeout",
        reason: "Warden reconciliation timed out",
        blockers: [
          ...decision.blockers,
          ...(expiredPeer
            ? [`PR #${expiredPeer.number}: observation deadline elapsed`]
            : []),
          "Reconcile now or a new event can renew observation; timeout never passes",
        ],
      };
    if (decision.state === "success" && !verified)
      throw new Error("Unverified success blocked");
    await tx.execute(
      sql`INSERT INTO warden_decisions(pr_key,sha,generation,decision) VALUES(${key},${p.sha},${Number(row.generation)},${JSON.stringify(decision)}::jsonb)`,
    );
    const hash = createHash("sha256")
      .update(JSON.stringify({ sha: p.sha, decision }))
      .digest("hex");
    const out = (
      await db.execute(
        sql`INSERT INTO warden_outputs(pr_key,sha,generation,hash,desired) VALUES(${key},${p.sha},${Number(row.generation)},${hash},${JSON.stringify(decision)}::jsonb) ON CONFLICT(pr_key,generation,hash) DO UPDATE SET desired=excluded.desired RETURNING id`,
      )
    )[0];
    const checkId = await publishGate(
      db,
      tx,
      github,
      t,
      p.sha,
      decision,
      hash,
      observedGateIds,
    );
    let commentId = row.comment_id ? Number(row.comment_id) : null;
    await tx.execute(
      sql`UPDATE warden_prs SET owner=${t.owner},repo=${t.repo},check_id=${checkId},published_hash=${hash},last_decision=${JSON.stringify(decision)}::jsonb,updated_at=now() WHERE key=${key}`,
    );
    const afterCheck = await github.pull(t);
    if (!sameSubject(afterCheck, p) || afterCheck.state !== "open") {
      return 0;
    }
    const sinceComment =
      now.getTime() - (dateOf(row.comment_updated_at)?.getTime() ?? 0);
    const commentMissing =
      policy.comment.enabled &&
      commentId !== null &&
      row.comment_hash === hash &&
      !(await github.commentExists(t, commentId));
    if (commentMissing) commentId = null;
    const commentDue =
      policy.comment.enabled && (row.comment_hash !== hash || commentMissing);
    const unsettled =
      decision.state === "pending" ||
      decision.details?.some((d) => d.state === "running") ||
      observationError;
    // Debounce presentation independently; blocking check is already published.
    if (
      commentDue &&
      (decision.state === "failure" ||
        decision.state === "success" ||
        sinceComment >= policy.comment.min_update_interval_seconds * 1000)
    ) {
      if (commentId === null) commentId = await github.findComment(t);
      const write = () =>
        github.publishComment(t, p.sha, decision, commentId, {
          last: observationError
            ? "unavailable (observation failed)"
            : (lastRead?.toISOString() ?? "unavailable"),
          next:
            exhausted || !unsettled
              ? null
              : new Date(
                  now.getTime() + Math.max(delay, backoff) * 1000,
                ).toISOString(),
        });
      try {
        commentId = await effect(
          db,
          t,
          "comment",
          { sha: p.sha, decision, id: commentId },
          write,
        );
      } catch (error) {
        if (!notFound(error)) throw error;
        commentId = await github.findComment(t);
        commentId = await effect(
          db,
          t,
          "comment",
          { sha: p.sha, decision, id: commentId },
          write,
        );
      }
      await tx.execute(
        sql`UPDATE warden_prs SET comment_id=${commentId},comment_hash=${hash},comment_updated_at=${now.toISOString()} WHERE key=${key}`,
      );
    }
    await db.execute(
      sql`UPDATE warden_outputs SET published=true WHERE id=${out?.id}`,
    );
    if (exhausted || (decision.state !== "pending" && !unsettled)) return null;
    return Math.max(delay, backoff);
  });
}

export async function reconcile(
  db: Database,
  github: GitHub,
  t: Target,
  c: Controls = controls,
  renew = false,
  events = false,
): Promise<number | null> {
  let failedRevision: string | null = null;
  try {
    return await reconcileLocked(
      db,
      github,
      t,
      c,
      renew,
      (row) => {
        failedRevision = JSON.stringify(row);
      },
      events,
    );
  } catch (error) {
    try {
      await db.transaction(async (tx) => {
        await lockLifecycle(tx, t);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${targetKey(t)},0))`,
        );
        await lockCurrentHead(tx, t);
        const current = (
          await tx.execute(
            sql`SELECT * FROM warden_prs WHERE key=${targetKey(t)}`,
          )
        )[0];
        // A failed transaction must invalidate only the revision it observed,
        // never a newer generation or a successful evaluation that won the lock.
        if (
          current &&
          current.state === "open" &&
          JSON.stringify(current) === failedRevision &&
          (await lifecycleActive(tx, t))
        ) {
          await tx.execute(
            sql`UPDATE warden_prs SET empty_scans=0,empty_next_at=NULL,fingerprint=NULL,stable_since=NULL,window_start=CASE WHEN ${settledSuccess(current.last_decision)} THEN clock_timestamp() ELSE window_start END WHERE key=${targetKey(t)}`,
          );
          // Failure is safe on the persisted commit even when PR reads are down.
          // Never let an earlier success remain visible if checks are writable.
          const decision: Decision = {
            state: "failure",
            phase: "observation_error",
            reason: "Warden observation error",
            blockers: [error instanceof Error ? error.message : String(error)],
            applicable: 0,
            fingerprint: "error",
          };
          const sha = String(current.sha);
          const hash = createHash("sha256")
            .update(JSON.stringify({ sha, decision }))
            .digest("hex");
          const out = (
            await db.execute(
              sql`INSERT INTO warden_outputs(pr_key,sha,generation,hash,desired) VALUES(${targetKey(t)},${sha},${Number(current.generation)},${hash},${JSON.stringify(decision)}::jsonb) ON CONFLICT(pr_key,generation,hash) DO UPDATE SET desired=excluded.desired RETURNING id`,
            )
          )[0];
          await tx.execute(
            sql`INSERT INTO warden_decisions(pr_key,sha,generation,decision) VALUES(${targetKey(t)},${sha},${Number(current.generation)},${JSON.stringify(decision)}::jsonb)`,
          );
          await tx.execute(
            sql`UPDATE warden_prs SET last_decision=${JSON.stringify(decision)}::jsonb,published_hash=NULL,updated_at=clock_timestamp() WHERE key=${targetKey(t)}`,
          );
          let checkId: number | null;
          try {
            const repo = await github.repository(t);
            if (repo.state === "removed")
              throw new Error("Repository identity is no longer installed");
            t = { ...t, owner: repo.owner, repo: repo.repo };
            checkId = await publishGate(db, tx, github, t, sha, decision, hash);
          } catch (publicationError) {
            // Commit invalidated readiness even if GitHub is also unwritable.
            console.error(
              JSON.stringify({
                service: "warden-worker",
                event: "blocking_publication_failed",
                subject: targetKey(t),
                error:
                  publicationError instanceof Error
                    ? publicationError.message
                    : String(publicationError),
              }),
            );
            return;
          }
          await tx.execute(
            sql`UPDATE warden_prs SET owner=${t.owner},repo=${t.repo},check_id=${checkId},last_decision=${JSON.stringify(decision)}::jsonb,published_hash=${hash},updated_at=clock_timestamp() WHERE key=${targetKey(t)}`,
          );
          await db.execute(
            sql`UPDATE warden_outputs SET published=true WHERE id=${out?.id}`,
          );
        }
      });
    } catch (recoveryError) {
      console.error(
        JSON.stringify({
          service: "warden-worker",
          event: "blocking_publication_failed",
          subject: targetKey(t),
          error:
            recoveryError instanceof Error
              ? recoveryError.message
              : String(recoveryError),
        }),
      );
    }
    throw error;
  }
}
