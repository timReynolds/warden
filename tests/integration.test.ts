import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Webhooks } from "@octokit/webhooks";
import { sql } from "drizzle-orm";
import {
  createFixture,
  type FixtureState,
  fixtureCheck,
  initialState,
} from "../demo/github";
import { createApi } from "../src/api";
import { start } from "../src/app";
import { connect } from "../src/db";
import { migrate } from "../src/db/migrate";
import { claim, enqueue, fail, finish } from "../src/db/queue";
import type { Env } from "../src/env";
import { processDelivery, recoverFailedDelivery } from "../src/events";
import { GitHub, GitHubError } from "../src/github";
import {
  changeLifecycle,
  onboardInstallation,
  onboardRepository,
} from "../src/installations";
import {
  ACTION_ID,
  CHECK_NAME,
  COMMENT_MARKER,
  type Target,
} from "../src/model";
import { configFor } from "../src/policy-store";
import { reconcile } from "../src/reconcile";
import { storeSignal } from "../src/signals";
import { workOnce } from "../src/worker";

const url = process.env.WARDEN_TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith("/warden_test"))
  throw new Error(
    "WARDEN_TEST_DATABASE_URL must target a real dedicated warden_test PostgreSQL database; integration tests are mandatory",
  );
const databaseUrl = url;
const { db, close } = connect(databaseUrl);
const secret = "warden-integration-secret";
const webhooks = new Webhooks({ secret });
const t: Target = {
  owner: "acme",
  repo: "repo",
  number: 1,
  installationId: 1,
  repositoryId: 10,
};
let state: FixtureState;
const fixture = createFixture();
const http = Bun.serve({ port: 0, fetch: fixture.app.fetch });
const api = Bun.serve({ port: 0, fetch: createApi(db, webhooks).fetch });
let github: GitHub;
let time: Date;
const clock = { now: () => time, jitter: () => 0.5 };
const advance = (seconds = 2) => {
  time = new Date(time.getTime() + seconds * 1000);
};
const env: Env = {
  DATABASE_URL: url,
  WARDEN_WEBHOOK_SECRET: secret,
  PORT: 3000,
  WARDEN_APP_ID: 1,
  WARDEN_GITHUB_API_URL: http.url.toString().replace(/\/$/, ""),
  WARDEN_DEMO: "true",
  WARDEN_JOB_LEASE_SECONDS: 10,
  WARDEN_WORKER_POLL_MS: 100,
  privateKey: undefined,
};
const gate = () => state.checks.filter((c) => c.name === CHECK_NAME).at(-1);
async function rows(query: ReturnType<typeof sql>) {
  return db.execute(query);
}
async function webhook(
  event = "pull_request",
  data: Record<string, unknown> = {},
  id: string = crypto.randomUUID(),
  signature = true,
  labelChange = true,
) {
  if (
    labelChange &&
    event === "pull_request" &&
    ["labeled", "unlabeled"].includes(String(data.action))
  ) {
    const actor = data.sender as { login: string } | undefined;
    state.timeline.push({
      id: state.nextId++,
      issue: 1,
      event: String(data.action),
      created_at: new Date().toISOString(),
      actor: { login: actor?.login ?? "alice" },
      label: { name: "skip warden" },
    });
  }
  const body = JSON.stringify({
    action: "opened",
    installation: { id: 1 },
    repository: { id: 10, name: "repo", owner: { login: "acme" } },
    pull_request: state.prs[0],
    sender: { login: "alice" },
    ...data,
  });
  return fetch(`${api.url}webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": id,
      "x-github-event": event,
      "x-hub-signature-256": signature ? await webhooks.sign(body) : "bad",
    },
    body,
  });
}
async function settle() {
  await reconcile(db, github, t, clock);
  advance();
  return reconcile(db, github, t, clock);
}
async function drainDelivery(response: Response) {
  const delivery = String((await response.json()).delivery);
  for (let i = 0; i < 10; i++) {
    await workOnce(db, github);
    const job = (
      await rows(
        sql`SELECT completed FROM warden_jobs WHERE key=${`delivery:${delivery}`}`,
      )
    )[0];
    if (job?.completed === true) return;
  }
  throw new Error(`Delivery ${delivery} did not complete`);
}
beforeAll(async () => {
  await migrate(databaseUrl);
  await migrate(databaseUrl);
});
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE warden_gates,warden_signals,warden_attempts,warden_effects,warden_outputs,warden_audit,warden_config_revisions,warden_decisions,warden_observations,warden_jobs,warden_deliveries,warden_prs,warden_installations,warden_repositories,warden_metrics RESTART IDENTITY CASCADE`,
  );
  state = initialState();
  Object.assign(fixture.getState(), state);
  state = fixture.getState();
  github = new GitHub(env);
  time = new Date();
});
afterAll(async () => {
  await api.stop();
  await http.stop();
  await close();
});

test("policy revisions and errors survive client restarts without refetching", async () => {
  const pull = state.prs[0];
  if (!pull) throw new Error("Missing PR base");
  const revision = pull.base.sha;
  const policy = await configFor(db, github, t, revision);
  expect(github.requests).toBeGreaterThan(0);
  state.config = "version: 99";
  const restarted = new GitHub(env);
  expect(await configFor(db, restarted, t, revision)).toEqual(policy);
  expect(restarted.requests).toBe(0);

  const invalidRevision = "d".repeat(40);
  pull.base.sha = invalidRevision;
  await expect(configFor(db, restarted, t, invalidRevision)).rejects.toThrow(
    "Warden configuration:",
  );
  const retry = new GitHub(env);
  await expect(configFor(db, retry, t, invalidRevision)).rejects.toThrow(
    "Warden configuration:",
  );
  expect(retry.requests).toBe(0);
});

test("production App authentication signs valid JWTs and caches installation-scoped tokens", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const minted: number[] = [];
  const used: string[] = [];
  const service = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const installation = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(
        path,
      )?.[1];
      if (!installation)
        expect(request.headers.get("x-github-api-version")).toBe("2022-11-28");
      const appRead =
        /^\/app\/installations\/(\d+)$/.exec(path)?.[1] ??
        (path.endsWith("/installation") ? "1" : undefined);
      const authorization = request.headers.get("authorization") ?? "";
      if (installation || appRead) {
        const jwt = authorization.replace(/^Bearer /i, "");
        const [header, payload, signature] = jwt.split(".");
        if (!header || !payload || !signature)
          return new Response("Invalid JWT", { status: 401 });
        expect(
          JSON.parse(Buffer.from(header, "base64url").toString()).alg,
        ).toBe("RS256");
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
        expect(String(claims.iss)).toBe("1");
        expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
        expect(
          verify(
            "RSA-SHA256",
            Buffer.from(`${header}.${payload}`),
            keys.publicKey,
            Buffer.from(signature, "base64url"),
          ),
        ).toBe(true);
        if (appRead)
          return Response.json({ id: Number(appRead), suspended_at: null });
        minted.push(Number(installation));
        return Response.json(
          {
            token: `ghs_warden_fixture_${installation}`,
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            permissions: {},
            repository_selection: "selected",
          },
          { status: 201 },
        );
      }
      used.push(authorization);
      if (!/^(token|Bearer) ghs_warden_fixture_[12]$/.test(authorization))
        return new Response("Invalid installation token", { status: 401 });
      const scopedInstallation = /\/install-([12])\//.exec(path)?.[1];
      if (scopedInstallation)
        expect(authorization).toMatch(
          new RegExp(
            `^(token|Bearer) ghs_warden_fixture_${scopedInstallation}$`,
          ),
        );
      return Response.json(
        path === "/repos/acme/repo"
          ? { id: 10, name: "repo", owner: { login: "acme" }, archived: false }
          : initialState().prs[0],
      );
    },
  });
  try {
    const production = new GitHub({
      ...env,
      WARDEN_DEMO: "false",
      WARDEN_GITHUB_API_URL: service.url.toString().replace(/\/$/, ""),
      privateKey,
    });
    expect(await production.installationState(1)).toBe("active");
    expect((await production.pull(t)).sha).toBe("a".repeat(40));
    await production.pull(t);
    await production.pull({ ...t, installationId: 2 });
    expect(minted).toEqual([1, 2]);
    expect(used).toHaveLength(3);
    expect(used[0]).toBe(used[1]);
    expect(used[2]).not.toBe(used[0]);
    expect((await production.repository(t)).state).toBe("active");
    await Promise.all(
      [1, 2].map((installationId) =>
        production.withClient(installationId, async () => {
          const target = {
            ...t,
            installationId,
            repo: `install-${installationId}`,
          };
          await production.pull(target);
          await Bun.sleep(5);
          await production.pull(target);
        }),
      ),
    );
    expect(minted).toEqual([1, 2]);
    expect(used).toHaveLength(8);
  } finally {
    await service.stop();
  }
});

test("Octokit follows Link headers across short pages without duplicating query parameters", async () => {
  const pages: string[] = [];
  const service = Bun.serve({
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe("/repos/acme/repo/pulls");
      expect(url.searchParams.getAll("page")).toHaveLength(1);
      expect(url.searchParams.getAll("per_page")).toEqual(["100"]);
      expect(url.searchParams.has("owner")).toBe(false);
      expect(url.searchParams.has("repo")).toBe(false);
      expect(url.searchParams.get("state")).toBe("open");
      const page = url.searchParams.get("page") ?? "";
      pages.push(page);
      url.searchParams.set("page", "7");
      return Response.json([{ number: page === "1" ? 1 : 2 }], {
        headers: page === "1" ? { link: `<${url}>; rel="next"` } : {},
      });
    },
  });
  try {
    const client = new GitHub({
      ...env,
      WARDEN_GITHUB_API_URL: service.url.toString().replace(/\/$/, ""),
    });
    expect(await client.openPulls(t)).toEqual([{ number: 1 }, { number: 2 }]);
    expect(pages).toEqual(["1", "7"]);
    expect(client.requests).toBe(2);
  } finally {
    await service.stop();
  }
});

for (const { name, response } of [
  {
    name: "missing advertised results",
    response: { total_count: 2, check_runs: [fixtureCheck(1)] },
  },
  {
    name: "invalid total",
    response: { total_count: "unknown", check_runs: [] },
  },
  {
    name: "incomplete results",
    response: { total_count: 0, incomplete_results: true, check_runs: [] },
  },
  { name: "null body", response: null },
]) {
  test(`pagination rejects ${name} before completing a snapshot`, async () => {
    const service = Bun.serve({
      port: 0,
      fetch: () => Response.json(response),
    });
    try {
      const client = new GitHub({
        ...env,
        WARDEN_GITHUB_API_URL: service.url.toString().replace(/\/$/, ""),
      });
      await expect(client.snapshot(t, "a".repeat(40))).rejects.toThrow();
      expect(client.requests).toBe(1);
    } finally {
      await service.stop();
    }
  });
}

test("pagination stops at Warden's request bound even with an endless next link", async () => {
  let requests = 0;
  const service = Bun.serve({
    port: 0,
    fetch: (request) => {
      requests++;
      return Response.json([], {
        headers: { link: `<${request.url}>; rel="next"` },
      });
    },
  });
  try {
    const client = new GitHub({
      ...env,
      WARDEN_GITHUB_API_URL: service.url.toString().replace(/\/$/, ""),
    });
    await expect(client.openPulls(t)).rejects.toThrow("safety bound");
    expect(requests).toBe(50);
  } finally {
    await service.stop();
  }
});

test("GitHub's filtered workflow cap remains a blocking discovery error", async () => {
  state.workflows = Array.from({ length: 1001 }, () => ({
    head_sha: "a".repeat(40),
  }));
  await expect(github.snapshot(t, "a".repeat(40))).rejects.toThrow(
    "caps filtered workflow lists",
  );
});

test("pagination conflicts block the gate and never count as empty scans", async () => {
  state.errorPath = "check-runs";
  state.errorStatus = 409;
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("failure");
  expect(
    (await rows(sql`SELECT empty_scans FROM warden_prs`))[0]?.empty_scans,
  ).toBe(0);
  expect(state.comments[0]?.body).toContain("observation error");
});

for (const status of [403, 429]) {
  test(`HTTP ${status} defers to the durable queue without an inline retry`, async () => {
    state.errorPath = "check-runs";
    state.errorStatus = status;
    try {
      await github.snapshot(t, "a".repeat(40));
      throw new Error("Expected rate-limit failure");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubError);
      if (!(error instanceof GitHubError)) throw error;
      expect(error.retryAfter).toBe(120);
    }
    expect(github.requests).toBe(1);
  });
}

