import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Target } from "../model";
import type { Database } from "./index";
export type Job = {
  id: string;
  key: string;
  kind: "delivery" | "reconcile";
  payload: Record<string, unknown>;
  generation: number;
  attempts: number;
  lease_token: string;
};
export async function ingest(
  db: Database,
  id: string,
  event: string,
  payload: Record<string, unknown>,
) {
  return db.transaction(async (tx) => {
    const inserted = await tx.execute(
      sql`INSERT INTO warden_deliveries(id,event,payload) VALUES(${id},${event},${JSON.stringify(payload)}::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
    );
    if (!inserted.length) return false;
    await tx.execute(
      sql`INSERT INTO warden_jobs(key,kind,payload) VALUES(${`delivery:${id}`},'delivery',${JSON.stringify({ ...payload, deliveryId: id, event })}::jsonb)`,
    );
    await tx.execute(
      sql`INSERT INTO warden_metrics(name,value) VALUES('deliveries_accepted',1) ON CONFLICT(name) DO UPDATE SET value=warden_metrics.value+1`,
    );
    return true;
  });
}
export async function enqueue(
  db: Pick<Database, "execute">,
  t: Target,
  delaySeconds = 0,
  renew = false,
  events = false,
) {
  const key = `${events ? "evaluate" : "reconcile"}:${t.installationId}/${t.repositoryId}#${t.number}`;
  const payload = {
    ...t,
    ...(renew ? { wardenRenew: true } : {}),
    ...(events ? { wardenObservation: "events" } : {}),
  };
  await db.execute(sql`INSERT INTO warden_jobs(key,kind,payload,available_at) VALUES(${key},'reconcile',${JSON.stringify(payload)}::jsonb,now()+${delaySeconds}*interval '1 second')
 ON CONFLICT(key) DO UPDATE SET payload=excluded.payload || CASE WHEN NOT warden_jobs.completed AND COALESCE((warden_jobs.payload->>'wardenRenew')::boolean,false) THEN '{"wardenRenew":true}'::jsonb ELSE '{}'::jsonb END,generation=warden_jobs.generation+1,completed=false,dead=false,attempts=0,available_at=least(warden_jobs.available_at,excluded.available_at),updated_at=now()`);
}
export async function claim(
  db: Database,
  leaseSeconds: number,
): Promise<Job | undefined> {
  const token = randomUUID();
  const rows =
    await db.execute(sql`UPDATE warden_jobs SET lease_token=${token}::uuid,lease_until=now()+${leaseSeconds}*interval '1 second',attempts=attempts+1,updated_at=now()
 WHERE id=(SELECT id FROM warden_jobs WHERE NOT completed AND NOT dead AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
 RETURNING id,key,kind,payload,generation,attempts,lease_token`);
  return rows[0] as Job | undefined;
}
export async function heartbeat(db: Database, job: Job, leaseSeconds: number) {
  const rows = await db.execute(
    sql`UPDATE warden_jobs SET lease_until=now()+${leaseSeconds}*interval '1 second' WHERE id=${job.id}::uuid AND lease_token=${job.lease_token}::uuid RETURNING id`,
  );
  if (!rows.length) throw new Error("Warden job lease lost");
}
export async function finish(
  db: Database,
  job: Job,
  delaySeconds: number | null = null,
) {
  await db.execute(sql`UPDATE warden_jobs SET
 payload=CASE WHEN generation<>${job.generation} THEN payload ELSE payload-'wardenRenew' END,
 completed=CASE WHEN generation<>${job.generation} THEN false ELSE ${delaySeconds === null} END,
 available_at=CASE WHEN generation<>${job.generation} THEN now() ELSE now()+${delaySeconds ?? 0}*interval '1 second' END,
 attempts=0,lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=now()
 WHERE id=${job.id}::uuid AND lease_token=${job.lease_token}::uuid`);
}
export async function fail(db: Database, job: Job, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const retryAfter =
    typeof error === "object" &&
    error !== null &&
    "retryAfter" in error &&
    typeof error.retryAfter === "number"
      ? error.retryAfter
      : 0;
  const delay = Math.max(
    retryAfter,
    Math.min(300, 2 ** Math.min(job.attempts, 8)),
  );
  await db.execute(sql`UPDATE warden_jobs SET
 dead=CASE WHEN generation<>${job.generation} THEN false ELSE attempts>=8 END,
 attempts=CASE WHEN generation<>${job.generation} THEN 0 ELSE attempts END,
 lease_token=NULL,lease_until=NULL,available_at=now()+${delay}*interval '1 second',last_error=${message.slice(0, 2000)},updated_at=now()
 WHERE id=${job.id}::uuid AND lease_token=${job.lease_token}::uuid`);
}
