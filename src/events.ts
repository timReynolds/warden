import { AsyncLocalStorage } from "node:async_hooks";
import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./db";
import {
  discoveryReset,
  ensurePr,
  lockCurrentHead,
  lockHeads,
  lockLifecycle,
} from "./db/prs";
import { enqueue, type Job } from "./db/queue";
import type { GitHub } from "./github";
import {
  changeLifecycle,
  lifecycleActive,
  onboardInstallation,
  onboardRepository,
} from "./installations";
import {
  ACTION_ID,
  BYPASS_LABEL,
  CHECK_NAME,
  type Target,
  targetKey,
} from "./model";
import { configFor } from "./reconcile";
import { storeSignal } from "./signals";

const repository = z.object({
  id: z.number(),
  name: z.string(),
  owner: z.object({ login: z.string() }),
});
const repositoryReference = z.object({
  id: z.number(),
  name: z.string().optional(),
  full_name: z.string().optional(),
  owner: z.object({ login: z.string() }).optional(),
});
const envelope = z.object({
  event: z.string(),
  action: z.string().optional(),
  installation: z.object({ id: z.number() }),
  repository: repository.optional(),
  sender: z.object({ login: z.string() }).optional(),
  pull_request: z
    .object({ number: z.number(), head: z.object({ sha: z.string() }) })
    .optional(),
  label: z.object({ name: z.string() }).optional(),
  check_run: z
    .object({
      id: z.number(),
      name: z.string(),
      head_sha: z.string(),
      app: z.object({ id: z.number() }),
    })
    .optional(),
  check_suite: z
    .object({ head_sha: z.string(), app: z.object({ id: z.number() }) })
    .optional(),
  workflow_run: z.object({ head_sha: z.string() }).optional(),
  sha: z.string().optional(),
  requested_action: z.object({ identifier: z.string() }).optional(),
  repositories_added: z.array(repositoryReference).optional(),
  repositories_removed: z.array(repositoryReference).optional(),
});
async function renewSharedPeers(
  db: Database,
  t: Target,
  heads: string[],
  excluded: number[] = [],
  failedJob: string | null = null,
) {
  if (!heads.length) return;
  const peers = await db.execute(
    sql`SELECT number FROM warden_prs WHERE installation_id=${t.installationId} AND repository_id=${t.repositoryId} AND state='open' AND sha IN (${sql.join(
      [...new Set(heads)].map((head) => sql`${head}`),
      sql`,`,
    )})`,
  );
  for (const peer of peers) {
    const number = Number(peer.number);
    if (excluded.includes(number)) continue;
    const target = { ...t, number };
    await db.transaction(async (tx) => {
      await lockLifecycle(tx, target);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${targetKey(target)},0))`,
      );
      await lockCurrentHead(tx, target);
      const added = failedJob
        ? await tx.execute(
            sql`UPDATE warden_prs SET delivery_error_jobs=array_append(delivery_error_jobs,${failedJob}::uuid) WHERE key=${targetKey(target)} AND NOT ${failedJob}::uuid=ANY(delivery_error_jobs) RETURNING key`,
          )
        : null;
      if (!added || added.length)
        await tx.execute(
          sql`UPDATE warden_prs SET ${discoveryReset()} WHERE key=${targetKey(target)}`,
        );
      await enqueue(tx, target);
    });
  }
}
const handledEvents = [
  "pull_request",
  "check_run",
  "check_suite",
  "workflow_run",
  "status",
  "push",
  "installation",
  "installation_repositories",
  "repository",
] as const;
const processors = new WeakMap<
  GitHub,
  (db: Database, job: Job) => Promise<void>
>();

function createDeliveryProcessor(github: GitHub) {
  const context = new AsyncLocalStorage<{ db: Database; job: Job }>();
  github.webhooks.on([...handledEvents], async ({ octokit, payload }) => {
    const delivery = context.getStore();
    if (!delivery) throw new Error("Warden delivery missing durable job");
    const installationId =
      "installation" in payload ? payload.installation?.id : undefined;
    if (!installationId) throw new Error("Warden event missing installation");
    await github.withClient(
      installationId,
      () => handleDelivery(delivery.db, github, delivery.job),
      octokit,
    );
  });
  return async (db: Database, job: Job) => {
    try {
      // Signed ingress already persisted this payload; runtime fields used by
      // the gate are still validated in handleDelivery, not trusted from types.
      await context.run({ db, job }, () =>
        github.webhooks.receive({
          id: String(job.payload.deliveryId),
          name: String(job.payload.event),
          payload: job.payload,
        } as EmitterWebhookEvent),
      );
    } catch (error) {
      // SDK dispatch groups handler errors. Preserve durable Retry-After.
      if (error instanceof AggregateError && error.errors.length === 1)
        throw error.errors[0];
      throw error;
    }
  };
}

export async function processDelivery(db: Database, github: GitHub, job: Job) {
  let process = processors.get(github);
  if (!process) {
    process = createDeliveryProcessor(github);
    processors.set(github, process);
  }
  return process(db, job);
}

async function handleDelivery(db: Database, github: GitHub, job: Job) {
  const event = String(job.payload.event);
  const e = envelope.parse(job.payload);
  await db.execute(
    sql`INSERT INTO warden_installations(id,state) VALUES(${e.installation.id},'active') ON CONFLICT DO NOTHING`,
  );
  if (event === "installation") {
    if (
      [
        "created",
        "unsuspend",
        "new_permissions_accepted",
        "deleted",
        "suspend",
      ].includes(e.action ?? "")
    ) {
      const state = await changeLifecycle(db, e.installation.id, null, () =>
        github.installationState(e.installation.id),
      );
      if (state === "active")
        await onboardInstallation(db, github, e.installation.id);
    }
    return;
  }
  if (event === "installation_repositories") {
    for (const r of e.repositories_removed ?? []) {
      const known = (
        await db.execute(
          sql`SELECT owner,name FROM warden_repositories WHERE installation_id=${e.installation.id} AND id=${r.id}`,
        )
      )[0];
      await changeLifecycle(db, e.installation.id, r.id, () =>
        github.repository({
          installationId: e.installation.id,
          repositoryId: r.id,
          owner:
            r.owner?.login ??
            r.full_name?.split("/")[0] ??
            (typeof known?.owner === "string" ? known.owner : ""),
          repo:
            r.name ??
            r.full_name?.split("/")[1] ??
            (typeof known?.name === "string" ? known.name : ""),
          number: 0,
        }),
      );
    }
    for (const r of e.repositories_added ?? []) {
      const owner = r.owner?.login ?? r.full_name?.split("/")[0];
      const repo = r.name ?? r.full_name?.split("/")[1];
      if (!owner || !repo)
        throw new Error("Added repository lacks its full identity");
      await onboardRepository(db, github, {
        owner,
        repo,
        repositoryId: r.id,
        installationId: e.installation.id,
        number: 0,
      });
    }
    return;
  }
  const installationState = (
    await db.execute(
      sql`SELECT state FROM warden_installations WHERE id=${e.installation.id}`,
    )
  )[0];
  if (installationState?.state !== "active") return;
  if (!e.repository) throw new Error("Warden event missing repository");
  const t: Target = {
    owner: e.repository.owner.login,
    repo: e.repository.name,
    repositoryId: e.repository.id,
    installationId: e.installation.id,
    number: e.pull_request?.number ?? 0,
  };
  await db.execute(
    sql`INSERT INTO warden_repositories(installation_id,id,owner,name,state) VALUES(${t.installationId},${t.repositoryId},${t.owner},${t.repo},'active') ON CONFLICT(installation_id,id) DO NOTHING`,
  );
  if (
    event === "repository" &&
    ["deleted", "archived", "unarchived"].includes(e.action ?? "")
  ) {
    await changeLifecycle(db, t.installationId, t.repositoryId, () =>
      github.repository(t),
    );
    if (await lifecycleActive(db, t)) await onboardRepository(db, github, t);
    return;
  }
  if (event === "pull_request" && e.pull_request) {
    const heads: string[] = [];
    await db.transaction(async (tx) => {
      await lockLifecycle(tx, t);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${targetKey(t)},0))`,
      );
      const persisted = (
        await tx.execute(
          sql`SELECT payload->'wardenAffectedHeads' AS heads FROM warden_jobs WHERE id=${job.id}::uuid`,
        )
      )[0];
      const pendingHeads = z.array(z.string()).safeParse(persisted?.heads);
      if (pendingHeads.success) heads.push(...pendingHeads.data);
      const previous = (
        await tx.execute(
          sql`SELECT sha FROM warden_prs WHERE key=${targetKey(t)}`,
        )
      )[0];
      if (typeof previous?.sha === "string") heads.push(previous.sha);
      const p = await github.pull(t);
      t.owner = p.owner;
      t.repo = p.repo;
      heads.push(p.sha);
      await lockHeads(tx, t, heads);
      if (!(await lifecycleActive(tx, t))) return;
      await ensurePr(tx, t, p);
      await tx.execute(
        sql`UPDATE warden_repositories SET owner=${p.owner},name=${p.repo} WHERE installation_id=${t.installationId} AND id=${t.repositoryId}`,
      );
      await tx.execute(
        sql`UPDATE warden_jobs SET payload=payload || ${JSON.stringify({ wardenAffectedHeads: [...new Set(heads)] })}::jsonb WHERE id=${job.id}::uuid`,
      );
      if (
        ["labeled", "unlabeled"].includes(e.action ?? "") &&
        e.label?.name === BYPASS_LABEL
      ) {
        let currentGrant = false;
        const clearGrant = () =>
          tx.execute(
            sql`UPDATE warden_prs SET bypass_actor=NULL,bypass_sha=NULL,bypass_application_id=NULL WHERE key=${targetKey(t)}`,
          );
        try {
          const application = p.labels.includes(BYPASS_LABEL)
            ? await github.labelApplication(t, BYPASS_LABEL)
            : null;
          const grant = (
            await tx.execute(
              sql`SELECT bypass_actor,bypass_sha,bypass_application_id FROM warden_prs WHERE key=${targetKey(t)}`,
            )
          )[0];
          currentGrant =
            application !== null &&
            grant?.bypass_sha === p.sha &&
            grant.bypass_application_id === application.id &&
            grant.bypass_actor === application.actor;
          if (!currentGrant) await clearGrant();
          if (e.action === "unlabeled") {
            await tx.execute(
              sql`INSERT INTO warden_audit(pr_key,kind,data) VALUES(${targetKey(t)},'bypass_removed',${JSON.stringify({ actor: e.sender?.login ?? null, delivery: job.payload.deliveryId, sha: p.sha, revoked: !currentGrant })}::jsonb)`,
            );
          } else {
            if (
              !e.sender ||
              p.sha !== e.pull_request?.head.sha ||
              !application ||
              application.actor !== e.sender.login
            )
              throw new Error(
                "Current label application does not match the webhook actor/head",
              );
            const policy = await configFor(db, github, t, p.baseSha);
            const permission = await github.permission(t, e.sender.login);
            const authorized = policy.bypass.allowed_permissions.some(
              (v) => v === permission,
            );
            await tx.execute(
              sql`INSERT INTO warden_audit(pr_key,kind,data) VALUES(${targetKey(t)},'bypass_application',${JSON.stringify({ actor: e.sender.login, permission, authorized, applicationId: application.id, delivery: job.payload.deliveryId, sha: p.sha, configRevision: p.baseSha })}::jsonb)`,
            );
            if (authorized)
              await tx.execute(
                sql`UPDATE warden_prs SET bypass_actor=${e.sender.login},bypass_sha=${p.sha},bypass_application_id=${application.id} WHERE key=${targetKey(t)} AND sha=${p.sha}`,
              );
            else await clearGrant();
          }
        } catch (error) {
          // Delayed events cannot revoke a newer grant which still matches the
          // authoritative current application. Unverifiable state fails closed.
          if (!currentGrant) await clearGrant();
          await tx.execute(
            sql`INSERT INTO warden_audit(pr_key,kind,data) VALUES(${targetKey(t)},'bypass_unverifiable',${JSON.stringify({ actor: e.sender?.login ?? null, authorized: false, error: error instanceof Error ? error.message : String(error), delivery: job.payload.deliveryId, sha: p.sha })}::jsonb)`,
          );
        }
      }
      if (["labeled", "unlabeled", "reopened"].includes(e.action ?? ""))
        await tx.execute(
          sql`UPDATE warden_prs SET window_start=clock_timestamp(),published_hash=NULL WHERE key=${targetKey(t)}`,
        );
    });
    await renewSharedPeers(db, t, heads, [t.number]);
    await enqueue(db, t);
    return;
  }
  const intentional = e.check_run?.app.id === github.appId;
  if (intentional) {
    if (
      !(
        (e.action === "requested_action" &&
          e.requested_action?.identifier === ACTION_ID) ||
        e.action === "rerequested"
      ) ||
      e.check_run?.name !== CHECK_NAME ||
      !e.sender
    )
      return;
    const permission = await github.permission(t, e.sender.login);
    if (!["write", "maintain", "admin"].includes(permission)) return;
  }
  if (e.check_suite?.app.id === github.appId) return;
  const sha =
    e.check_run?.head_sha ??
    e.check_suite?.head_sha ??
    e.workflow_run?.head_sha ??
    e.sha;
  let numbers: number[] = [];
  if (sha) {
    const known = await db.execute(
      sql`SELECT number FROM warden_prs WHERE installation_id=${t.installationId} AND repository_id=${t.repositoryId} AND (sha=${sha} OR merge_sha=${sha}) AND state='open'`,
    );
    numbers = known.length
      ? known.map((r) => Number(r.number))
      : await github.associated(t, sha);
  } else if (event === "push" || event === "repository") {
    const rows = await db.execute(
      sql`SELECT number FROM warden_prs WHERE installation_id=${t.installationId} AND repository_id=${t.repositoryId} AND state='open'`,
    );
    numbers = rows.map((r) => Number(r.number));
  }
  if (numbers.length) {
    const subjects = await db.execute(
      sql`SELECT DISTINCT sha FROM warden_prs WHERE installation_id=${t.installationId} AND repository_id=${t.repositoryId} AND number IN (${sql.join(
        numbers.map((number) => sql`${number}`),
        sql`,`,
      )}) AND state='open'`,
    );
    await renewSharedPeers(
      db,
      t,
      subjects.map((row) => String(row.sha)),
      numbers,
    );
    if (intentional && sha) {
      await db.transaction(async (tx) => {
        await lockLifecycle(tx, t);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${t.installationId}/${t.repositoryId}:${sha}`},1))`,
        );
        await tx.execute(
          sql`UPDATE warden_gates SET published_hash=NULL WHERE installation_id=${t.installationId} AND repository_id=${t.repositoryId} AND sha=${sha}`,
        );
      });
    }
  }
  for (const number of numbers) {
    const target = { ...t, number };
    await db.transaction(async (tx) => {
      await lockLifecycle(tx, target);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${targetKey(target)},0))`,
      );
      await lockCurrentHead(tx, target);
      if (intentional) {
        await tx.execute(
          sql`UPDATE warden_prs SET ${discoveryReset()},published_hash=NULL WHERE key=${targetKey(target)}`,
        );
        await tx.execute(
          sql`INSERT INTO warden_audit(pr_key,kind,data) VALUES(${targetKey(target)},'manual_reconcile',${JSON.stringify({ actor: e.sender?.login, delivery: job.payload.deliveryId, sha })}::jsonb)`,
        );
      }
      let tracked = false;
      if (!intentional) {
        tracked = await storeSignal(tx, target, event, job.payload);
        if (
          ["check_run", "check_suite", "workflow_run", "status"].includes(event)
        )
          await tx.execute(
            sql`UPDATE warden_prs SET window_start=clock_timestamp() WHERE key=${targetKey(target)}`,
          );
      }
      await enqueue(tx, target, 0, false, tracked);
    });
  }
}

export async function recoverFailedDelivery(db: Database, job: Job) {
  const parsed = envelope.safeParse(job.payload);
  if (!parsed.success) return;
  const e = parsed.data;
  if (!handledEvents.some((event) => event === e.event)) return;
  const repositoryIds = [
    ...(e.repositories_added ?? []),
    ...(e.repositories_removed ?? []),
  ].map((repo) => repo.id);
  const members = await db.execute(
    sql`SELECT owner,repo,number,installation_id,repository_id,sha FROM warden_prs WHERE installation_id=${e.installation.id} AND state='open' ${
      e.repository
        ? sql`AND repository_id=${e.repository.id}`
        : repositoryIds.length
          ? sql`AND repository_id IN (${sql.join(
              repositoryIds.map((id) => sql`${id}`),
              sql`,`,
            )})`
          : sql``
    } ${e.pull_request ? sql`AND (number=${e.pull_request.number} OR sha=${e.pull_request.head.sha})` : sql``}`,
  );
  const groups = new Map<string, { t: Target; heads: string[] }>();
  for (const member of members) {
    const target: Target = {
      installationId: e.installation.id,
      repositoryId: Number(member.repository_id),
      owner: String(member.owner),
      repo: String(member.repo),
      number: Number(member.number),
    };
    const key = `${target.repositoryId}:${member.sha}`;
    groups.set(key, { t: target, heads: [String(member.sha)] });
  }
  if (e.repository && e.pull_request) {
    const target = {
      installationId: e.installation.id,
      repositoryId: e.repository.id,
      owner: e.repository.owner.login,
      repo: e.repository.name,
      number: e.pull_request.number,
    };
    groups.set(`${target.repositoryId}:${e.pull_request.head.sha}`, {
      t: target,
      heads: [e.pull_request.head.sha],
    });
    await enqueue(db, target);
  }
  for (const group of groups.values())
    await renewSharedPeers(db, group.t, group.heads, [], job.id);
}