describe("real PostgreSQL and real GitHub HTTP client acceptance", () => {
  test("signed ingress, durable queue and real worker reach sticky comment", async () => {
    state.checks = [fixtureCheck(1)];
    const response = await webhook();
    expect(response.status).toBe(202);
    expect((await rows(sql`SELECT * FROM warden_deliveries`)).length).toBe(1);
    expect(await workOnce(db, github)).toBe(true);
    expect(await workOnce(db, github)).toBe(true);
    expect(gate()?.status).toBe("in_progress");
    expect(state.comments[0]?.body.startsWith(COMMENT_MARKER)).toBe(true);
    await Bun.sleep(1100);
    await workOnce(db, github);
    expect(gate()?.conclusion).toBe("success");
    expect(
      (await rows(sql`SELECT * FROM warden_decisions`)).length,
    ).toBeGreaterThan(0);
    expect(
      (await rows(sql`SELECT * FROM warden_outputs WHERE published`)).length,
    ).toBeGreaterThan(0);
  });
  test("invalid signature is rejected and duplicate accepted delivery is idempotent", async () => {
    expect((await webhook("pull_request", {}, "bad", false)).status).toBe(401);
    expect((await rows(sql`SELECT * FROM warden_jobs`)).length).toBe(0);
    await webhook("pull_request", {}, "same");
    await webhook("pull_request", {}, "same");
    expect((await rows(sql`SELECT * FROM warden_jobs`)).length).toBe(1);
  });
  test("Octokit verification rejects missing, malformed, wrong-secret and tampered signatures before persistence", async () => {
    const body = '{"unicode":"🥔"}';
    for (const signature of [
      "",
      "sha256=abcd",
      `sha1=${"0".repeat(40)}`,
      await new Webhooks({ secret: "wrong-secret" }).sign(body),
      await webhooks.sign(`${body} `),
    ]) {
      const response = await fetch(`${api.url}webhooks/github`, {
        method: "POST",
        headers: {
          "x-github-delivery": crypto.randomUUID(),
          "x-github-event": "ping",
          ...(signature ? { "x-hub-signature-256": signature } : {}),
        },
        body,
      });
      expect(response.status).toBe(401);
    }
    expect(await rows(sql`SELECT * FROM warden_deliveries`)).toHaveLength(0);
    expect(await rows(sql`SELECT * FROM warden_jobs`)).toHaveLength(0);
  });
  for (const streamed of [false, true]) {
    test(`oversized ${streamed ? "streamed" : "buffered"} webhooks return 413 before persistence`, async () => {
      const body = JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) });
      const bytes = new TextEncoder().encode(body);
      const response = await fetch(`${api.url}webhooks/github`, {
        method: "POST",
        headers: {
          "x-github-delivery": "oversized",
          "x-github-event": "ping",
          "x-hub-signature-256": await webhooks.sign(body),
        },
        body: streamed
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                for (let at = 0; at < bytes.length; at += 65536)
                  controller.enqueue(bytes.slice(at, at + 65536));
                controller.close();
              },
            })
          : body,
      });
      expect(response.status).toBe(413);
      expect((await rows(sql`SELECT * FROM warden_deliveries`)).length).toBe(0);
      expect((await rows(sql`SELECT * FROM warden_jobs`)).length).toBe(0);
    });
  }
  test("an oversized request cannot poison a later signed Unicode stream", async () => {
    const oversized = await fetch(`${api.url}webhooks/github`, {
      method: "POST",
      body: "x".repeat(2 * 1024 * 1024 + 1),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("connection")).toBe("close");
    const body = JSON.stringify({ action: "ping", text: "Warden 🛡️" });
    const bytes = new TextEncoder().encode(body);
    const response = await fetch(`${api.url}webhooks/github`, {
      method: "POST",
      headers: {
        "x-github-delivery": "streamed-unicode",
        "x-github-event": "ping",
        "x-hub-signature-256": await webhooks.sign(body),
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
    });
    expect({ status: response.status, body: await response.text() }).toEqual({
      status: 202,
      body: JSON.stringify({ accepted: true, delivery: "streamed-unicode" }),
    });
    expect(
      (await rows(sql`SELECT payload FROM warden_deliveries`))[0]?.payload,
    ).toEqual(JSON.parse(body));
  });
  test("database failure never returns false durable acceptance", async () => {
    const broken = connect("postgres://warden:warden@127.0.0.1:1/warden_test");
    const brokenApi = createApi(broken.db, webhooks);
    const body = "{}";
    const response = await brokenApi.request("/webhooks/github", {
      method: "POST",
      headers: {
        "x-hub-signature-256": await webhooks.sign(body),
        "x-github-event": "ping",
        "x-github-delivery": "fail",
      },
      body,
    });
    expect(response.status).toBe(500);
    await broken.close();
  });
  test("enqueue failure rolls back signed delivery acceptance and allows redelivery", async () => {
    const id = "atomic-acceptance";
    const key = `delivery:${id}`;
    await rows(
      sql`INSERT INTO warden_jobs(key,kind,payload) VALUES(${key},'delivery','{}'::jsonb)`,
    );
    expect((await webhook("pull_request", {}, id)).status).toBe(500);
    expect(await rows(sql`SELECT id FROM warden_deliveries`)).toHaveLength(0);
    expect(
      await rows(
        sql`SELECT value FROM warden_metrics WHERE name='deliveries_accepted'`,
      ),
    ).toHaveLength(0);
    await rows(sql`DELETE FROM warden_jobs WHERE key=${key}`);
    const response = await webhook("pull_request", {}, id);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      accepted: true,
      delivery: id,
    });
    expect(await rows(sql`SELECT id FROM warden_deliveries`)).toHaveLength(1);
    expect(
      await rows(sql`SELECT id FROM warden_jobs WHERE key=${key}`),
    ).toHaveLength(1);
  });
  test("early failure while another check runs; queued and passing reruns replace older attempts", async () => {
    state.checks = [
      fixtureCheck(1, "failure"),
      fixtureCheck(2, null, "in_progress", "lint"),
    ];
    await reconcile(db, github, t, clock);
    expect(gate()?.conclusion).toBe("failure");
    expect(state.comments[0]?.body).toContain("failure");
    state.checks.push(fixtureCheck(3, null, "queued"));
    await reconcile(db, github, t, clock);
    expect(gate()?.status).toBe("in_progress");
    const run = state.checks.find((c) => c.id === 3);
    if (run) Object.assign(run, fixtureCheck(3));
    const lint = state.checks.find((c) => c.id === 2);
    if (lint)
      Object.assign(lint, fixtureCheck(2, "success", "completed", "lint"));
    await settle();
    expect(gate()?.conclusion).toBe("success");
    state.checks.push(fixtureCheck(4, null, "queued"));
    await reconcile(db, github, t, clock);
    expect(gate()?.status).toBe("in_progress");
  });
  test("all statuses and current test-merge results are evaluated", async () => {
    const merge = "c".repeat(40);
    const p = state.prs[0];
    if (p) p.merge_commit_sha = merge;
    state.checks = [
      fixtureCheck(1),
      fixtureCheck(2, "failure", "completed", "merge tests", merge),
    ];
    await settle();
    expect(gate()?.conclusion).toBe("failure");
    state.checks = state.checks.filter(
      (c) => c.app.id === 1 || c.head_sha !== merge,
    );
    state.statuses = [
      {
        id: 1,
        context: "deploy",
        sha: p?.head.sha,
        state: "pending",
        updated_at: "2026-10-01T01:00:00Z",
        target_url: null,
      },
    ];
    await reconcile(db, github, t, clock);
    expect(gate()?.status).toBe("in_progress");
  });
  test("workflow identity exclusions do not hide identically named unrelated work", async () => {
    state.config += "checks:\n  ignore_workflows: [{id: 9}]\n";
    state.checks = [fixtureCheck(1, "failure")];
    state.workflows = [
      {
        id: 1,
        workflow_id: 9,
        name: "optional",
        path: ".github/workflows/optional.yml",
        run_attempt: 1,
        check_suite_id: 20,
        head_sha: "a".repeat(40),
        status: "queued",
        conclusion: null,
        html_url: "http://github.local/runs/1",
      },
    ];
    state.suites = [
      {
        id: 20,
        app: { id: 2 },
        head_sha: "a".repeat(40),
        status: "queued",
        conclusion: null,
      },
    ];
    const other = fixtureCheck(2, "failure");
    other.check_suite.id = 30;
    state.checks.push(other);
    await reconcile(db, github, t, clock);
    expect(gate()?.conclusion).toBe("failure");
    state.checks = state.checks.filter((c) => c.id !== 2);
    await reconcile(db, github, t, clock);
    expect(gate()?.status).toBe("in_progress");
  });
  test("pending approvals and failed startup with no jobs block empty passes", async () => {
    state.workflows = [
      {
        id: 1,
        workflow_id: 9,
        name: "deploy",
        path: ".github/workflows/deploy.yml",
        check_suite_id: 20,
        head_sha: "a".repeat(40),
        status: "waiting",
        conclusion: null,
        html_url: "http://github.local/runs/1",
      },
    ];
    await reconcile(db, github, t, clock);
    expect(gate()?.status).toBe("in_progress");
    state.workflows[0] = {
      ...state.workflows[0],
      status: "completed",
      conclusion: "startup_failure",
    };
    await reconcile(db, github, t, clock);
    expect(gate()?.conclusion).toBe("failure");
    expect(
      (await rows(sql`SELECT empty_scans FROM warden_prs`))[0]?.empty_scans,
    ).toBe(0);
  });
  test("empty passes only after three separately scheduled scans; repeated triggers do not count", async () => {
    await reconcile(db, github, t, clock);
    await reconcile(db, github, t, clock);
    expect(
      (await rows(sql`SELECT empty_scans FROM warden_prs`))[0]?.empty_scans,
    ).toBe(1);
    advance();
    await reconcile(db, github, t, clock);
    expect(gate()?.status).toBe("in_progress");
    advance();
    await reconcile(db, github, t, clock);
    expect(gate()?.conclusion).toBe("success");
    expect(gate()?.output).toMatchObject({
      title: expect.stringContaining("3 complete scheduled empty scans"),
    });
  });
  test("late discovery resets empty count and quiet period", async () => {
    await reconcile(db, github, t, clock);
    advance();
    await reconcile(db, github, t, clock);
    state.checks = [fixtureCheck(1, null, "queued")];
    advance();
    await reconcile(db, github, t, clock);
    expect(
      (await rows(sql`SELECT empty_scans FROM warden_prs`))[0]?.empty_scans,
    ).toBe(0);
    expect(gate()?.status).toBe("in_progress");
  });
  test("observation errors/rate limits are blocking, never empty scans", async () => {
    await reconcile(db, github, t, clock);
    advance();
    state.errorNext = 429;
    // The first authoritative PR read fails and the caller must retry, with no scan.
    await expect(reconcile(db, github, t, clock)).rejects.toThrow();
    expect(
      (await rows(sql`SELECT empty_scans FROM warden_prs`))[0]?.empty_scans,
    ).toBe(0);
    const job = await (async () => {
      await enqueue(db, t);
      return claim(db, 10);
    })();
    if (!job) throw new Error("Missing job");
    await fail(db, job, { retryAfter: 60 });
    const remaining = (
      await rows(
        sql`SELECT extract(epoch from available_at-now()) AS seconds FROM warden_jobs`,
      )
    )[0]?.seconds;
    expect(Number(remaining)).toBeGreaterThan(50);
  });
  test("force-push publication race cannot approve a newer head", async () => {
    state.checks = [fixtureCheck(1)];
    await reconcile(db, github, t, clock);
    advance();
    state.raceSha = "d".repeat(40);
    state.raceAfter = 2;
    expect(await reconcile(db, github, t, clock)).toBe(0);
    expect(
      state.checks.filter(
        (c) =>
          c.name === CHECK_NAME &&
          c.head_sha === "d".repeat(40) &&
          c.conclusion === "success",
      ),
    ).toHaveLength(0);
    await reconcile(db, github, t, clock);
    expect(
      (await rows(sql`SELECT generation,empty_scans,sha FROM warden_prs`))[0],
    ).toMatchObject({ generation: 2, empty_scans: 1, sha: "d".repeat(40) });
  });
  test("base/config and merge changes supersede generations", async () => {
    state.checks = [fixtureCheck(1)];
    await settle();
    const p = state.prs[0];
    if (p) p.merge_commit_sha = "c".repeat(40);
    await reconcile(db, github, t, clock);
    expect(gate()?.status).toBe("in_progress");
    expect(
      (await rows(sql`SELECT generation FROM warden_prs`))[0]?.generation,
    ).toBe(2);
  });
  test("retarget and trusted config revision changes invalidate previous success; head config cannot weaken", async () => {
    state.checks = [fixtureCheck(1, "neutral")];
    await settle();
    expect(gate()?.conclusion).toBe("success");
    const p = state.prs[0];
    if (!p) throw new Error("Missing PR");
    p.base.ref = "release";
    await reconcile(db, github, t, clock);
    expect(gate()?.status).toBe("in_progress");
    p.base.sha = "d".repeat(40);
    state.configs[p.base.sha] =
      `${state.config}checks:\n  passing_conclusions: [success]\n`;
    state.configs[p.head.sha] =
      `${state.config}checks:\n  ignore_checks: ['*']\n`;
    await reconcile(db, github, t, clock);
    expect(gate()?.conclusion).toBe("failure");
    expect(
      (await rows(sql`SELECT generation,base_sha FROM warden_prs`))[0],
    ).toMatchObject({ generation: 3, base_sha: p.base.sha });
    expect(
      state.requests
        .filter((r) => r.path.includes("contents"))
        .some((r) => r.query.includes(`ref=${p.head.sha}`)),
    ).toBe(false);
  });
  test("new work appearing only in final verification prevents success", async () => {
    state.checks = [fixtureCheck(1)];
    await reconcile(db, github, t, clock);
    advance();
    state.injectedCheck = fixtureCheck(2, null, "queued", "late CI");
    state.injectOnCheckRead = 2;
    await reconcile(db, github, t, clock);
    expect(gate()?.status).toBe("in_progress");
    expect(state.comments[0]?.body).toContain("final verification");
    expect(
      (await rows(sql`SELECT empty_scans FROM warden_prs`))[0]?.empty_scans,
    ).toBe(0);
  });
  test("authorized bypass, removal, unauthorized label and preexisting label recovery", async () => {
    state.checks = [fixtureCheck(1, "failure")];
    const p = state.prs[0];
    if (p) p.labels = [{ name: "skip warden" }];
    await webhook("pull_request", {
      action: "labeled",
      label: { name: "skip warden" },
      sender: { login: "mallory" },
    });
    await workOnce(db, github);
    await workOnce(db, github);
    expect(gate()?.conclusion).toBe("failure");
    await webhook("pull_request", {
      action: "labeled",
      label: { name: "skip warden" },
      sender: { login: "alice" },
    });
    await workOnce(db, github);
    await workOnce(db, github);
    expect(gate()?.conclusion).toBe("success");
    expect(state.comments[0]?.body).toContain("Bypassed via skip warden");
    if (p) p.labels = [];
    await webhook("pull_request", {
      action: "unlabeled",
      label: { name: "skip warden" },
    });
    await workOnce(db, github);
    await workOnce(db, github);
    expect(gate()?.conclusion).toBe("failure");
    expect(state.comments).toHaveLength(1);
  });
  test("shared SHA bypass never grants success to another PR", async () => {
    const p = state.prs[0];
    if (!p) throw new Error("Missing PR");
    p.labels = [{ name: "skip warden" }];
    state.prs.push({ ...p, number: 2, labels: [] });
    state.checks = [fixtureCheck(1, "failure")];
    await webhook("pull_request", {
      action: "labeled",
      label: { name: "skip warden" },
    });
    await workOnce(db, github);
    await workOnce(db, github);
    expect(gate()?.conclusion).not.toBe("success");
  });
  test("trusted config is pinned, malformed config blocks even bypass", async () => {
    state.config = "version: 99";
    state.checks = [fixtureCheck(1)];
    await reconcile(db, github, t, clock);
    expect(gate()?.conclusion).toBe("failure");
    expect(
      state.requests
        .filter((r) => r.path.includes("contents"))
        .every((r) => r.query.includes(`ref=${"b".repeat(40)}`)),
    ).toBe(true);
    expect(
      (await rows(sql`SELECT error FROM warden_config_revisions`))[0]?.error,
    ).toBeTruthy();
  });
  test("only verified config absence uses defaults; inaccessible 404 is blocking", async () => {
    state.missingConfig = true;
    state.inaccessibleTree = true;
    await reconcile(db, github, t, clock);
    expect(gate()?.conclusion).toBe("failure");
    state.inaccessibleTree = false;
    await reconcile(db, github, t, clock);
    expect(gate()?.status).toBe("in_progress");
    expect(
      (
        await rows(sql`SELECT content,effective FROM warden_config_revisions`)
      )[0]?.content,
    ).toBe(null);
  });
  test("manual requested action and rerequest authorize actors and renew completed jobs", async () => {
    state.checks = [fixtureCheck(1)];
    await settle();
    const current = gate();
    if (!current) throw new Error("Missing gate");
    await webhook("check_run", {
      action: "completed",
      check_run: current,
      pull_request: undefined,
    });
    await workOnce(db, github);
    expect(
      await rows(sql`SELECT * FROM warden_jobs WHERE kind='reconcile'`),
    ).toHaveLength(0);
    await webhook("check_run", {
      action: "requested_action",
      check_run: current,
      requested_action: { identifier: ACTION_ID },
      pull_request: undefined,
    });
    await workOnce(db, github);
    expect(
      await rows(sql`SELECT * FROM warden_audit WHERE kind='manual_reconcile'`),
    ).toHaveLength(1);
  });
  test("pre-existing and unverifiable labels do not grant bypass", async () => {
    const p = state.prs[0];
    if (p) p.labels = [{ name: "skip warden" }];
    state.checks = [fixtureCheck(1, "failure")];
    await reconcile(db, github, t, clock);
    expect(gate()?.conclusion).toBe("failure");
    state.errorPath = "permission";
    await webhook("pull_request", {
      action: "labeled",
      label: { name: "skip warden" },
    });
    await workOnce(db, github);
    await workOnce(db, github);
    expect(gate()?.conclusion).toBe("failure");
    expect(
      (await rows(sql`SELECT bypass_actor FROM warden_prs`))[0]?.bypass_actor,
    ).toBe(null);
  });
  test("Warden rerequested control is authorized and older deliveries cannot reverse passing rerun", async () => {
    state.checks = [fixtureCheck(1, "failure"), fixtureCheck(4)];
    await settle();
    const current = gate();
    if (!current) throw new Error("Missing gate");
    await webhook("check_run", {
      action: "completed",
      check_run: fixtureCheck(1, "failure"),
      pull_request: undefined,
    });
    await workOnce(db, github, 60, clock);
    await workOnce(db, github, 60, clock);
    expect(gate()?.conclusion).toBe("success");
    await webhook("check_run", {
      action: "rerequested",
      check_run: current,
      pull_request: undefined,
      sender: { login: "mallory" },
    });
    await workOnce(db, github, 60, clock);
    expect(
      await rows(sql`SELECT * FROM warden_audit WHERE kind='manual_reconcile'`),
    ).toHaveLength(0);
    await webhook("check_run", {
      action: "rerequested",
      check_run: current,
      pull_request: undefined,
    });
    await workOnce(db, github, 60, clock);
    expect(
      await rows(sql`SELECT * FROM warden_audit WHERE kind='manual_reconcile'`),
    ).toHaveLength(1);
  });
  test("two concurrent claims, enqueue during processing, expiry and stale ack are safe", async () => {
    await enqueue(db, t);
    const claims = await Promise.all([claim(db, 10), claim(db, 10)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const job = claims.find(Boolean);
    if (!job) throw new Error("Missing job");
    await enqueue(db, t);
    await finish(db, job);
    expect(
      (await rows(sql`SELECT completed FROM warden_jobs`))[0]?.completed,
    ).toBe(false);
    const next = await claim(db, 10);
    if (!next) throw new Error("Missing lease");
    await db.execute(
      sql`UPDATE warden_jobs SET lease_until=now()-interval '1 second'`,
    );
    const recovered = await claim(db, 10);
    if (!recovered) throw new Error("Missing recovered lease");
    await finish(db, next);
    expect(
      (await rows(sql`SELECT lease_token FROM warden_jobs`))[0]?.lease_token,
    ).toBe(recovered.lease_token);
    await finish(db, recovered);
  });
  test("two concurrent workers serialize publication without duplicate effects", async () => {
    state.checks = [fixtureCheck(1)];
    await Promise.all([
      reconcile(db, github, t, clock),
      reconcile(db, github, t, clock),
    ]);
    expect(state.checks.filter((c) => c.name === CHECK_NAME)).toHaveLength(1);
    expect(state.comments).toHaveLength(1);
  });
  test("ambiguous create after HTTP failure is rediscovered after process restart", async () => {
    state.checks = [fixtureCheck(1)];
    state.loseNextWrite = true;
    await expect(reconcile(db, github, t, clock)).rejects.toThrow();
    expect(state.checks.filter((c) => c.name === CHECK_NAME)).toHaveLength(1);
    github = new GitHub(env);
    await reconcile(db, github, t, clock);
    expect(state.checks.filter((c) => c.name === CHECK_NAME)).toHaveLength(1);
    expect(state.comments).toHaveLength(1);
  });
  test("deleted sticky comment is safely recreated", async () => {
    state.checks = [fixtureCheck(1)];
    await reconcile(db, github, t, clock);
    state.comments = [];
    advance();
    await reconcile(db, github, t, clock);
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]?.body.startsWith(COMMENT_MARKER)).toBe(true);
  });
  test("paginated checks include failures after first page; partial lists fail closed", async () => {
    state.checks = Array.from({ length: 101 }, (_, i) =>
      fixtureCheck(
        i + 1,
        i === 100 ? "failure" : "success",
        "completed",
        `job-${i}`,
      ),
    );
    await reconcile(db, github, t, clock);
    expect(gate()?.conclusion).toBe("failure");
    expect(state.requests.some((r) => r.query.includes("page=2"))).toBe(true);
  });
  test("a later-page HTTP failure and an incomplete total fail closed and reset scans", async () => {
    state.checks = Array.from({ length: 101 }, (_, i) => fixtureCheck(i + 1));
    state.errorPath = "check-runs";
    state.errorPage = 2;
    await reconcile(db, github, t, clock);
    expect(gate()?.conclusion).toBe("failure");
    expect(
      (await rows(sql`SELECT empty_scans FROM warden_prs`))[0]?.empty_scans,
    ).toBe(0);
    expect(state.comments[0]?.body).toContain("observation error");
    state.truncatePage = 2;
    await reconcile(db, github, t, clock);
    expect(gate()?.conclusion).toBe("failure");
  });
  test("new signed rerun signal cannot be hidden by stale successful API snapshot", async () => {
    state.checks = [fixtureCheck(1)];
    await settle();
    const unseen = fixtureCheck(4, null, "queued");
    await webhook("check_run", {
      action: "created",
      check_run: unseen,
      pull_request: undefined,
    });
    await workOnce(db, github);
    await workOnce(db, github);
    expect(gate()?.status).toBe("in_progress");
    advance();
    await reconcile(db, github, t, clock);
    expect(gate()?.status).toBe("in_progress");
    state.checks.push(fixtureCheck(4));
    await settle();
    expect(gate()?.conclusion).toBe("success");
  });
  test("failure signal is immediate even while authoritative run state lags", async () => {
    state.checks = [fixtureCheck(4, null, "in_progress")];
    await reconcile(db, github, t, clock);
    await webhook("check_run", {
      action: "completed",
      check_run: fixtureCheck(4, "failure"),
      pull_request: undefined,
    });
    await workOnce(db, github);
    await workOnce(db, github);
    expect(gate()?.conclusion).toBe("failure");
  });
  test("initial grace and timeout are blocking", async () => {
    state.config = state.config
      .replace("max_duration_seconds: 300", "max_duration_seconds: 30")
      .replace("initial_grace_seconds: 0", "initial_grace_seconds: 10");
    state.checks = [fixtureCheck(1)];
    await settle();
    expect(gate()?.status).toBe("in_progress");
    advance(10);
    await reconcile(db, github, t, clock);
    expect(gate()?.conclusion).toBe("success");
    state.checks.push(fixtureCheck(2, null, "queued"));
    await reconcile(db, github, t, clock);
    advance(40);
    expect(await reconcile(db, github, t, clock)).toBe(null);
    expect(gate()?.conclusion).toBe("failure");
    expect(state.comments[0]?.body).toContain("timed out");
  });
  test("identical observations avoid redundant writes and settled work stops", async () => {
    state.checks = [fixtureCheck(1)];
    await settle();
    const writes = state.requests.filter((r) => r.method !== "GET").length;
    expect(await reconcile(db, github, t, clock)).toBe(null);
    expect(state.requests.filter((r) => r.method !== "GET")).toHaveLength(
      writes,
    );
  });
  test("onboarding discovers existing PRs and fork webhook empty arrays use durable SHA associations", async () => {
    expect(await onboardInstallation(db, github, 1)).toBe(1);
    state.checks = [fixtureCheck(1)];
    await workOnce(db, github);
    await webhook("check_run", {
      action: "completed",
      check_run: state.checks[0],
      pull_request: undefined,
      pull_requests: [],
    });
    await workOnce(db, github);
    expect(
      await rows(
        sql`SELECT * FROM warden_jobs WHERE kind='reconcile' AND NOT completed`,
      ),
    ).toHaveLength(2);
    expect(
      await rows(
        sql`SELECT key FROM warden_jobs WHERE key LIKE 'evaluate:%' AND NOT completed`,
      ),
    ).toHaveLength(1);
  });
  test("installation suspension stops work and unsuspension onboards recovery", async () => {
    state.checks = [fixtureCheck(1)];
    await reconcile(db, github, t, clock);
    state.installationState = "suspended";
    await webhook("installation", {
      action: "suspend",
      repository: undefined,
      pull_request: undefined,
    });
    await workOnce(db, github);
    const requests = state.requests.length;
    expect(await reconcile(db, github, t, clock)).toBe(null);
    expect(state.requests.length).toBe(requests);
    state.installationState = "active";
    await webhook("installation", {
      action: "unsuspend",
      repository: undefined,
      pull_request: undefined,
    });
    await workOnce(db, github);
    expect((await rows(sql`SELECT state FROM warden_prs`))[0]?.state).toBe(
      "open",
    );
  });
  test("accepted delivery survives worker restart and missed completion is scheduled", async () => {
    state.checks = [fixtureCheck(1, null, "in_progress")];
    await webhook();
    await workOnce(db, github);
    await workOnce(db, github);
    expect(gate()?.status).toBe("in_progress");
    const run = state.checks.find((c) => c.id === 1);
    if (run) Object.assign(run, fixtureCheck(1));
    github = new GitHub(env);
    await Bun.sleep(1100);
    await workOnce(db, github);
    await Bun.sleep(1100);
    await workOnce(db, github);
    expect(gate()?.conclusion).toBe("success");
  });
});

