import { Webhooks } from "@octokit/webhooks";
import { sql } from "drizzle-orm";
import { connect } from "../src/db";
import { CHECK_NAME, COMMENT_MARKER } from "../src/model";
import { type FixtureState, fixtureCheck } from "./github";

const github = process.env.WARDEN_GITHUB_API_URL ?? "http://github:4000";
const api = process.env.WARDEN_API_URL ?? "http://api:3000";
const secret =
  process.env.WARDEN_WEBHOOK_SECRET ?? "warden-local-webhook-secret";
const webhooks = new Webhooks({ secret });
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL required; demo uses real Postgres");
const { db, close } = connect(url);
const phase = process.argv[2] ?? "main";
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(`Demo assertion failed: ${message}`);
};
async function state(): Promise<FixtureState> {
  const r = await fetch(`${github}/__state`);
  if (!r.ok) throw new Error("Fixture unavailable");
  return r.json();
}
async function patch(data: Partial<FixtureState>) {
  const r = await fetch(`${github}/__state`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  assert(r.ok, "fixture update");
}
async function event(
  name: string,
  data: Record<string, unknown> = {},
  deliveryId = crypto.randomUUID(),
) {
  const s = await state();
  if (
    name === "pull_request" &&
    ["labeled", "unlabeled"].includes(String(data.action))
  ) {
    const actor = data.sender as { login: string } | undefined;
    await patch({
      timeline: s.timeline.concat({
        id: s.nextId,
        issue: 1,
        event: String(data.action),
        created_at: new Date().toISOString(),
        actor: { login: actor?.login ?? "alice" },
        label: { name: "skip warden" },
      }),
      nextId: s.nextId + 1,
    });
  }
  const body = JSON.stringify({
    installation: { id: 1 },
    repository: { id: 10, name: "repo", owner: { login: "acme" } },
    sender: { login: "alice" },
    action: "opened",
    pull_request: s.prs[0],
    ...data,
  });
  const r = await fetch(`${api}/webhooks/github`, {
    method: "POST",
    headers: {
      "x-github-event": name,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": await webhooks.sign(body),
      "content-type": "application/json",
    },
    body,
  });
  assert(r.status === 202, "signed durable webhook acceptance");
  return deliveryId;
}
async function waitFor(
  predicate: (s: FixtureState) => boolean,
  message: string,
) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const s = await state();
    if (predicate(s)) {
      console.log(JSON.stringify({ scenario: message, result: "pass" }));
      return s;
    }
    await Bun.sleep(100);
  }
  throw new Error(`Demo timed out: ${message}`);
}
const gate = (s: FixtureState) =>
  s.checks.filter((c) => c.name === CHECK_NAME).at(-1);
