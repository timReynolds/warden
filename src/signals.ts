import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Policy } from "./config";
import type { Database } from "./db";
import { discoveryReset } from "./db/prs";
import type {
  Check,
  CommitStatus,
  Snapshot,
  Suite,
  Target,
  Workflow,
} from "./model";
import { targetKey } from "./model";

const checkEvent = z.object({
  id: z.number(),
  name: z.string(),
  head_sha: z.string(),
  app: z.object({ id: z.number() }),
  check_suite: z.object({ id: z.number() }).nullable().optional(),
  status: z.string(),
  conclusion: z.string().nullable(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
});
const statusEvent = z.object({
  id: z.number(),
  context: z.string(),
  sha: z.string(),
  state: z.string(),
  updated_at: z.string(),
  target_url: z.string().nullable().optional(),
});
const workflowEvent = z.object({
  id: z.number(),
  workflow_id: z.number(),
  name: z.string().nullable(),
  path: z.string(),
  check_suite_id: z.number(),
  head_sha: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  run_attempt: z.number().optional(),
  html_url: z.string(),
});
const suiteEvent = z.object({
  id: z.number(),
  app: z.object({ id: z.number() }),
  head_sha: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
});
export async function storeSignal(
  db: Pick<Database, "execute">,
  t: Target,
  event: string,
  payload: Record<string, unknown>,
) {
  let data: Check | CommitStatus | Workflow | Suite;
  let kind: string;
  if (event === "check_run") {
    const parsed = checkEvent.safeParse(payload.check_run);
    if (!parsed.success) return false;
    const c = parsed.data;
    data = {
      id: c.id,
      name: c.name,
      sha: c.head_sha,
      appId: c.app.id,
      suiteId: c.check_suite?.id ?? 0,
      status: c.status,
      conclusion: c.conclusion,
      updatedAt: c.completed_at ?? c.started_at ?? "",
      url: c.html_url ?? null,
    };
    kind = "checks";
    if (
      !data.updatedAt &&
      data.status !== "completed" &&
      typeof payload.deliveryId === "string"
    ) {
      // Without a source timestamp, a delayed creation and a queued rerun are
      // indistinguishable. Invalidate once per receipt, then require new stable
      // authoritative observations rather than retaining an unversioned overlay.
      const receipt =
        await db.execute(sql`INSERT INTO warden_audit(pr_key,kind,data)
        VALUES(${targetKey(t)},'unversioned_pending',${JSON.stringify({ delivery: payload.deliveryId, sha: data.sha, checkId: data.id })}::jsonb)
        ON CONFLICT DO NOTHING RETURNING id`);
      if (receipt.length)
        await db.execute(sql`UPDATE warden_prs SET
        generation=generation+1,${discoveryReset()},published_hash=NULL
        WHERE key=${targetKey(t)} AND (sha=${data.sha} OR merge_sha=${data.sha})`);
    }
  } else if (event === "status") {
    const parsed = statusEvent.safeParse(payload);
    if (!parsed.success) return false;
    const s = parsed.data;
    data = {
      id: s.id,
      context: s.context,
      sha: s.sha,
      state: s.state,
      updatedAt: s.updated_at,
      url: s.target_url ?? null,
    };
    kind = "statuses";
  } else if (event === "workflow_run") {
    const parsed = workflowEvent.safeParse(payload.workflow_run);
    if (!parsed.success) return false;
    const w = parsed.data;
    data = {
      id: w.id,
      workflowId: w.workflow_id,
      name: w.name ?? String(w.workflow_id),
      path: w.path.split("@")[0] ?? w.path,
      suiteId: w.check_suite_id,
      sha: w.head_sha,
      status: w.status,
      conclusion: w.conclusion,
      attempt: w.run_attempt ?? 1,
      url: w.html_url,
    };
    kind = "workflows";
  } else if (event === "check_suite") {
    const parsed = suiteEvent.safeParse(payload.check_suite);
    if (!parsed.success) return false;
    const s = parsed.data;
    data = {
      id: s.id,
      appId: s.app.id,
      sha: s.head_sha,
      status: s.status,
      conclusion: s.conclusion,
    };
    kind = "suites";
    if (s.status !== "completed" && typeof payload.deliveryId === "string") {
      const receipt =
        await db.execute(sql`INSERT INTO warden_audit(pr_key,kind,data)
        VALUES(${targetKey(t)},'unversioned_pending',${JSON.stringify({ delivery: payload.deliveryId, sha: data.sha, suiteId: data.id })}::jsonb)
        ON CONFLICT DO NOTHING RETURNING id`);
      if (receipt.length)
        await db.execute(sql`UPDATE warden_prs SET generation=generation+1,${discoveryReset()},published_hash=NULL
        WHERE key=${targetKey(t)} AND (sha=${data.sha} OR merge_sha=${data.sha})`);
    }
  } else return false;
  await db.execute(sql`INSERT INTO warden_signals(pr_key,sha,kind,identity,data) VALUES(${targetKey(t)},${data.sha},${kind},${String(data.id)},${JSON.stringify(data)}::jsonb)
 ON CONFLICT(pr_key,sha,kind,identity) DO UPDATE SET data=excluded.data,received_at=now()
 WHERE COALESCE((excluded.data->>'attempt')::integer,1) > COALESCE((warden_signals.data->>'attempt')::integer,1)
 OR (COALESCE((excluded.data->>'attempt')::integer,1) = COALESCE((warden_signals.data->>'attempt')::integer,1)
 AND (COALESCE(excluded.data->>'updatedAt','') > COALESCE(warden_signals.data->>'updatedAt','')
 OR (COALESCE(excluded.data->>'updatedAt','') = COALESCE(warden_signals.data->>'updatedAt','')
 AND ((warden_signals.data->>'status' IS DISTINCT FROM 'completed') OR (excluded.data->>'status'='completed')))))`);
  return true;
}
export async function applySignals(
  db: Pick<Database, "execute">,
  t: Target,
  s: Snapshot,
  policy: Policy,
  events = false,
): Promise<Snapshot> {
  const result: Snapshot = {
    checks: [...s.checks],
    statuses: [...s.statuses],
    workflows: [...s.workflows],
    suites: [...s.suites],
  };
  const subjects = [
    ...new Set(
      [...s.checks, ...s.statuses, ...s.suites, ...s.workflows].map(
        (item) => item.sha,
      ),
    ),
  ];
  const pr = (
    await db.execute(
      sql`SELECT sha,merge_sha FROM warden_prs WHERE key=${targetKey(t)}`,
    )
  )[0];
  if (pr?.sha) subjects.push(String(pr.sha));
  if (pr?.merge_sha) subjects.push(String(pr.merge_sha));
  if (!subjects.length) return result;
  const rows = await db.execute(
    sql`SELECT kind,data FROM warden_signals WHERE pr_key=${targetKey(t)} AND sha IN (${sql.join(
      [...new Set(subjects)].map((sha) => sql`${sha}`),
      sql`,`,
    )})`,
  );
  for (const row of rows) {
    if (typeof row.data !== "object" || row.data === null) continue;
    if (row.kind === "checks") {
      const c = row.data as Check;
      if (!subjects.includes(c.sha)) continue;
      const same = s.checks.filter(
        (v) =>
          v.sha === c.sha &&
          v.appId === c.appId &&
          v.name === c.name &&
          v.suiteId === c.suiteId,
      );
      const terminalFailure =
        c.status === "completed" &&
        !policy.checks.passing_conclusions.some(
          (value) => value === c.conclusion,
        );
      const sameId = same.find((v) => v.id === c.id);
      if (sameId && c.updatedAt > sameId.updatedAt) {
        const at = result.checks.findIndex(
          (v) => v.id === c.id && v.sha === c.sha,
        );
        if (at >= 0)
          result.checks[at] = {
            ...sameId,
            ...c,
            status: events || terminalFailure ? c.status : "queued",
            conclusion: events || terminalFailure ? c.conclusion : null,
          };
        continue;
      }
      if (
        terminalFailure &&
        sameId &&
        sameId.status !== "completed" &&
        c.updatedAt >= sameId.updatedAt
      ) {
        const at = result.checks.findIndex(
          (v) => v.id === c.id && v.sha === c.sha,
        );
        if (at >= 0) result.checks[at] = { ...sameId, ...c };
        continue;
      }
      if (same.some((v) => v.id >= c.id)) continue;
      // A success notification is a signal, never authoritative passing evidence.
      result.checks.push({
        ...c,
        status: events || terminalFailure ? c.status : "queued",
        conclusion: events || terminalFailure ? c.conclusion : null,
      });
    } else if (row.kind === "statuses") {
      const status = row.data as CommitStatus;
      if (!subjects.includes(status.sha)) continue;
      const same = s.statuses.filter(
        (v) => v.sha === status.sha && v.context === status.context,
      );
      if (
        same.some(
          (v) =>
            v.updatedAt > status.updatedAt ||
            (v.updatedAt === status.updatedAt && v.id >= status.id),
        )
      )
        continue;
      result.statuses.push({
        ...status,
        state:
          events || ["failure", "error"].includes(status.state)
            ? status.state
            : "pending",
      });
    } else if (row.kind === "workflows") {
      const w = row.data as Workflow;
      if (!subjects.includes(w.sha)) continue;
      if (
        s.workflows.some(
          (v) =>
            v.sha === w.sha &&
            v.workflowId === w.workflowId &&
            (v.id > w.id ||
              (v.id === w.id &&
                (v.attempt > w.attempt ||
                  (v.attempt === w.attempt &&
                    (!events || v.status === "completed"))))),
        )
      )
        continue;
      result.workflows = result.workflows.filter(
        (v) => v.id !== w.id || v.sha !== w.sha,
      );
      result.workflows.push(
        events ? w : { ...w, status: "queued", conclusion: null },
      );
    } else if (row.kind === "suites") {
      const suite = row.data as Suite;
      const previous = result.suites.find(
        (v) => v.id === suite.id && v.sha === suite.sha,
      );
      // Suites have no attempt/timestamp. A terminal API read wins over delayed
      // queued receipts; any new pending receipt requires a fresh scan instead.
      if (previous?.status === "completed") continue;
      result.suites = result.suites.filter(
        (v) => v.id !== suite.id || v.sha !== suite.sha,
      );
      result.suites.push(
        events ? suite : { ...suite, status: "queued", conclusion: null },
      );
    }
  }
  return result;
}