test("early failure keeps scheduled recovery while a jobless suite is pending", async () => {
  state.checks = [fixtureCheck(1, "failure")];
  state.suites = [
    {
      id: 30,
      app: { id: 3 },
      head_sha: "a".repeat(40),
      status: "queued",
      conclusion: null,
    },
  ];
  expect(await reconcile(db, github, t, clock)).not.toBe(null);
  expect(gate()?.conclusion).toBe("failure");
  state.checks.push(fixtureCheck(2));
  state.suites[0] = {
    ...state.suites[0],
    status: "completed",
    conclusion: "success",
  };
  await settle();
  expect(gate()?.conclusion).toBe("success");
});

test("partial workflow reruns keep untouched failures and discard only superseded job executions", async () => {
  state.checks = [
    fixtureCheck(1, "failure", "completed", "tests"),
    fixtureCheck(2, "failure", "completed", "lint"),
    fixtureCheck(3, "success", "completed", "lint"),
  ];
  state.workflows = [
    {
      id: 40,
      workflow_id: 9,
      name: "CI",
      path: ".github/workflows/ci.yml",
      run_attempt: 2,
      check_suite_id: 20,
      head_sha: "a".repeat(40),
      status: "completed",
      conclusion: "failure",
      html_url: "http://github.local/runs/40",
    },
  ];
  state.jobs = [
    {
      run_id: 40,
      run_attempt: 1,
      check_run_url: "http://github.local/check-runs/1",
      current: true,
    },
    {
      run_id: 40,
      run_attempt: 1,
      check_run_url: "http://github.local/check-runs/2",
      current: false,
    },
    {
      run_id: 40,
      run_attempt: 2,
      check_run_url: "http://github.local/check-runs/3",
      current: true,
    },
  ];
  await settle();
  expect(gate()?.conclusion).toBe("failure");
  expect(state.comments[0]?.body).toContain("tests");
  state.checks.push(fixtureCheck(4, "success", "completed", "tests"));
  state.jobs[0] = { ...state.jobs[0], current: false };
  state.jobs.push({
    run_id: 40,
    run_attempt: 3,
    check_run_url: "http://github.local/check-runs/4",
    current: true,
  });
  state.workflows[0] = {
    ...state.workflows[0],
    run_attempt: 3,
    conclusion: "success",
  };
  await settle();
  expect(gate()?.conclusion).toBe("success");
  expect(
    state.requests.some(
      (r) => r.path.endsWith("/jobs") && r.query.includes("filter=latest"),
    ),
  ).toBe(true);
});

test("a newer queued workflow signal survives completed and delayed old-attempt deliveries", async () => {
  state.checks = [fixtureCheck(1)];
  const completed = {
    id: 40,
    workflow_id: 9,
    name: "CI",
    path: ".github/workflows/ci.yml",
    run_attempt: 1,
    check_suite_id: 20,
    head_sha: "a".repeat(40),
    status: "completed",
    conclusion: "success",
    html_url: "http://github.local/runs/40",
  };
  state.workflows = [completed];
  await settle();
  await storeSignal(db, t, "workflow_run", { workflow_run: completed });
  await storeSignal(db, t, "workflow_run", {
    workflow_run: {
      ...completed,
      run_attempt: 2,
      status: "queued",
      conclusion: null,
    },
  });
  await storeSignal(db, t, "workflow_run", { workflow_run: completed });
  await reconcile(db, github, t, clock);
  expect(gate()?.status).toBe("in_progress");
  expect(
    (await rows(sql`SELECT data->>'attempt' AS attempt FROM warden_signals`))[0]
      ?.attempt,
  ).toBe("2");
  state.workflows[0] = { ...completed, run_attempt: 2 };
  await settle();
  expect(gate()?.conclusion).toBe("success");
});