async function main() {
  await fetch(`${github}/__reset`, { method: "POST" });
  // A fresh dedicated Compose project is required; do not erase historical data.
  assert(
    (await db.execute(sql`SELECT id FROM warden_deliveries LIMIT 1`)).length ===
      0,
    "fresh demo database; use a new WARDEN_DEMO_PROJECT for each full run",
  );
  await patch({
    checks: [fixtureCheck(1, null, "in_progress")],
    statuses: [
      {
        id: 1,
        context: "deploy",
        state: "pending",
        sha: "a".repeat(40),
        updated_at: new Date().toISOString(),
        target_url: "http://github.local/deploy",
      },
    ],
  });
  const delivery = await event("pull_request");
  await event("pull_request", {}, delivery);
  await waitFor(
    (s) => gate(s)?.status === "in_progress" && s.comments.length === 1,
    "discovery/running and one sticky comment",
  );
  let s = await state();
  await patch({
    checks: s.checks.map((c) => (c.id === 1 ? fixtureCheck(1) : c)),
    statuses: [
      {
        id: 2,
        context: "deploy",
        state: "success",
        sha: "a".repeat(40),
        updated_at: new Date().toISOString(),
        target_url: null,
      },
    ],
  });
  await event("status", { sha: "a".repeat(40), pull_request: undefined });
  await waitFor(
    (s) => gate(s)?.status === "completed" && gate(s)?.conclusion === "success",
    "checks plus status and final verification success",
  );
  s = await state();
  await patch({
    checks: s.checks
      .filter((c) => c.app.id === 1)
      .concat([
        fixtureCheck(10, "failure"),
        fixtureCheck(11, null, "in_progress", "lint"),
      ]),
  });
  await event("check_run", {
    action: "completed",
    check_run: fixtureCheck(10, "failure"),
    pull_request: undefined,
    pull_requests: [],
  });
  await waitFor(
    (s) =>
      gate(s)?.status === "completed" &&
      gate(s)?.conclusion === "failure" &&
      s.comments[0]?.body.includes("Checks failed") === true,
    "early failure while another check runs",
  );
  s = await state();
  await patch({ checks: s.checks.concat(fixtureCheck(12, null, "queued")) });
  await event("check_run", {
    action: "created",
    check_run: fixtureCheck(12, null, "queued"),
    pull_request: undefined,
  });
  await waitFor(
    (s) => gate(s)?.status === "in_progress",
    "queued rerun supersedes failure",
  );
  s = await state();
  await patch({
    checks: s.checks.map((c) =>
      c.id === 12
        ? fixtureCheck(12)
        : c.id === 11
          ? fixtureCheck(11, "success", "completed", "lint")
          : c,
    ),
  });
  // Deliberately omit completion delivery: persisted bounded reconciliation repairs it.
  await waitFor(
    (s) => gate(s)?.status === "completed" && gate(s)?.conclusion === "success",
    "passing rerun and missed completion recovery",
  );
  s = await state();
  await patch({
    checks: s.checks.concat(fixtureCheck(13, "failure")),
    prs: s.prs.map((p) => ({ ...p, labels: [{ name: "skip warden" }] })),
  });
  await event("pull_request", {
    action: "labeled",
    label: { name: "skip warden" },
    sender: { login: "mallory" },
  });
  await waitFor(
    (s) => gate(s)?.status === "completed" && gate(s)?.conclusion === "failure",
    "unauthorized bypass remains blocked",
  );
  s = await state();
  await patch({ prs: s.prs.map((p) => ({ ...p, labels: [] })) });
  await event("pull_request", {
    action: "unlabeled",
    label: { name: "skip warden" },
  });
  s = await state();
  await patch({
    prs: s.prs.map((p) => ({ ...p, labels: [{ name: "skip warden" }] })),
  });
  await event("pull_request", {
    action: "labeled",
    label: { name: "skip warden" },
    sender: { login: "alice" },
  });
  await waitFor(
    (s) =>
      gate(s)?.status === "completed" &&
      gate(s)?.conclusion === "success" &&
      s.comments[0]?.body.includes("Bypassed via skip warden") === true,
    "authorized bypass",
  );
  s = await state();
  await patch({ prs: s.prs.map((p) => ({ ...p, labels: [] })) });
  await event("pull_request", {
    action: "unlabeled",
    label: { name: "skip warden" },
  });
  await waitFor(
    (s) => gate(s)?.status === "completed" && gate(s)?.conclusion === "failure",
    "bypass removal restores normal gating",
  );
  const histories = await db.execute(
    sql`SELECT (SELECT count(*) FROM warden_deliveries) AS events,(SELECT count(*) FROM warden_observations) AS observations,(SELECT count(*) FROM warden_decisions) AS decisions,(SELECT count(*) FROM warden_audit) AS audits,(SELECT count(*) FROM warden_effects) AS effects`,
  );
  assert(
    Number(histories[0]?.events) > 5 &&
      Number(histories[0]?.decisions) > 5 &&
      Number(histories[0]?.audits) >= 3,
    "retained pipeline history",
  );
  s = await state();
  assert(
    s.comments.length === 1 && s.comments[0]?.body.startsWith(COMMENT_MARKER),
    "one app-owned sticky comment",
  );
  assert(
    s.checks.filter((c) => c.name === CHECK_NAME).length === 1,
    "one aggregate run on this generation",
  );
  console.log(
    JSON.stringify({
      scenario: "retained history",
      result: "pass",
      counts: histories[0],
      githubRequests: s.requests.length,
    }),
  );
}
async function prepareRestart() {
  const s = await state();
  // A synchronize event represents a new head. Give recovery a fresh subject
  // rather than expecting a same-head event to renew an expired deadline.
  const sha = "d".repeat(40);
  await patch({
    prs: s.prs.map((pr) => ({ ...pr, head: { ...pr.head, sha } })),
    checks: s.checks.map((c) =>
      c.app.id === 1
        ? c
        : fixtureCheck(c.id, "success", "completed", c.name, sha),
    ),
    statuses: s.statuses.map((status) => ({ ...status, sha })),
  });
  const id = await event("pull_request", { action: "synchronize" });
  assert(
    (await db.execute(sql`SELECT id FROM warden_deliveries WHERE id=${id}`))
      .length === 1,
    "webhook persisted while worker stopped",
  );
  assert(
    (
      await db.execute(
        sql`SELECT id FROM warden_jobs WHERE key=${`delivery:${id}`} AND NOT completed`,
      )
    ).length === 1,
    "unprocessed delivery retained",
  );
  console.log(
    JSON.stringify({
      scenario: "accepted while worker stopped",
      result: "pass",
      delivery: id,
    }),
  );
}
async function verifyRestart() {
  await waitFor(
    (s) =>
      gate(s)?.head_sha === s.prs[0]?.head.sha &&
      gate(s)?.status === "completed" &&
      gate(s)?.conclusion === "success",
    "worker restart recovers accepted delivery",
  );
  const s = await state();
  assert(s.comments.length === 1, "restart retains single sticky comment");
  assert(
    s.checks.filter(
      (check) =>
        check.name === CHECK_NAME && check.head_sha === s.prs[0]?.head.sha,
    ).length === 1,
    "restart publishes one aggregate for the current head",
  );
  console.log(
    JSON.stringify({
      scenario: "full end-to-end demo",
      result: "pass",
      githubRequests: s.requests.length,
    }),
  );
}
try {
  if (phase === "main") await main();
  else if (phase === "prepare-restart") await prepareRestart();
  else if (phase === "verify-restart") await verifyRestart();
  else throw new Error(`Unknown demo phase ${phase}`);
} finally {
  await close();
}
