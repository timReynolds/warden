import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./db";
import { claim, enqueue, fail, finish, heartbeat } from "./db/queue";
import type { Env } from "./env";
import { processDelivery, recoverFailedDelivery } from "./events";
import { GitHub } from "./github";
import { type Controls, reconcile } from "./reconcile";

const target = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
});
export async function workOnce(
  db: Database,
  github: GitHub,
  leaseSeconds = 60,
  controls?: Controls,
): Promise<boolean> {
  const job = await claim(db, leaseSeconds);
  if (!job) return false;
  console.log(
    JSON.stringify({
      service: "warden-worker",
      event: "job_started",
      job: job.id,
      key: job.key,
      generation: job.generation,
      attempt: job.attempts,
    }),
  );
  let lost = false;
  const timer = setInterval(
    () => {
      heartbeat(db, job, leaseSeconds).catch((error) => {
        lost = true;
        console.error("Warden lease heartbeat", String(error));
      });
    },
    (leaseSeconds * 1000) / 3,
  );
  try {
    let delay: number | null = null;
    if (job.kind === "delivery") await processDelivery(db, github, job);
    else {
      const currentTarget = target.parse(job.payload);
      const events = job.payload.wardenObservation === "events";
      delay = await github.withClient(currentTarget.installationId, () =>
        reconcile(
          db,
          github,
          currentTarget,
          controls,
          job.payload.wardenRenew === true,
          events,
        ),
      );
      // Event bursts coalesce independently of scheduled recovery. A fast
      // update must not postpone or consume the durable full-read job.
      if (events) {
        if (delay !== null) await enqueue(db, currentTarget, delay);
        delay = null;
      }
    }
    if (lost) throw new Error("Warden job lease lost");
    await finish(db, job, delay);
    const metric =
      job.kind === "delivery"
        ? "deliveries_processed"
        : job.payload.wardenObservation === "events"
          ? "event_evaluations_completed"
          : "reconciliations_completed";
    await db.execute(
      sql`INSERT INTO warden_metrics(name,value) VALUES(${metric},1) ON CONFLICT(name) DO UPDATE SET value=warden_metrics.value+1`,
    );
    await db.execute(
      sql`INSERT INTO warden_metrics(name,value) VALUES('jobs_completed',1) ON CONFLICT(name) DO UPDATE SET value=warden_metrics.value+1`,
    );
  } catch (error) {
    if (job.kind === "delivery") {
      try {
        await recoverFailedDelivery(db, job);
      } catch (recoveryError) {
        console.error(
          "Warden delivery recovery failed",
          job.key,
          recoveryError instanceof Error
            ? recoveryError.message
            : String(recoveryError),
        );
      }
    }
    console.error(
      "Warden job failed",
      job.key,
      error instanceof Error ? error.message : String(error),
    );
    await fail(db, job, error);
  } finally {
    clearInterval(timer);
  }
  return true;
}
export function createGitHub(db: Database, env: Env) {
  return new GitHub(env, async (route, status) => {
    await db.execute(
      sql`INSERT INTO warden_metrics(name,value) VALUES('github_requests',1) ON CONFLICT(name) DO UPDATE SET value=warden_metrics.value+1`,
    );
    if (status === 429 || status === 403)
      await db.execute(
        sql`INSERT INTO warden_metrics(name,value) VALUES('github_rate_limits',1) ON CONFLICT(name) DO UPDATE SET value=warden_metrics.value+1`,
      );
    console.log(
      JSON.stringify({
        service: "warden-worker",
        event: "github_request",
        route,
        status,
      }),
    );
  });
}

export async function runWorker(
  db: Database,
  github: GitHub,
  env: Env,
  signal: AbortSignal,
) {
  console.log("Warden worker started");
  while (!signal.aborted) {
    try {
      if (!(await workOnce(db, github, env.WARDEN_JOB_LEASE_SECONDS)))
        await Bun.sleep(env.WARDEN_WORKER_POLL_MS);
    } catch (error) {
      console.error("Warden worker database error", String(error));
      await Bun.sleep(1000);
    }
  }
}