test("a delayed authorized label delivery cannot grant a later unauthorized application", async () => {
  state.checks = [fixtureCheck(1, "failure")];
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  pr.labels = [{ name: "skip warden" }];
  await webhook("pull_request", {
    action: "labeled",
    label: { name: "skip warden" },
  });
  await workOnce(db, github);
  await workOnce(db, github);
  expect(gate()?.conclusion).toBe("success");
  pr.labels = [];
  await webhook("pull_request", {
    action: "unlabeled",
    label: { name: "skip warden" },
  });
  await workOnce(db, github);
  await workOnce(db, github);
  pr.labels = [{ name: "skip warden" }];
  await webhook("pull_request", {
    action: "labeled",
    label: { name: "skip warden" },
    sender: { login: "mallory" },
  });
  await workOnce(db, github);
  await workOnce(db, github);
  await webhook(
    "pull_request",
    { action: "labeled", label: { name: "skip warden" } },
    crypto.randomUUID(),
    true,
    false,
  );
  await workOnce(db, github);
  await workOnce(db, github);
  expect(gate()?.conclusion).toBe("failure");
  expect(
    (await rows(sql`SELECT bypass_actor FROM warden_prs`))[0]?.bypass_actor,
  ).toBe(null);
});

test("a missed label removal and reapplication invalidates the stored timeline grant", async () => {
  state.checks = [fixtureCheck(1, "failure")];
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  pr.labels = [{ name: "skip warden" }];
  await webhook("pull_request", {
    action: "labeled",
    label: { name: "skip warden" },
  });
  await workOnce(db, github);
  await workOnce(db, github);
  expect(gate()?.conclusion).toBe("success");
  state.timeline.push({
    id: state.nextId++,
    issue: 1,
    event: "unlabeled",
    created_at: new Date().toISOString(),
    actor: { login: "alice" },
    label: { name: "skip warden" },
  });
  state.timeline.push({
    id: state.nextId++,
    issue: 1,
    event: "labeled",
    created_at: new Date().toISOString(),
    actor: { login: "mallory" },
    label: { name: "skip warden" },
  });
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("failure");
});

test("new shared-head peers must complete their own discovery and stability windows", async () => {
  state.checks = [fixtureCheck(1)];
  await settle();
  expect(gate()?.conclusion).toBe("success");
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  state.prs.push({
    ...pr,
    number: 2,
    base: { sha: "c".repeat(40), ref: "release" },
  });
  state.configs["c".repeat(40)] = state.config.replace(
    "initial_grace_seconds: 0",
    "initial_grace_seconds: 10",
  );
  await reconcile(db, github, t, clock);
  expect(gate()?.status).toBe("in_progress");
  await reconcile(db, github, { ...t, number: 2 }, clock);
  advance();
  await reconcile(db, github, t, clock);
  expect(gate()?.status).toBe("in_progress");
  advance(10);
  await reconcile(db, github, { ...t, number: 2 }, clock);
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("success");
  expect(
    state.checks.filter((check) => check.name === CHECK_NAME),
  ).toHaveLength(1);
});

test("passing observations after the deadline block until new activity renews evaluation", async () => {
  state.config = state.config.replace(
    "max_duration_seconds: 300",
    "max_duration_seconds: 30",
  );
  state.checks = [fixtureCheck(1)];
  await reconcile(db, github, t, clock);
  advance(40);
  expect(await reconcile(db, github, t, clock)).toBe(null);
  expect(gate()?.conclusion).toBe("failure");
  expect(state.comments[0]?.body).toContain("timed out");
  time = new Date();
  await webhook("check_run", {
    action: "completed",
    check_run: fixtureCheck(1),
    pull_request: undefined,
  });
  await workOnce(db, github);
  await settle();
  expect(gate()?.conclusion).toBe("success");
});

test("same-SHA base branch retarget during final verification invalidates publication", async () => {
  state.checks = [fixtureCheck(1)];
  await reconcile(db, github, t, clock);
  advance();
  state.raceBaseRef = "release";
  state.raceAfter = 2;
  expect(await reconcile(db, github, t, clock)).toBe(0);
  expect(gate()?.conclusion).not.toBe("success");
  await reconcile(db, github, t, clock);
  expect((await rows(sql`SELECT base_ref FROM warden_prs`))[0]?.base_ref).toBe(
    "release",
  );
  await settle();
  expect(gate()?.conclusion).toBe("success");
});

test("a current queued job absent from stale check-runs observations cannot disappear", async () => {
  state.checks = [
    fixtureCheck(1),
    fixtureCheck(2, "success", "completed", "lint"),
  ];
  state.workflows = [
    {
      id: 40,
      workflow_id: 9,
      name: "CI",
      path: ".github/workflows/ci.yml",
      run_attempt: 1,
      check_suite_id: 20,
      head_sha: "a".repeat(40),
      status: "completed",
      conclusion: "success",
      html_url: "http://github.local/runs/40",
    },
  ];
  state.jobs = [
    {
      run_id: 40,
      run_attempt: 1,
      check_run_url: "http://github.local/check-runs/1",
      current: false,
    },
    {
      run_id: 40,
      run_attempt: 1,
      check_run_url: "http://github.local/check-runs/2",
      current: true,
    },
    {
      run_id: 40,
      run_attempt: 2,
      check_run_url: "http://github.local/check-runs/3",
      current: true,
    },
  ];
  for (let i = 0; i < 4; i++) {
    await reconcile(db, github, t, clock);
    advance();
  }
  expect(gate()?.conclusion).toBe("failure");
  expect(state.comments[0]?.body).toContain(
    "missing from complete check observations",
  );
  expect(
    (await rows(sql`SELECT empty_scans FROM warden_prs`))[0]?.empty_scans,
  ).toBe(0);
  state.checks.push(fixtureCheck(3, null, "queued"));
  state.workflows[0] = {
    ...state.workflows[0],
    run_attempt: 2,
    status: "in_progress",
    conclusion: null,
  };
  await settle();
  expect(gate()?.status).toBe("in_progress");
  state.checks[2] = fixtureCheck(3);
  state.workflows[0] = {
    ...state.workflows[0],
    status: "completed",
    conclusion: "success",
  };
  await settle();
  expect(gate()?.conclusion).toBe("success");
});

test("expired shared subjects do not repeatedly enqueue each other", async () => {
  state.config = state.config.replace(
    "max_duration_seconds: 300",
    "max_duration_seconds: 30",
  );
  state.checks = [fixtureCheck(1)];
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  await reconcile(db, github, t, clock);
  state.prs.push({ ...pr, number: 2 });
  await reconcile(db, github, { ...t, number: 2 }, clock);
  await rows(sql`TRUNCATE warden_jobs`);
  advance(40);
  expect(await reconcile(db, github, t, clock)).toBe(null);
  expect(await reconcile(db, github, { ...t, number: 2 }, clock)).toBe(null);
  expect((await rows(sql`SELECT * FROM warden_jobs`)).length).toBe(0);
});

test("an unchanged settled shared peer does not acquire a time-based expiry", async () => {
  state.config = state.config.replace(
    "max_duration_seconds: 300",
    "max_duration_seconds: 30",
  );
  state.checks = [fixtureCheck(1)];
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  await settle();
  state.prs.push({ ...pr, number: 2 });
  await reconcile(db, github, { ...t, number: 2 }, clock);
  advance();
  await reconcile(db, github, { ...t, number: 2 }, clock);
  await reconcile(db, github, t, clock);
  advance(60);
  await rows(
    sql`UPDATE warden_prs SET window_start=${time.toISOString()} WHERE number=2`,
  );
  await reconcile(db, github, { ...t, number: 2 }, clock);
  expect(gate()?.conclusion).toBe("success");
  expect(
    (
      await rows(
        sql`SELECT last_decision->>'state' AS state FROM warden_prs WHERE number=1`,
      )
    )[0]?.state,
  ).toBe("success");
});

test("operator onboarding renews expired observations and preserves historical decisions", async () => {
  state.config = state.config.replace(
    "max_duration_seconds: 300",
    "max_duration_seconds: 30",
  );
  state.checks = [fixtureCheck(1)];
  await reconcile(db, github, t, clock);
  advance(40);
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("failure");
  expect(await onboardInstallation(db, github, 1)).toBe(1);
  time = new Date();
  await settle();
  expect(gate()?.conclusion).toBe("success");
  expect(
    (
      await rows(
        sql`SELECT * FROM warden_decisions WHERE decision->>'phase'='timeout'`,
      )
    ).length,
  ).toBe(1);
});

test("maintain-only bypass uses role_name; unknown and missing roles fail closed", async () => {
  state.config += "bypass:\n  allowed_permissions: [maintain]\n";
  state.roles.alice = "maintain";
  state.checks = [fixtureCheck(1, "failure")];
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  pr.labels = [{ name: "skip warden" }];
  await webhook("pull_request", {
    action: "labeled",
    label: { name: "skip warden" },
  });
  await workOnce(db, github);
  await workOnce(db, github);
  expect(gate()?.conclusion).toBe("success");
  state.roles.alice = "write";
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("failure");
  state.roles.alice = "custom-build-manager";
  expect(await github.permission(t, "alice")).toBe("none");
  state.roles.alice = null;
  expect(await github.permission(t, "alice")).toBe("none");
});

test("changed observations renew and enqueue an expired previously settled shared peer", async () => {
  state.config = state.config.replace(
    "max_duration_seconds: 300",
    "max_duration_seconds: 30",
  );
  state.checks = [fixtureCheck(1)];
  await settle();
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  const merge = "c".repeat(40);
  state.prs.push({ ...pr, number: 2, merge_commit_sha: merge });
  state.checks.push(
    fixtureCheck(2, "success", "completed", "merge tests", merge),
  );
  await reconcile(db, github, { ...t, number: 2 }, clock);
  advance();
  await reconcile(db, github, { ...t, number: 2 }, clock);
  await reconcile(db, github, t, clock);
  await rows(sql`TRUNCATE warden_jobs`);
  advance(60);
  state.checks.push(
    fixtureCheck(3, "success", "completed", "new merge check", merge),
  );
  await reconcile(db, github, t, clock);
  expect(gate()?.status).toBe("in_progress");
  expect(
    (
      await rows(
        sql`SELECT * FROM warden_jobs WHERE key='reconcile:1/10#2' AND NOT completed`,
      )
    ).length,
  ).toBe(1);
  await reconcile(db, github, { ...t, number: 2 }, clock);
  advance();
  await reconcile(db, github, { ...t, number: 2 }, clock);
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("success");
});

test("repository unarchive onboards and resumes suspended PRs", async () => {
  state.checks = [fixtureCheck(1)];
  await reconcile(db, github, t, clock);
  const repository = state.repositories[0];
  if (!repository) throw new Error("Missing repository");
  repository.archived = true;
  await webhook("repository", { action: "archived", pull_request: undefined });
  await workOnce(db, github);
  expect((await rows(sql`SELECT state FROM warden_prs`))[0]?.state).toBe(
    "suspended",
  );
  repository.archived = false;
  await webhook("repository", {
    action: "unarchived",
    pull_request: undefined,
  });
  await workOnce(db, github);
  expect((await rows(sql`SELECT state FROM warden_prs`))[0]?.state).toBe(
    "open",
  );
  expect(
    (
      await rows(
        sql`SELECT * FROM warden_jobs WHERE kind='reconcile' AND NOT completed`,
      )
    ).length,
  ).toBe(1);
});

test("one per-SHA aggregate prevents a weak PR policy hiding a stricter peer failure", async () => {
  state.config += "checks:\n  ignore_checks: [test]\n";
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  state.prs.push({
    ...pr,
    number: 2,
    base: { sha: "c".repeat(40), ref: "release" },
  });
  state.configs["c".repeat(40)] = initialState().config;
  state.checks = [
    fixtureCheck(1, "failure"),
    fixtureCheck(2, "success", "completed", "lint"),
  ];
  await reconcile(db, github, t, clock);
  await reconcile(db, github, { ...t, number: 2 }, clock);
  advance();
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("failure");
  expect(
    state.checks.filter((check) => check.name === CHECK_NAME),
  ).toHaveLength(1);
  expect(
    (await rows(sql`SELECT DISTINCT check_id FROM warden_prs`)).length,
  ).toBe(1);
  expect(state.comments.find((comment) => comment.issue === 1)?.body).toContain(
    "PR #2: Check: test (failure)",
  );
});

test("shared-head bypass is denied while all-normal passing evaluations remain possible", async () => {
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  state.prs.push({ ...pr, number: 2, labels: [] });
  pr.labels = [{ name: "skip warden" }];
  state.checks = [fixtureCheck(1)];
  await webhook("pull_request", {
    action: "labeled",
    label: { name: "skip warden" },
  });
  await workOnce(db, github);
  await reconcile(db, github, t, clock);
  await reconcile(db, github, { ...t, number: 2 }, clock);
  advance();
  await reconcile(db, github, { ...t, number: 2 }, clock);
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("success");
  expect(
    (
      await rows(
        sql`SELECT last_decision->>'phase' AS phase FROM warden_prs WHERE number=1`,
      )
    )[0]?.phase,
  ).toBe("passed");
  expect(
    state.checks.filter((check) => check.name === CHECK_NAME),
  ).toHaveLength(1);
});

test("same-ID check reruns with newer start times invalidate stale success and reject older terminal signals", async () => {
  state.checks = [fixtureCheck(1)];
  await settle();
  await storeSignal(db, t, "check_run", { check_run: fixtureCheck(1) });
  const rerun = {
    ...fixtureCheck(1, null, "in_progress"),
    started_at: "2026-10-01T01:00:00Z",
  };
  await storeSignal(db, t, "check_run", { check_run: rerun });
  await storeSignal(db, t, "check_run", { check_run: fixtureCheck(1) });
  await reconcile(db, github, t, clock);
  expect(gate()?.status).toBe("in_progress");
  state.checks[0] = {
    ...fixtureCheck(1),
    started_at: rerun.started_at,
    completed_at: "2026-10-01T01:01:00Z",
  };
  await settle();
  expect(gate()?.conclusion).toBe("success");
});

