import { sql } from "drizzle-orm";
import { applyBypass } from "./bypass";
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
import {
  advanceDiscovery,
  dateOf,
  pending,
  settledSuccess,
  stabilityRemaining,
} from "./discovery";
import { evaluate } from "./evaluator";
import type { GitHub } from "./github";
import { lifecycleActive } from "./installations";
import {
  BYPASS_LABEL,
  type Decision,
  sameSubject,
  type Target,
  targetKey,
} from "./model";
import {
  readObservation,
  recordObservation,
  verifyObservation,
} from "./observations";
import { configFor } from "./policy-store";
import {
  publishComment,
  publishGate,
  recordDecision,
  recordOutput,
} from "./publication";
import { deliveryBlocked, evaluateSharedHead } from "./shared-head";

export type Controls = { now: () => Date; jitter: () => number };
export const controls: Controls = {
  now: () => new Date(),
  jitter: () => Math.random(),
};
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
      const observation = await readObservation(
        tx,
        github,
        t,
        p,
        policy,
        Number(row.generation),
        events,
        () => c.now(),
      );
      const { snapshot, tracked } = observation;
      now = observation.at;
      lastRead = observation.lastRead;
      observedGateIds = observation.observedGateIds;
      let peerHead = snapshot;
      await recordObservation(
        tx,
        t,
        p,
        Number(row.generation),
        tracked ? "events" : "github",
        snapshot,
      );
      const evaluation = evaluate(snapshot, policy, github.appId);
      fingerprint = evaluation.fingerprint;
      if (previouslySettled && row.fingerprint !== fingerprint) {
        windowStart = now;
        await tx.execute(
          sql`UPDATE warden_prs SET window_start=${now.toISOString()} WHERE key=${key}`,
        );
      }
      const discovery = advanceDiscovery(
        {
          fingerprint:
            typeof row.fingerprint === "string" ? row.fingerprint : null,
          stableSince: dateOf(row.stable_since),
          emptyScans,
          emptyNext: dateOf(row.empty_next_at),
        },
        evaluation,
        policy,
        now,
        delay,
        !tracked,
      );
      const { stableSince, emptyNext } = discovery;
      emptyScans = discovery.emptyScans;
      decision = discovery.decision;
      await tx.execute(
        sql`UPDATE warden_prs SET fingerprint=${fingerprint},stable_since=${stableSince.toISOString()},empty_scans=${emptyScans},empty_next_at=${emptyNext?.toISOString() ?? null},scan_attempt=scan_attempt+${tracked ? 0 : 1} WHERE key=${key}`,
      );
      const elapsed = now.getTime() - windowStart.getTime();
      if (decision.state === "success") {
        const remaining = stabilityRemaining(
          policy,
          windowStart,
          stableSince,
          now,
        );
        if (remaining > 0) {
          decision = pending(decision, "Verifying stable check results", [
            "Initial discovery grace and quiet period must complete",
          ]);
          delay = Math.min(delay, Math.max(1, Math.ceil(remaining / 1000)));
        } else {
          const finalRead = await verifyObservation(
            tx,
            github,
            t,
            p,
            policy,
            () => c.now(),
          );
          peerHead = finalRead.snapshot;
          observedGateIds = finalRead.observedGateIds;
          const final = finalRead.evaluation;
          lastRead = finalRead.at;
          await recordObservation(
            tx,
            t,
            p,
            Number(row.generation),
            "final-verification",
            finalRead.snapshot,
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
      decision = await applyBypass(tx, github, t, p, row, policy, decision);
      if (decision.phase === "bypassed") verified = true;
      if (
        decision.phase !== "bypassed" &&
        (elapsed < policy.reconciliation.max_duration_seconds * 1000 ||
          (previouslySettled && row.fingerprint === fingerprint))
      ) {
        const shared = await evaluateSharedHead(
          db,
          tx,
          github,
          t,
          p,
          decision,
          peerHead,
          () => c.now(),
          peerDeadlines,
        );
        decision = shared.decision;
        if (shared.blocked) verified = false;
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
    await recordDecision(tx, t, p.sha, Number(row.generation), decision);
    const { hash, outputId } = await recordOutput(
      db,
      t,
      p.sha,
      Number(row.generation),
      decision,
    );
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
      commentId = await publishComment(
        db,
        github,
        t,
        p.sha,
        decision,
        commentId,
        {
          last: observationError
            ? "unavailable (observation failed)"
            : (lastRead?.toISOString() ?? "unavailable"),
          next:
            exhausted || !unsettled
              ? null
              : new Date(
                  now.getTime() + Math.max(delay, backoff) * 1000,
                ).toISOString(),
        },
      );
      await tx.execute(
        sql`UPDATE warden_prs SET comment_id=${commentId},comment_hash=${hash},comment_updated_at=${now.toISOString()} WHERE key=${key}`,
      );
    }
    await db.execute(
      sql`UPDATE warden_outputs SET published=true WHERE id=${outputId}`,
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
          const { hash, outputId } = await recordOutput(
            db,
            t,
            sha,
            Number(current.generation),
            decision,
          );
          await recordDecision(
            tx,
            t,
            sha,
            Number(current.generation),
            decision,
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
            sql`UPDATE warden_outputs SET published=true WHERE id=${outputId}`,
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