test("operational metrics count durable ingress, reconciliation and publication failures", async () => {
  state.checks = [fixtureCheck(1)];
  await webhook();
  await workOnce(db, github);
  await workOnce(db, github);
  expect(
    (
      await rows(
        sql`SELECT value FROM warden_metrics WHERE name='deliveries_accepted'`,
      )
    )[0]?.value,
  ).toBe("1");
  expect(
    (
      await rows(
        sql`SELECT value FROM warden_metrics WHERE name='reconciliations_completed'`,
      )
    )[0]?.value,
  ).toBe("1");
  state.checks = state.checks.filter((check) => check.app.id !== 1);
  await rows(sql`UPDATE warden_gates SET check_id=NULL,published_hash=NULL`);
  state.loseNextWrite = true;
  await expect(reconcile(db, github, t, clock)).rejects.toThrow();
  expect(
    (
      await rows(
        sql`SELECT value FROM warden_metrics WHERE name='publication_errors'`,
      )
    )[0]?.value,
  ).toBe("1");
  const response = await fetch(`${api.url}metrics`);
  expect(response.status).toBe(200);
  expect((await response.json()).queue.lag_seconds >= 0).toBe(true);
});

async function sharedMergeFailure() {
  state.config = state.config.replace(
    "max_duration_seconds: 300",
    "max_duration_seconds: 30",
  );
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  const merge = "c".repeat(40);
  state.prs.push({ ...pr, number: 2, merge_commit_sha: merge });
  state.checks = [
    fixtureCheck(1),
    fixtureCheck(2, "failure", "completed", "merge tests", merge),
  ];
  await reconcile(db, github, t, clock);
  await reconcile(db, github, { ...t, number: 2 }, clock);
  advance();
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("failure");
  return { pr, peer: state.prs[1], merge };
}

test("an ambiguous publication failure resets consecutive empty scans after rollback", async () => {
  await reconcile(db, github, t, clock);
  advance();
  await reconcile(db, github, t, clock);
  expect(
    (await rows(sql`SELECT empty_scans FROM warden_prs`))[0]?.empty_scans,
  ).toBe(2);
  state.comments = [];
  state.loseNextWrite = true;
  advance();
  await expect(reconcile(db, github, t, clock)).rejects.toThrow();
  expect(
    (await rows(sql`SELECT empty_scans,fingerprint FROM warden_prs`))[0],
  ).toMatchObject({ empty_scans: 0, fingerprint: null });
});

test.each([
  "installation",
  "repository",
])("%s suspension during an outstanding PR read cannot be undone by reconciliation", async (scope) => {
  state.checks = [fixtureCheck(1)];
  await webhook();
  await workOnce(db, github);
  await settle();
  await rows(sql`TRUNCATE warden_jobs`);
  state.pullDelayMs = 300;
  const pending = reconcile(db, github, t, clock);
  const until = Date.now() + 5000;
  while (state.pullDelayMs > 0 && Date.now() < until) await Bun.sleep(10);
  expect(state.pullDelayMs).toBe(0);
  await changeLifecycle(
    db,
    1,
    scope === "installation" ? null : 10,
    "suspended",
  );
  expect(await pending).toBeNull();
  expect(
    (await rows(sql`SELECT state,fingerprint FROM warden_prs`))[0],
  ).toMatchObject({ state: "suspended", fingerprint: null });
  await changeLifecycle(db, 1, scope === "installation" ? null : 10, "active");
  expect(
    (await rows(sql`SELECT state,fingerprint FROM warden_prs`))[0],
  ).toMatchObject({ state: "open", fingerprint: null });
  expect(
    (
      await rows(
        sql`SELECT payload FROM warden_jobs WHERE key='reconcile:1/10#1'`,
      )
    )[0]?.payload,
  ).toMatchObject({ wardenRenew: true });
});

test("bulk reactivation waits for head publication and atomically queues unready peers", async () => {
  state.checks = [fixtureCheck(1)];
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  state.prs.push({ ...pr, number: 2 });
  await webhook();
  await workOnce(db, github);
  await reconcile(db, github, t, clock);
  await reconcile(db, github, { ...t, number: 2 }, clock);
  await changeLifecycle(db, 1, 10, "suspended");
  await rows(sql`TRUNCATE warden_jobs`);
  let release: () => void = () => {};
  let ready: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const holder = db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`1/10:${pr.head.sha}`},1))`,
    );
    ready();
    await released;
  });
  await acquired;
  const activation = changeLifecycle(db, 1, 10, "active");
  try {
    const until = Date.now() + 5000;
    let waiting = false;
    while (Date.now() < until) {
      waiting =
        (
          await rows(
            sql`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted`,
          )
        ).length > 0;
      if (waiting) break;
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    expect(
      Array.from(await rows(sql`SELECT state FROM warden_prs ORDER BY number`)),
    ).toEqual([{ state: "suspended" }, { state: "suspended" }]);
    expect(await rows(sql`SELECT 1 FROM warden_jobs`)).toHaveLength(0);
  } finally {
    release();
    await holder;
    await activation;
  }
  expect(
    Array.from(
      await rows(sql`SELECT state,fingerprint FROM warden_prs ORDER BY number`),
    ),
  ).toEqual([
    { state: "open", fingerprint: null },
    { state: "open", fingerprint: null },
  ]);
  const jobs = await rows(sql`SELECT payload FROM warden_jobs`);
  expect(jobs).toHaveLength(2);
  for (const job of jobs)
    expect(job.payload).toMatchObject({ wardenRenew: true });
});

test("a failure first discovered by final verification publishes immediately", async () => {
  state.checks = [fixtureCheck(1)];
  await reconcile(db, github, t, clock);
  advance();
  state.injectedCheck = fixtureCheck(2, "failure", "completed", "late failure");
  state.injectOnCheckRead = 2;
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("failure");
  expect(state.comments[0]?.body).toContain("late failure");
});

test("PR lifecycle membership waits for the shared SHA publication lock", async () => {
  state.checks = [fixtureCheck(1)];
  await settle();
  await rows(sql`TRUNCATE warden_jobs`);
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  state.prs.push({ ...pr, number: 2 });
  const peer = state.prs[1];
  if (!peer) throw new Error("Missing peer");
  let release: () => void = () => {};
  let ready: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const holder = db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`1/10:${pr.head.sha}`},1))`,
    );
    ready();
    await released;
  });
  await acquired;
  let delivery: Promise<void> | undefined;
  try {
    await webhook("pull_request", { action: "opened", pull_request: peer });
    const job = await claim(db, 10);
    if (!job) throw new Error("Missing delivery job");
    delivery = processDelivery(db, github, job);
    const until = Date.now() + 5000;
    let waiting = false;
    while (Date.now() < until) {
      waiting =
        (
          await rows(
            sql`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted`,
          )
        ).length > 0;
      if (waiting) break;
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    expect(
      (await rows(sql`SELECT 1 FROM warden_prs WHERE key='1/10#2'`)).length,
    ).toBe(0);
  } finally {
    release();
    await holder;
    await delivery;
  }
  expect(
    (await rows(sql`SELECT 1 FROM warden_prs WHERE key='1/10#2'`)).length,
  ).toBe(1);
});

test.each([
  "onboarding",
  "check activity",
])("%s readiness renewal waits for shared SHA publication", async (source) => {
  state.checks = [fixtureCheck(1)];
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  state.prs.push({ ...pr, number: 2 });
  await reconcile(db, github, t, clock);
  await reconcile(db, github, { ...t, number: 2 }, clock);
  advance();
  await reconcile(db, github, t, clock);
  await rows(sql`TRUNCATE warden_jobs`);
  await rows(
    sql`UPDATE warden_prs SET window_start=now()-interval '10 seconds'`,
  );
  // Visit the peer first during onboarding, while the head lock represents the
  // other PR's publication after it has already read this peer's readiness.
  if (source === "onboarding") state.prs.reverse();
  const number = source === "onboarding" ? 2 : 1;
  const original = (
    await rows(
      sql`SELECT window_start,fingerprint FROM warden_prs WHERE number=${number}`,
    )
  )[0];
  let release: () => void = () => {};
  let ready: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const holder = db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`1/10:${pr.head.sha}`},1))`,
    );
    ready();
    await released;
  });
  await acquired;
  let renewal: Promise<unknown> | undefined;
  try {
    if (source === "onboarding") renewal = onboardRepository(db, github, t);
    else {
      await webhook("check_run", {
        action: "completed",
        check_run: fixtureCheck(1),
        pull_request: undefined,
      });
      const job = await claim(db, 10);
      if (!job) throw new Error("Missing delivery job");
      renewal = processDelivery(db, github, job);
    }
    const until = Date.now() + 5000;
    let waiting = false;
    while (Date.now() < until) {
      waiting =
        (
          await rows(
            sql`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted`,
          )
        ).length > 0;
      if (waiting) break;
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    expect(
      (
        await rows(
          sql`SELECT window_start,fingerprint FROM warden_prs WHERE number=${number}`,
        )
      )[0],
    ).toEqual(original);
  } finally {
    release();
    await holder;
    await renewal;
  }
  expect(
    (
      await rows(
        sql`SELECT window_start FROM warden_prs WHERE number=${number}`,
      )
    )[0]?.window_start,
  ).not.toEqual(original?.window_start);
});

test("a retried lifecycle delivery retains former-head recovery after its PR transaction committed", async () => {
  const { pr, peer } = await sharedMergeFailure();
  if (!peer) throw new Error("Missing peer");
  await rows(sql`TRUNCATE warden_jobs`);
  peer.head = { sha: "d".repeat(40) };
  peer.merge_commit_sha = null;
  await webhook("pull_request", { action: "synchronize", pull_request: peer });
  const job = await claim(db, 10);
  if (!job) throw new Error("Missing delivery job");
  await rows(
    sql.raw(
      `CREATE FUNCTION warden_test_reject_peer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key='reconcile:1/10#1' THEN RAISE EXCEPTION 'simulated post-commit queue failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER warden_test_reject_peer BEFORE INSERT ON warden_jobs FOR EACH ROW EXECUTE FUNCTION warden_test_reject_peer()`,
    ),
  );
  try {
    let failure: unknown;
    try {
      await processDelivery(db, github, job);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.cause : null).toMatchObject({
      message: "simulated post-commit queue failure",
    });
    expect(
      (await rows(sql`SELECT sha FROM warden_prs WHERE key='1/10#2'`))[0]?.sha,
    ).toBe(peer.head.sha);
    const persisted = (
      await rows(sql`SELECT payload FROM warden_jobs WHERE id=${job.id}::uuid`)
    )[0]?.payload as Record<string, unknown>;
    expect(persisted.wardenAffectedHeads).toContain(pr.head.sha);
  } finally {
    await rows(
      sql.raw(
        "DROP TRIGGER warden_test_reject_peer ON warden_jobs; DROP FUNCTION warden_test_reject_peer()",
      ),
    );
  }
  // Retry the original claim, whose in-memory payload predates the committed intent.
  await processDelivery(db, github, job);
  expect(
    (
      await rows(
        sql`SELECT 1 FROM warden_jobs WHERE key='reconcile:1/10#1' AND NOT completed`,
      )
    ).length,
  ).toBe(1);
  time = new Date();
  await settle();
  expect(gate()?.conclusion).toBe("success");
});

test("renewal intent survives coalescing and stale acknowledgements but is consumed once", async () => {
  await enqueue(db, t, 0, true);
  const first = await claim(db, 10);
  if (!first) throw new Error("Missing renewal job");
  expect(first.payload.wardenRenew).toBe(true);
  await enqueue(db, t);
  await finish(db, first, 0);
  const second = await claim(db, 10);
  if (!second) throw new Error("Missing coalesced job");
  expect(second.payload.wardenRenew).toBe(true);
  await finish(db, second, 0);
  const third = await claim(db, 10);
  if (!third) throw new Error("Missing scheduled job");
  expect(third.payload.wardenRenew).toBeUndefined();
  await finish(db, third);
});

test("a missed head change joining an unready peer cannot deadlock its own queue transaction", async () => {
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  const head = "d".repeat(40);
  state.prs.push({ ...pr, number: 2, head: { sha: head } });
  state.checks = [
    fixtureCheck(1),
    fixtureCheck(2, "success", "completed", "test", head),
  ];
  await reconcile(db, github, t, clock);
  await reconcile(db, github, { ...t, number: 2 }, clock);
  await rows(sql`TRUNCATE warden_jobs`);
  await rows(sql`UPDATE warden_prs SET fingerprint=NULL WHERE number=2`);
  pr.head = { sha: head };
  const boundedUrl = new URL(databaseUrl);
  boundedUrl.searchParams.set("statement_timeout", "5000");
  const bounded = connect(boundedUrl.toString());
  try {
    expect(await reconcile(bounded.db, github, t, clock)).not.toBeNull();
    expect(
      (
        await rows(
          sql`SELECT payload FROM warden_jobs WHERE key='reconcile:1/10#2'`,
        )
      )[0]?.payload,
    ).toMatchObject({ wardenRenew: true });
    expect(gate()?.status).toBe("in_progress");
  } finally {
    await bounded.close();
  }
});

test("reconciliation discovers missed peer closure and durably renews an expired former group", async () => {
  const { peer } = await sharedMergeFailure();
  if (!peer) throw new Error("Missing peer");
  await rows(sql`TRUNCATE warden_jobs`);
  await rows(
    sql`UPDATE warden_prs SET window_start=now()-interval '60 seconds'`,
  );
  peer.state = "closed";
  expect(await reconcile(db, github, { ...t, number: 2 }, clock)).toBeNull();
  expect(
    (
      await rows(
        sql`SELECT payload FROM warden_jobs WHERE key='reconcile:1/10#1'`,
      )
    )[0]?.payload,
  ).toMatchObject({ wardenRenew: true });
  time = new Date();
  await workOnce(db, github, 10, clock);
  advance();
  await rows(sql`UPDATE warden_jobs SET available_at=now()`);
  await workOnce(db, github, 10, clock);
  expect(gate()?.conclusion).toBe("success");
});

test("closing the only blocking shared-head peer wakes and recovers remaining subjects", async () => {
  const { peer } = await sharedMergeFailure();
  if (!peer) throw new Error("Missing peer");
  await rows(sql`TRUNCATE warden_jobs`);
  peer.state = "closed";
  await webhook("pull_request", { action: "closed", pull_request: peer });
  await workOnce(db, github);
  expect(
    (
      await rows(
        sql`SELECT * FROM warden_jobs WHERE key='reconcile:1/10#1' AND NOT completed`,
      )
    ).length,
  ).toBe(1);
  time = new Date();
  await settle();
  expect(gate()?.conclusion).toBe("success");
  expect(
    state.checks.filter((check) => check.name === CHECK_NAME),
  ).toHaveLength(1);
});

test("a force-push leaving a shared head wakes the former group", async () => {
  const { peer } = await sharedMergeFailure();
  if (!peer) throw new Error("Missing peer");
  await rows(sql`TRUNCATE warden_jobs`);
  peer.head = { sha: "d".repeat(40) };
  peer.merge_commit_sha = null;
  await webhook("pull_request", { action: "synchronize", pull_request: peer });
  await workOnce(db, github);
  expect(
    (
      await rows(
        sql`SELECT * FROM warden_jobs WHERE key='reconcile:1/10#1' AND NOT completed`,
      )
    ).length,
  ).toBe(1);
  time = new Date();
  await settle();
  expect(gate()?.conclusion).toBe("success");
});

test("a peer's merge rerun renews expired shared-head evaluations and recovers the group", async () => {
  const { merge } = await sharedMergeFailure();
  await rows(sql`TRUNCATE warden_jobs`);
  await rows(
    sql`UPDATE warden_prs SET window_start=now()-interval '60 seconds'`,
  );
  const rerun = fixtureCheck(3, "success", "completed", "merge tests", merge);
  state.checks.push(rerun);
  await webhook("check_run", {
    action: "completed",
    check_run: rerun,
    pull_request: undefined,
  });
  await workOnce(db, github);
  expect(
    (
      await rows(
        sql`SELECT * FROM warden_jobs WHERE kind='reconcile' AND NOT completed`,
      )
    ).length,
  ).toBe(2);
  time = new Date();
  await reconcile(db, github, t, clock);
  await reconcile(db, github, { ...t, number: 2 }, clock);
  advance();
  await reconcile(db, github, { ...t, number: 2 }, clock);
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("success");
});

test("pending weak-policy callers preserve a stricter peer's known failure", async () => {
  state.config += "checks:\n  ignore_checks: [test]\n";
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  state.prs.push({
    ...pr,
    number: 2,
    base: { sha: "c".repeat(40), ref: "release" },
  });
  state.configs["c".repeat(40)] = initialState().config;
  state.checks = [
    fixtureCheck(1, "failure"),
    fixtureCheck(2, null, "queued", "lint"),
  ];
  await reconcile(db, github, { ...t, number: 2 }, clock);
  expect(gate()?.conclusion).toBe("failure");
  expect(await reconcile(db, github, t, clock)).not.toBe(null);
  expect(gate()?.conclusion).toBe("failure");
  expect(
    state.checks.filter((check) => check.name === CHECK_NAME),
  ).toHaveLength(1);
});

test("final verification's newly discovered ignored check is still evaluated by strict peers", async () => {
  state.config += "checks:\n  ignore_checks: ['optional-*']\n";
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  state.prs.push({
    ...pr,
    number: 2,
    base: { sha: "c".repeat(40), ref: "release" },
  });
  state.configs["c".repeat(40)] = initialState().config;
  state.checks = [fixtureCheck(1)];
  await reconcile(db, github, t, clock);
  await reconcile(db, github, { ...t, number: 2 }, clock);
  advance();
  await reconcile(db, github, { ...t, number: 2 }, clock);
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("success");
  state.injectedCheck = fixtureCheck(
    3,
    "failure",
    "completed",
    "optional-late",
  );
  state.injectOnCheckRead = 2;
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("failure");
});

test("an older same-ID failure cannot overwrite a newer authoritative running rerun", async () => {
  state.checks = [fixtureCheck(1, null, "in_progress")];
  await storeSignal(db, t, "check_run", {
    check_run: fixtureCheck(1, "failure"),
  });
  state.checks[0] = {
    ...fixtureCheck(1, null, "in_progress"),
    started_at: "2026-10-01T01:00:00Z",
  };
  expect(await reconcile(db, github, t, clock)).not.toBe(null);
  expect(gate()?.status).toBe("in_progress");
});

test("deleted settled outputs recover even when the desired decision is unchanged", async () => {
  state.checks = [fixtureCheck(1)];
  await settle();
  state.comments = [];
  state.checks = state.checks.filter((check) => check.app.id !== 1);
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("success");
  expect(state.comments).toHaveLength(1);
  expect(state.comments[0]?.body).toContain("Passed: 1");
});

test.each([
  "check",
  "comment",
])("publication recovers a stale %s id and journals both attempts", async (kind) => {
  state.checks = [fixtureCheck(1)];
  await settle();
  const id = kind === "check" ? gate()?.id : state.comments[0]?.id;
  if (!id) throw new Error("Missing published output");
  const before = (
    await rows(sql`SELECT coalesce(max(id),0) AS id FROM warden_effects`)
  )[0]?.id;
  state.errorStatus = 404;
  state.errorPath =
    kind === "check" ? `/check-runs/${id}` : `/issues/comments/${id}`;
  state.checks[0] = fixtureCheck(1, "failure");

  await reconcile(db, github, t, clock);

  expect(gate()?.conclusion).toBe("failure");
  expect(state.comments[0]?.body).toContain("Checks failed");
  expect(
    state.checks.filter((check) => check.name === CHECK_NAME),
  ).toHaveLength(1);
  expect(state.comments).toHaveLength(1);
  const attempts = await rows(
    sql`SELECT error,result,completed_at FROM warden_effects WHERE kind=${kind} AND id>${before} ORDER BY id`,
  );
  expect(attempts).toHaveLength(2);
  expect(attempts[0]?.error).toBeTruthy();
  expect(attempts[1]).toMatchObject({ error: null, result: { id } });
});

test("authenticated rerequest invalidates the central gate cache and republishes", async () => {
  state.checks = [fixtureCheck(1)];
  await settle();
  const current = gate();
  if (!current) throw new Error("Missing gate");
  const writes = state.requests.filter(
    (request) =>
      request.method === "PATCH" && request.path.includes("check-runs"),
  ).length;
  await webhook("check_run", {
    action: "rerequested",
    check_run: current,
    pull_request: undefined,
  });
  await workOnce(db, github);
  expect(
    (await rows(sql`SELECT published_hash FROM warden_gates`))[0]
      ?.published_hash,
  ).toBe(null);
  time = new Date();
  await settle();
  expect(gate()?.conclusion).toBe("success");
  expect(
    state.requests.filter(
      (request) =>
        request.method === "PATCH" && request.path.includes("check-runs"),
    ).length,
  ).toBeGreaterThan(writes);
  expect(current.actions).toEqual([
    {
      label: "Reconcile now",
      description: "Refresh Warden check state",
      identifier: ACTION_ID,
    },
  ]);
});

for (const conclusion of ["neutral", "skipped"]) {
  test(`strict ${conclusion} completion fails immediately while the API lags`, async () => {
    state.config += "checks:\n  passing_conclusions: [success]\n";
    state.checks = [fixtureCheck(1, null, "in_progress")];
    await reconcile(db, github, t, clock);
    await webhook("check_run", {
      action: "completed",
      check_run: fixtureCheck(1, conclusion),
      pull_request: undefined,
    });
    await workOnce(db, github);
    await workOnce(db, github);
    expect(gate()?.conclusion).toBe("failure");
    expect(state.comments[0]?.body).toContain(conclusion);
  });
}

test("late superseded-job failures retain authoritative workflow supersession", async () => {
  state.checks = [fixtureCheck(1, null, "queued"), fixtureCheck(2)];
  state.workflows = [
    {
      id: 40,
      workflow_id: 9,
      name: "CI",
      path: ".github/workflows/ci.yml",
      run_attempt: 2,
      check_suite_id: 20,
      head_sha: "a".repeat(40),
      status: "completed",
      conclusion: "success",
      html_url: "http://github.local/runs/40",
    },
  ];
  state.jobs = [
    {
      run_id: 40,
      run_attempt: 1,
      check_run_url: "http://github.local/check-runs/1",
      current: false,
    },
    {
      run_id: 40,
      run_attempt: 2,
      check_run_url: "http://github.local/check-runs/2",
      current: true,
    },
  ];
  await storeSignal(db, t, "check_run", {
    check_run: fixtureCheck(1, "failure"),
  });
  await settle();
  expect(gate()?.conclusion).toBe("success");
});

test("timestamp-less same-ID queue receipts require fresh stability and are retry-idempotent", async () => {
  state.checks = [fixtureCheck(1)];
  await settle();
  await storeSignal(db, t, "check_run", { check_run: fixtureCheck(1) });
  const before = (await rows(sql`SELECT generation FROM warden_prs`))[0]
    ?.generation;
  await webhook("check_run", {
    action: "created",
    check_run: { ...fixtureCheck(1, null, "queued"), started_at: null },
    pull_request: undefined,
  });
  const delivery = await claim(db, 10);
  if (!delivery || delivery.kind !== "delivery")
    throw new Error("Missing queued delivery");
  await processDelivery(db, github, delivery);
  await processDelivery(db, github, delivery);
  expect(
    (await rows(sql`SELECT generation,stable_since FROM warden_prs`))[0],
  ).toMatchObject({ generation: Number(before) + 1, stable_since: null });
  expect(
    await rows(
      sql`SELECT id FROM warden_audit WHERE kind='unversioned_pending'`,
    ),
  ).toHaveLength(1);
  time = new Date();
  await reconcile(db, github, t, clock);
  expect(gate()?.status).toBe("in_progress");
  advance();
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("success");
  expect(
    state.checks.filter((check) => check.name === CHECK_NAME),
  ).toHaveLength(1);
});

test("waiting for PR locks does not count toward observed quiet time", async () => {
  state.checks = [fixtureCheck(1)];
  let release = () => {};
  let acquired = () => {};
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('1/10#1',0))`,
    );
    acquired();
    await held;
  });
  const waitFor = async (count: number) => {
    for (let i = 0; i < 100; i++) {
      const waiters = (
        await rows(
          sql`SELECT count(*) AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted`,
        )
      )[0];
      if (Number(waiters?.count) >= count) return;
      await Bun.sleep(10);
    }
    throw new Error("Reconciliation did not wait for its PR lock");
  };
  await ready;
  const first = reconcile(db, github, t, clock);
  let second: Promise<number | null> | undefined;
  try {
    await waitFor(1);
    advance(20);
    second = reconcile(db, github, t, clock);
    await waitFor(2);
  } finally {
    release();
    await holder;
    await first;
    await second;
  }
  expect(gate()?.status).toBe("in_progress");
  expect(
    new Date(
      String(
        (await rows(sql`SELECT stable_since FROM warden_prs`))[0]?.stable_since,
      ),
    ).getTime(),
  ).toBe(time.getTime());
  advance();
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("success");
});

test("a failed initial PR read revokes published success while preserving retry", async () => {
  state.checks = [fixtureCheck(1)];
  await settle();
  await storeSignal(db, t, "check_run", {
    check_run: {
      ...fixtureCheck(2, "failure"),
      completed_at: "2026-10-02T00:00:00Z",
    },
  });
  state.errorPath = "pulls";
  await expect(reconcile(db, github, t, clock)).rejects.toThrow();
  expect(gate()?.conclusion).toBe("failure");
  expect(JSON.stringify(gate()?.output)).toContain("observation error");
  expect(
    (await rows(sql`SELECT stable_since FROM warden_prs`))[0]?.stable_since,
  ).toBe(null);
  state.checks = [fixtureCheck(2, "failure")];
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("failure");
});

test("a failed final PR read cannot discard a blocking observation decision", async () => {
  state.checks = [fixtureCheck(1)];
  await settle();
  const read = github.pull.bind(github);
  let calls = 0;
  github.pull = async (target) => {
    if (++calls === 2) throw new Error("Final PR read unavailable");
    return read(target);
  };
  state.errorPath = "check-runs";
  await expect(reconcile(db, github, t, clock)).rejects.toThrow(
    "Final PR read unavailable",
  );
  expect(gate()?.conclusion).toBe("failure");
});

test("delayed installation suspend and unsuspend deliveries follow authoritative state", async () => {
  state.checks = [fixtureCheck(1)];
  await settle();
  await drainDelivery(
    await webhook("installation", {
      action: "suspend",
      repository: undefined,
      pull_request: undefined,
    }),
  );
  expect(
    (await rows(sql`SELECT state FROM warden_installations`))[0]?.state,
  ).toBe("active");
  state.installationState = "suspended";
  await drainDelivery(
    await webhook("installation", {
      action: "unsuspend",
      repository: undefined,
      pull_request: undefined,
    }),
  );
  expect((await rows(sql`SELECT state FROM warden_prs`))[0]?.state).toBe(
    "suspended",
  );
  state.installationState = "active";
  expect(await onboardInstallation(db, github, 1)).toBe(1);
  expect((await rows(sql`SELECT state FROM warden_prs`))[0]?.state).toBe(
    "open",
  );
});

test("delayed archive and removal deliveries cannot deactivate an accessible repository", async () => {
  state.checks = [fixtureCheck(1)];
  await settle();
  await drainDelivery(
    await webhook("repository", {
      action: "archived",
      pull_request: undefined,
    }),
  );
  expect((await rows(sql`SELECT state FROM warden_prs`))[0]?.state).toBe(
    "open",
  );
  await drainDelivery(
    await webhook("installation_repositories", {
      action: "removed",
      repositories_removed: [{ id: 10 }],
      repository: undefined,
      pull_request: undefined,
    }),
  );
  expect(
    (await rows(sql`SELECT state FROM warden_repositories`))[0]?.state,
  ).toBe("active");
  state.repositories = [];
  await drainDelivery(
    await webhook("installation_repositories", {
      action: "added",
      repositories_added: [{ id: 10, name: "repo", owner: { login: "acme" } }],
      repository: undefined,
      pull_request: undefined,
    }),
  );
  expect(
    (await rows(sql`SELECT state FROM warden_repositories`))[0]?.state,
  ).toBe("removed");
  expect((await rows(sql`SELECT state FROM warden_prs`))[0]?.state).toBe(
    "suspended",
  );
  state.repositories = initialState().repositories;
  expect(await onboardRepository(db, github, t)).toBe(1);
  expect((await rows(sql`SELECT state FROM warden_prs`))[0]?.state).toBe(
    "open",
  );
});

for (const action of ["labeled", "unlabeled"]) {
  test(`a delayed ${action} event preserves a newer verified bypass application`, async () => {
    const pr = state.prs[0];
    if (!pr) throw new Error("Missing PR");
    state.checks = [fixtureCheck(1, "failure")];
    state.permissions.bob = "write";
    pr.labels = [{ name: "skip warden" }];
    await drainDelivery(
      await webhook("pull_request", {
        action: "labeled",
        label: { name: "skip warden" },
        sender: { login: "bob" },
      }),
    );
    await reconcile(db, github, t, clock);
    expect(gate()?.conclusion).toBe("success");
    expect(
      (await rows(sql`SELECT bypass_actor FROM warden_prs`))[0]?.bypass_actor,
    ).toBe("bob");
    await drainDelivery(
      await webhook(
        "pull_request",
        { action, label: { name: "skip warden" }, sender: { login: "alice" } },
        crypto.randomUUID(),
        true,
        false,
      ),
    );
    expect(
      (await rows(sql`SELECT bypass_actor FROM warden_prs`))[0]?.bypass_actor,
    ).toBe("bob");
    await reconcile(db, github, t, clock);
    expect(gate()?.conclusion).toBe("success");
    expect(state.comments[0]?.body).toContain(
      "Bypassed via skip warden by bob",
    );
  });
}

test("unwritable GitHub cannot roll back failed-read readiness invalidation", async () => {
  state.checks = [fixtureCheck(1)];
  await settle();
  const read = github.pull.bind(github);
  const write = github.publishCheck.bind(github);
  github.pull = async () => {
    throw new Error("PR read unavailable");
  };
  github.publishCheck = async () => {
    throw new Error("Checks also unavailable");
  };
  await expect(reconcile(db, github, t, clock)).rejects.toThrow(
    "PR read unavailable",
  );
  expect(
    (
      await rows(
        sql`SELECT stable_since,fingerprint,last_decision->>'state' AS state FROM warden_prs`,
      )
    )[0],
  ).toMatchObject({ stable_since: null, fingerprint: null, state: "failure" });
  expect(
    await rows(sql`SELECT id FROM warden_outputs WHERE NOT published`),
  ).toHaveLength(1);
  github.pull = read;
  github.publishCheck = write;
  time = new Date();
  await reconcile(db, github, t, clock);
  expect(gate()?.status).toBe("in_progress");
  advance();
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("success");
});

test("lifecycle transitions persist even before repository onboarding", async () => {
  await changeLifecycle(db, 1, 10, "removed");
  expect(
    (await rows(sql`SELECT state FROM warden_repositories`))[0]?.state,
  ).toBe("removed");
  await changeLifecycle(db, 1, 10, "active");
  expect(
    (await rows(sql`SELECT state FROM warden_repositories`))[0]?.state,
  ).toBe("active");
});

test("a slow final PR read cannot approve past an unsettled deadline", async () => {
  state.config = state.config.replace(
    "max_duration_seconds: 300",
    "max_duration_seconds: 30",
  );
  state.checks = [fixtureCheck(1)];
  await reconcile(db, github, t, clock);
  advance(20);
  const read = github.pull.bind(github);
  let calls = 0;
  github.pull = async (target) => {
    const current = await read(target);
    if (++calls === 2) advance(20);
    return current;
  };
  expect(await reconcile(db, github, t, clock)).toBe(null);
  expect(gate()?.conclusion).toBe("failure");
  expect(state.comments[0]?.body).toContain("timed out");
});

test("slow final reads cannot approve a peer whose shorter deadline elapsed", async () => {
  state.checks = [fixtureCheck(1)];
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  const peer = {
    ...pr,
    number: 2,
    base: { sha: "c".repeat(40), ref: "release" },
  };
  state.prs.push(peer);
  state.configs[peer.base.sha] = state.config.replace(
    "max_duration_seconds: 300",
    "max_duration_seconds: 30",
  );
  await reconcile(db, github, t, clock);
  await reconcile(db, github, { ...t, number: 2 }, clock);
  advance(20);
  const read = github.pull.bind(github);
  let ownCalls = 0;
  github.pull = async (target) => {
    const current = await read(target);
    if (target.number === 1 && ++ownCalls === 2) advance(20);
    return current;
  };
  expect(await reconcile(db, github, t, clock)).toBe(null);
  expect(gate()?.conclusion).toBe("failure");
  expect(state.comments[0]?.body).toContain(
    "PR #2: observation deadline elapsed",
  );
});

test("a failed bypass-removal delivery blocks until its durable work recovers", async () => {
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  state.checks = [fixtureCheck(1, "failure")];
  pr.labels = [{ name: "skip warden" }];
  await drainDelivery(
    await webhook("pull_request", {
      action: "labeled",
      label: { name: "skip warden" },
    }),
  );
  await workOnce(db, github);
  expect(gate()?.conclusion).toBe("success");
  pr.labels = [];
  await webhook("pull_request", {
    action: "unlabeled",
    label: { name: "skip warden" },
  });
  state.errorPath = "pulls";
  await workOnce(db, github);
  const failed = (
    await rows(
      sql`SELECT id FROM warden_jobs WHERE kind='delivery' AND last_error IS NOT NULL`,
    )
  )[0];
  expect(failed).toBeDefined();
  await workOnce(db, github);
  expect(gate()?.conclusion).toBe("failure");
  expect(state.comments[0]?.body).toContain("failed webhook delivery");
  await rows(
    sql`UPDATE warden_jobs SET available_at=now()-interval '1 second' WHERE id=${String(failed?.id)}::uuid`,
  );
  await workOnce(db, github);
  await workOnce(db, github);
  expect(gate()?.conclusion).toBe("failure");
  expect(
    (await rows(sql`SELECT bypass_actor FROM warden_prs`))[0]?.bypass_actor,
  ).toBe(null);
  expect(
    (
      await rows(
        sql`SELECT completed FROM warden_jobs WHERE id=${String(failed?.id)}::uuid`,
      )
    )[0]?.completed,
  ).toBe(true);
});

test("failed opening of an untracked shared-head PR blocks the existing green gate", async () => {
  state.checks = [fixtureCheck(1)];
  await settle();
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  state.prs.push({
    ...pr,
    number: 2,
    base: { sha: "c".repeat(40), ref: "release" },
  });
  await webhook("pull_request", {
    action: "opened",
    pull_request: state.prs[1],
  });
  state.errorPath = "pulls";
  await workOnce(db, github);
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("failure");
  expect(
    (
      await rows(sql`SELECT delivery_error_jobs FROM warden_prs WHERE number=1`)
    )[0]?.delivery_error_jobs,
  ).toHaveLength(1);
  // Explicit onboarding verifies current membership and complete open-PR
  // discovery, then renews observation without losing the failed event history.
  expect(await onboardInstallation(db, github, 1)).toBe(2);
  expect(
    (
      await rows(sql`SELECT delivery_error_jobs FROM warden_prs WHERE number=1`)
    )[0]?.delivery_error_jobs,
  ).toEqual([]);
  expect(
    await rows(
      sql`SELECT id FROM warden_jobs WHERE kind='delivery' AND last_error IS NOT NULL`,
    ),
  ).toHaveLength(1);
});

test("repository onboarding uses constant membership reads and supports compact event identities", async () => {
  expect(await onboardInstallation(db, github, 1)).toBe(1);
  expect(
    state.requests.filter(
      (request) => request.path === "/installation/repositories",
    ),
  ).toHaveLength(1);
  await drainDelivery(
    await webhook("installation_repositories", {
      action: "added",
      repositories_added: [
        { id: 10, name: "repo", full_name: "acme/repo", private: true },
      ],
      repository: undefined,
      pull_request: undefined,
    }),
  );
  expect(
    (await rows(sql`SELECT state FROM warden_repositories`))[0]?.state,
  ).toBe("active");
  expect(
    state.requests.filter(
      (request) => request.path === "/installation/repositories",
    ),
  ).toHaveLength(1);
});

test("overlapping failed deliveries retain every unresolved recovery barrier", async () => {
  state.checks = [fixtureCheck(1)];
  await settle();
  await webhook("pull_request", { action: "edited" });
  await webhook("pull_request", { action: "edited" });
  const first = await claim(db, 60);
  const second = await claim(db, 60);
  if (
    !first ||
    !second ||
    first.kind !== "delivery" ||
    second.kind !== "delivery"
  )
    throw new Error("Missing deliveries");
  await recoverFailedDelivery(db, first);
  await recoverFailedDelivery(db, second);
  const window = (await rows(sql`SELECT window_start FROM warden_prs`))[0]
    ?.window_start;
  await recoverFailedDelivery(db, first);
  expect(
    (await rows(sql`SELECT window_start FROM warden_prs`))[0]?.window_start,
  ).toEqual(window);
  expect(
    (await rows(sql`SELECT delivery_error_jobs FROM warden_prs`))[0]
      ?.delivery_error_jobs,
  ).toHaveLength(2);
  await processDelivery(db, github, first);
  await finish(db, first);
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("failure");
  await processDelivery(db, github, second);
  await finish(db, second);
  time = new Date();
  await settle();
  expect(gate()?.conclusion).toBe("success");
  expect(
    (await rows(sql`SELECT delivery_error_jobs FROM warden_prs`))[0]
      ?.delivery_error_jobs,
  ).toEqual([]);
});

test("a lifecycle API error cannot leave success while its delivery is unresolved", async () => {
  state.checks = [fixtureCheck(1)];
  await settle();
  const read = github.installationState.bind(github);
  github.installationState = async () => {
    throw new Error("Installation state unavailable");
  };
  await webhook("installation", {
    action: "suspend",
    repository: undefined,
    pull_request: undefined,
  });
  await workOnce(db, github);
  await workOnce(db, github);
  expect(gate()?.conclusion).toBe("failure");
  expect(state.comments[0]?.body).toContain("failed webhook delivery");
  github.installationState = read;
  expect(await onboardInstallation(db, github, 1)).toBe(1);
  time = new Date();
  await settle();
  expect(gate()?.conclusion).toBe("success");
});

test("an unknown current merge signal with failed association lookup blocks and recovers", async () => {
  state.checks = [fixtureCheck(1)];
  await settle();
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  const merge = "c".repeat(40);
  pr.merge_commit_sha = merge;
  const failed = fixtureCheck(2, "failure", "completed", "merge tests", merge);
  state.checks.push(failed);
  await webhook("check_run", {
    action: "completed",
    check_run: failed,
    pull_request: undefined,
  });
  state.errorPath = `commits/${merge}/pulls`;
  await workOnce(db, github);
  const delivery = (
    await rows(
      sql`SELECT id FROM warden_jobs WHERE kind='delivery' AND last_error IS NOT NULL`,
    )
  )[0];
  expect(delivery).toBeDefined();
  await workOnce(db, github);
  expect(gate()?.conclusion).toBe("failure");
  expect(state.comments[0]?.body).toContain("failed webhook delivery");
  await rows(
    sql`UPDATE warden_jobs SET available_at=now()-interval '1 second' WHERE id=${String(delivery?.id)}::uuid`,
  );
  await workOnce(db, github);
  await workOnce(db, github);
  expect(gate()?.conclusion).toBe("failure");
  expect(state.comments[0]?.body).toContain("Check: merge tests (failure)");
  expect(
    (
      await rows(
        sql`SELECT completed FROM warden_jobs WHERE id=${String(delivery?.id)}::uuid`,
      )
    )[0]?.completed,
  ).toBe(true);
});

for (const reused of [false, true]) {
  test(`stale lifecycle paths resolve repository IDs after transfer${reused ? " and path reuse" : ""}`, async () => {
    state.checks = [fixtureCheck(1)];
    await settle();
    const start = state.requests.length;
    state.repositories = [
      { id: 10, name: "renamed", owner: { login: "neworg" }, archived: false },
    ];
    if (reused)
      state.repositories.push({
        id: 11,
        name: "repo",
        owner: { login: "acme" },
        archived: false,
      });
    await drainDelivery(
      await webhook("repository", {
        action: "archived",
        pull_request: undefined,
      }),
    );
    expect(
      (
        await rows(
          sql`SELECT owner,name,state FROM warden_repositories WHERE id=10`,
        )
      )[0],
    ).toMatchObject({ owner: "neworg", name: "renamed", state: "active" });
    expect(
      (
        await rows(sql`SELECT payload FROM warden_jobs WHERE kind='reconcile'`)
      )[0]?.payload,
    ).toMatchObject({ owner: "neworg", repo: "renamed", repositoryId: 10 });
    await settle();
    expect(gate()?.conclusion).toBe("success");
    expect(
      state.requests
        .slice(start)
        .filter((request) => ["POST", "PATCH"].includes(request.method))
        .every((request) => request.path.startsWith("/repos/neworg/renamed/")),
    ).toBe(true);
  });
}

test("queued stale repository names cannot read another repository as their subject", async () => {
  state.repositories = [
    { id: 10, name: "renamed", owner: { login: "neworg" }, archived: false },
    { id: 11, name: "repo", owner: { login: "acme" }, archived: false },
  ];
  expect(await github.pull(t)).toMatchObject({
    owner: "neworg",
    repo: "renamed",
    sha: "a".repeat(40),
  });
  await expect(github.pull({ ...t, repositoryId: 999 })).rejects.toThrow(
    "Repository identity mismatch",
  );
  expect(
    state.requests.filter((request) =>
      ["POST", "PATCH"].includes(request.method),
    ),
  ).toHaveLength(0);
});

test("a repository path changed during observations discards that evaluation", async () => {
  state.checks = [fixtureCheck(1)];
  await reconcile(db, github, t, clock);
  advance();
  const read = github.snapshot.bind(github);
  let moved = false;
  github.snapshot = async (target, sha) => {
    if (!moved) {
      moved = true;
      state.repositories = [
        {
          id: 10,
          name: "renamed",
          owner: { login: "neworg" },
          archived: false,
        },
        { id: 11, name: "repo", owner: { login: "acme" }, archived: false },
      ];
    }
    return read(target, sha);
  };
  const writes = state.requests.filter((request) =>
    ["POST", "PATCH"].includes(request.method),
  ).length;
  expect(await reconcile(db, github, t, clock)).toBe(0);
  expect(gate()?.conclusion).not.toBe("success");
  expect(
    state.requests.filter((request) =>
      ["POST", "PATCH"].includes(request.method),
    ),
  ).toHaveLength(writes);
  github.snapshot = read;
  await reconcile(db, github, t, clock);
  expect(gate()?.status).toBe("in_progress");
  advance();
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).toBe("success");
  expect((await rows(sql`SELECT owner,repo FROM warden_prs`))[0]).toMatchObject(
    { owner: "neworg", repo: "renamed" },
  );
});

test("shared peers must renew their own discovery after a repository transfer", async () => {
  state.checks = [fixtureCheck(1)];
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  state.prs.push({ ...pr, number: 2 });
  const peer = { ...t, number: 2 };
  await reconcile(db, github, t, clock);
  await reconcile(db, github, peer, clock);
  advance();
  await reconcile(db, github, t, clock);
  await reconcile(db, github, peer, clock);
  expect(gate()?.conclusion).toBe("success");
  await rows(sql`TRUNCATE warden_jobs`);
  state.repositories = [
    { id: 10, name: "renamed", owner: { login: "neworg" }, archived: false },
    { id: 11, name: "repo", owner: { login: "acme" }, archived: false },
  ];
  await reconcile(db, github, t, clock);
  advance();
  await reconcile(db, github, t, clock);
  expect(gate()?.conclusion).not.toBe("success");
  expect(state.comments.find((comment) => comment.issue === 1)?.body).toContain(
    "PR #2: Discovery/stability has not completed",
  );
  expect(
    (
      await rows(
        sql`SELECT payload FROM warden_jobs WHERE key='reconcile:1/10#2'`,
      )
    )[0]?.payload,
  ).toMatchObject({ owner: "neworg", repo: "renamed", number: 2 });
  await reconcile(db, github, peer, clock);
  advance();
  await reconcile(db, github, peer, clock);
  expect(gate()?.conclusion).toBe("success");
  expect(
    (await rows(sql`SELECT owner,repo FROM warden_prs WHERE number=2`))[0],
  ).toMatchObject({ owner: "neworg", repo: "renamed" });
});

const observationReads = () =>
  state.requests.filter(
    (request) =>
      request.method === "GET" &&
      (/\/commits\/[^/]+\/(check-runs|check-suites|statuses)$/.test(
        request.path,
      ) ||
        request.path.endsWith("/actions/runs")),
  );

async function evaluateEvent(event: string, data: Record<string, unknown>) {
  await drainDelivery(
    await webhook(event, { ...data, pull_request: undefined }),
  );
  await workOnce(db, github, 10, clock);
}

test("event failure uses tracked state without full scans and preserves scheduled recovery", async () => {
  state.config = state.config.replace(
    "intervals_seconds: [1]",
    "intervals_seconds: [300]",
  );
  state.checks = [fixtureCheck(4, null, "in_progress")];
  await reconcile(db, github, t, clock);
  await enqueue(db, t, 120);
  const before = (
    await rows(
      sql`SELECT available_at FROM warden_jobs WHERE key LIKE 'reconcile:%'`,
    )
  )[0]?.available_at;
  state.requests.length = 0;
  state.errorPath = "check-runs";
  state.errorPage = 1;
  await evaluateEvent("check_run", {
    action: "completed",
    check_run: fixtureCheck(4, "failure"),
  });
  expect(gate()?.conclusion).toBe("failure");
  expect(state.comments[0]?.body).toContain("Checks failed");
  expect(observationReads()).toHaveLength(0);
  expect(
    (
      await rows(sql`SELECT last_decision->>'phase' AS phase FROM warden_prs`)
    )[0]?.phase,
  ).toBe("failed");
  expect(
    (
      await rows(
        sql`SELECT available_at FROM warden_jobs WHERE key LIKE 'reconcile:%'`,
      )
    )[0]?.available_at,
  ).toEqual(before);
  expect(
    await rows(sql`SELECT id FROM warden_observations WHERE source='events'`),
  ).toHaveLength(1);
});

test("event reruns revoke stale success and older completion receipts cannot restore it", async () => {
  state.config = state.config.replace(
    "intervals_seconds: [1]",
    "intervals_seconds: [300]",
  );
  state.checks = [fixtureCheck(1)];
  await settle();
  const running = {
    ...fixtureCheck(1, null, "in_progress"),
    started_at: "2026-10-01T01:00:00Z",
  };
  state.requests.length = 0;
  await evaluateEvent("check_run", { action: "created", check_run: running });
  expect(gate()?.status).toBe("in_progress");
  await evaluateEvent("check_run", {
    action: "completed",
    check_run: fixtureCheck(1),
  });
  expect(gate()?.status).toBe("in_progress");
  expect(observationReads()).toHaveLength(0);
});

test("event success candidates still require complete authoritative final reads", async () => {
  state.config = state.config.replace(
    "intervals_seconds: [1]",
    "intervals_seconds: [300]",
  );
  state.checks = [fixtureCheck(1, null, "in_progress")];
  await reconcile(db, github, t, clock);
  await evaluateEvent("check_run", {
    action: "completed",
    check_run: fixtureCheck(1),
  });
  expect(gate()?.status).toBe("in_progress");
  state.requests.length = 0;
  advance();
  await reconcile(db, github, t, clock, false, true);
  expect(observationReads().length).toBeGreaterThanOrEqual(4);
  expect(gate()?.conclusion).not.toBe("success");
  state.checks[0] = fixtureCheck(1);
  await settle();
  expect(gate()?.conclusion).toBe("success");
});

test("tracked state never crosses a head generation", async () => {
  state.checks = [fixtureCheck(1)];
  await settle();
  const pr = state.prs[0];
  if (!pr) throw new Error("Missing PR");
  pr.head.sha = "d".repeat(40);
  const failing = fixtureCheck(
    2,
    "failure",
    "completed",
    "new head",
    pr.head.sha,
  );
  state.checks.push(failing);
  state.requests.length = 0;
  await evaluateEvent("check_run", { action: "completed", check_run: failing });
  expect(
    observationReads().some((request) => request.path.includes(pr.head.sha)),
  ).toBe(true);
  expect(gate()?.head_sha).toBe(pr.head.sha);
  expect(gate()?.conclusion).toBe("failure");
});

test("event updates cannot advance the scheduled empty-scan policy", async () => {
  state.config =
    state.config.replace("intervals_seconds: [1]", "intervals_seconds: [300]") +
    "checks:\n  ignore_checks: [optional]\n";
  await reconcile(db, github, t, clock);
  state.requests.length = 0;
  for (let id = 1; id <= 3; id++) {
    await evaluateEvent("check_run", {
      action: "completed",
      check_run: fixtureCheck(id, "success", "completed", "optional"),
    });
  }
  expect(
    (await rows(sql`SELECT empty_scans FROM warden_prs`))[0]?.empty_scans,
  ).toBe(1);
  expect(gate()?.conclusion).not.toBe("success");
  expect(observationReads()).toHaveLength(0);
});

test("SDK dispatch retains rate-limit delays on failed durable deliveries", async () => {
  state.errorPath = "pulls";
  state.errorStatus = 429;
  await webhook();
  await workOnce(db, github);
  const failed = (
    await rows(
      sql`SELECT extract(epoch from available_at-now()) AS delay FROM warden_jobs WHERE kind='delivery' AND last_error IS NOT NULL`,
    )
  )[0];
  expect(Number(failed?.delay)).toBeGreaterThan(110);
});

test("combined app accepts signed events, drains work and recovers its inbox after restart", async () => {
  state.checks = [fixtureCheck(1, "failure")];
  let service = await start("app", { ...env, PORT: 0 });
  try {
    // Startup opens the pool lazily. Readiness can report 503 until its first
    // connection succeeds; wait for readiness as the container healthcheck does.
    const readyDeadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      ready = (await fetch(`http://localhost:${service.port}/ready`)).ok;
      if (ready) break;
      await Bun.sleep(50);
    }
    expect(ready).toBe(true);
    const body = JSON.stringify({
      action: "opened",
      installation: { id: 1 },
      repository: { id: 10, name: "repo", owner: { login: "acme" } },
      pull_request: state.prs[0],
    });
    expect(
      (
        await fetch(`http://localhost:${service.port}/webhooks/github`, {
          method: "POST",
          headers: {
            "x-github-event": "pull_request",
            "x-github-delivery": "combined-first",
            "x-hub-signature-256": await webhooks.sign(body),
          },
          body,
        })
      ).status,
    ).toBe(202);
    const deadline = Date.now() + 20000;
    while (gate()?.conclusion !== "failure" && Date.now() < deadline)
      await Bun.sleep(50);
    expect(gate()?.conclusion).toBe("failure");
    await service.stop();
    await webhook(
      "check_run",
      {
        action: "created",
        check_run: {
          ...fixtureCheck(2, null, "in_progress"),
          started_at: "2026-10-01T01:00:00Z",
        },
        pull_request: undefined,
      },
      "combined-restart",
    );
    service = await start("app", { ...env, PORT: 0 });
    const recoveryDeadline = Date.now() + 20000;
    while (gate()?.status !== "in_progress" && Date.now() < recoveryDeadline)
      await Bun.sleep(50);
    expect(gate()?.status).toBe("in_progress");
    expect(
      (
        await rows(
          sql`SELECT completed FROM warden_jobs WHERE key='delivery:combined-restart'`,
        )
      )[0]?.completed,
    ).toBe(true);
    expect(await rows(sql`SELECT id FROM warden_deliveries`)).toHaveLength(2);
  } finally {
    await service.stop();
  }
});

for (const event of ["status", "check_suite", "workflow_run"]) {
  test(`${event} failure updates tracked state without scanning`, async () => {
    state.config = state.config.replace(
      "intervals_seconds: [1]",
      "intervals_seconds: [300]",
    );
    const sha = "a".repeat(40);
    const status = {
      id: 1,
      sha,
      context: "deploy",
      state: "pending",
      updated_at: "2026-10-01T01:00:00Z",
      target_url: null,
    };
    const suite = {
      id: 20,
      app: { id: 2 },
      head_sha: sha,
      status: "queued",
      conclusion: null,
    };
    const workflow = {
      id: 40,
      workflow_id: 9,
      name: "CI",
      path: ".github/workflows/ci.yml",
      run_attempt: 1,
      check_suite_id: 20,
      head_sha: sha,
      status: "queued",
      conclusion: null,
      html_url: "http://github.local/runs/40",
    };
    if (event === "status") state.statuses = [status];
    if (event === "check_suite") state.suites = [suite];
    if (event === "workflow_run") state.workflows = [workflow];
    await reconcile(db, github, t, clock);
    state.requests.length = 0;
    const data =
      event === "status"
        ? {
            ...status,
            id: 2,
            state: "failure",
            updated_at: "2026-10-01T01:01:00Z",
          }
        : event === "check_suite"
          ? {
              check_suite: {
                ...suite,
                status: "completed",
                conclusion: "failure",
              },
            }
          : {
              workflow_run: {
                ...workflow,
                status: "completed",
                conclusion: "failure",
              },
            };
    await evaluateEvent(event, { action: "completed", ...data });
    expect(gate()?.conclusion).toBe("failure");
    expect(
      (
        await rows(sql`SELECT last_decision->>'phase' AS phase FROM warden_prs`)
      )[0]?.phase,
    ).toBe("failed");
    expect(observationReads()).toHaveLength(0);
  });
}

test("final verification recovers a deleted gate after a tracked event", async () => {
  state.checks = [fixtureCheck(1)];
  await settle();
  state.checks = state.checks.filter((check) => check.app.id !== 1);
  await evaluateEvent("check_run", {
    action: "completed",
    check_run: fixtureCheck(1),
  });
  expect(
    state.checks.filter((check) => check.name === CHECK_NAME),
  ).toHaveLength(1);
  expect(gate()?.conclusion).toBe("success");
});

for (const mode of ["app", "api", "worker"] as const) {
  test(`compiled ${mode} entry point starts one server and shuts down cleanly`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "warden-app-test-"));
    const reserve = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = reserve.port;
    await reserve.stop();
    const build = await Bun.build({
      entrypoints: ["src/app.ts"],
      target: "bun",
      outdir: directory,
    });
    expect(build.success).toBe(true);
    state.checks = [fixtureCheck(1, "failure")];
    const child = Bun.spawn(
      [
        process.execPath,
        join(directory, "app.js"),
        ...(mode === "app" ? [] : [mode]),
      ],
      {
        env: {
          ...process.env,
          ...Object.fromEntries(
            Object.entries(env)
              .filter(
                ([key, value]) => key !== "privateKey" && value !== undefined,
              )
              .map(([key, value]) => [key, String(value)]),
          ),
          PORT: String(port),
          WARDEN_WORKER_HEALTH_PORT: String(port),
          WARDEN_PRIVATE_KEY_FILE: "",
          WARDEN_PRIVATE_KEY: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      const deadline = Date.now() + 20000;
      let ready = false;
      while (Date.now() < deadline && child.exitCode === null) {
        try {
          ready = (await fetch(`http://localhost:${port}/ready`)).ok;
        } catch {}
        if (ready) break;
        await Bun.sleep(50);
      }
      expect(ready).toBe(true);
      await webhook();
      if (mode === "api") expect(gate()).toBeUndefined();
      else {
        while (gate()?.conclusion !== "failure" && Date.now() < deadline)
          await Bun.sleep(50);
        expect(gate()?.conclusion).toBe("failure");
      }
      if (mode === "worker")
        expect(
          (
            await fetch(`http://localhost:${port}/webhooks/github`, {
              method: "POST",
            })
          ).status,
        ).toBe(404);
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      const output = await new Response(child.stdout).text();
      expect(output).toContain(`Warden ${mode} listening`);
      expect(output.includes("Warden worker started")).toBe(mode !== "api");
      expect(await new Response(child.stderr).text()).not.toContain(
        "EADDRINUSE",
      );
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      await child.exited;
      await rm(directory, { recursive: true, force: true });
    }
  });
}
