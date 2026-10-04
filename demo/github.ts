// Test-only HTTP fixture. Production uses Octokit.

import { type Context, Hono } from "hono";
import { z } from "zod";
import { CHECK_NAME } from "../src/model";

const checkWrite = z.object({
  actions: z
    .array(
      z.object({
        label: z.string().max(20),
        identifier: z.string().max(20),
        description: z.string().max(40),
      }),
    )
    .max(3)
    .optional(),
});
export type FixtureCheck = {
  id: number;
  name: string;
  head_sha: string;
  app: { id: number };
  check_suite: { id: number };
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string;
  external_id?: string;
  output?: unknown;
  actions?: unknown;
};
export type FixturePR = {
  number: number;
  state: string;
  draft: boolean;
  head: { sha: string };
  base: {
    sha: string;
    ref: string;
    repo?: { id: number; name: string; owner: { login: string } };
  };
  merge_commit_sha?: string | null;
  labels: { name: string }[];
};
export type FixtureState = {
  installationState: "active" | "suspended" | "removed";
  repositories: {
    id: number;
    name: string;
    owner: { login: string };
    archived: boolean;
  }[];
  prs: FixturePR[];
  checks: FixtureCheck[];
  statuses: Record<string, unknown>[];
  suites: Record<string, unknown>[];
  workflows: Record<string, unknown>[];
  jobs: Record<string, unknown>[] | null;
  timeline: {
    id: number;
    issue: number;
    event: string;
    created_at: string;
    actor: { login: string };
    label: { name: string };
  }[];
  comments: {
    id: number;
    issue: number;
    body: string;
    user: { type: string };
    performed_via_github_app: { id: number };
  }[];
  config: string;
  configs: Record<string, string>;
  missingConfig: boolean;
  inaccessibleTree: boolean;
  injectOnCheckRead: number;
  injectedCheck: FixtureCheck | null;
  permissions: Record<string, string>;
  roles: Record<string, string | null>;
  requests: { method: string; path: string; query: string }[];
  nextId: number;
  errorNext: number;
  errorPath: string | null;
  errorPage: number | null;
  errorStatus: number;
  truncatePage: number | null;
  loseNextWrite: boolean;
  pullDelayMs: number;
  raceSha: string | null;
  raceBaseRef: string | null;
  raceAfter: number;
};
export function initialState(): FixtureState {
  return {
    installationState: "active",
    repositories: [
      { id: 10, name: "repo", owner: { login: "acme" }, archived: false },
    ],
    prs: [
      {
        number: 1,
        state: "open",
        draft: false,
        head: { sha: "a".repeat(40) },
        base: {
          sha: "b".repeat(40),
          ref: "main",
          repo: { id: 10, name: "repo", owner: { login: "acme" } },
        },
        labels: [],
      },
    ],
    checks: [],
    statuses: [],
    suites: [],
    workflows: [],
    jobs: null,
    timeline: [],
    comments: [],
    config:
      "version: 1\nreconciliation:\n  intervals_seconds: [1]\n  max_duration_seconds: 300\n  initial_grace_seconds: 0\n  quiet_period_seconds: 1\ncomment:\n  min_update_interval_seconds: 0\n",
    missingConfig: false,
    inaccessibleTree: false,
    configs: {},
    injectOnCheckRead: 0,
    injectedCheck: null,
    permissions: { alice: "write", mallory: "read" },
    roles: {},
    requests: [],
    nextId: 1000,
    errorNext: 0,
    errorPath: null,
    errorPage: null,
    errorStatus: 503,
    truncatePage: null,
    loseNextWrite: false,
    pullDelayMs: 0,
    raceSha: null,
    raceBaseRef: null,
    raceAfter: 0,
  };
}
export function fixtureCheck(
  id: number,
  conclusion: string | null = "success",
  status = "completed",
  name = "test",
  sha = "a".repeat(40),
): FixtureCheck {
  return {
    id,
    name,
    head_sha: sha,
    app: { id: 2 },
    check_suite: { id: 20 },
    status,
    conclusion,
    started_at: "2026-10-01T00:00:00Z",
    completed_at: status === "completed" ? "2026-10-01T00:01:00Z" : null,
    html_url: `http://github.local/checks/${id}`,
  };
}
export function createFixture(initial = initialState()) {
  let state = initial;
  const app = new Hono();
  // Admin endpoints exist only in this fixture, on a dedicated demo network.
  app.get("/health", (c) =>
    c.json({ status: "ok", service: "warden-fake-github" }),
  );
  app.get("/__state", (c) => c.json(state));
  app.post("/__state", async (c) => {
    state = { ...state, ...(await c.req.json()) };
    return c.json(state);
  });
  app.post("/__reset", (c) => {
    state = initialState();
    return c.json(state);
  });
  app.use("*", async (c, next) => {
    if (c.req.path === "/health" || c.req.path.startsWith("/__")) return next();
    state.requests.push({
      method: c.req.method,
      path: c.req.path,
      query: new URL(c.req.url).search,
    });
    if (
      state.errorPath &&
      c.req.path.includes(state.errorPath) &&
      (!state.errorPage || Number(c.req.query("page")) === state.errorPage)
    ) {
      state.errorPath = null;
      state.errorPage = null;
      return new Response(
        JSON.stringify({ message: "Injected partial observation failure" }),
        {
          status: state.errorStatus,
          headers: { "content-type": "application/json", "retry-after": "120" },
        },
      );
    }
    if (state.errorNext) {
      const status = state.errorNext;
      state.errorNext = 0;
      return new Response(
        JSON.stringify({ message: "Injected fixture failure" }),
        {
          status,
          headers: { "content-type": "application/json", "retry-after": "1" },
        },
      );
    }
    if (
      c.req.header("authorization") !== "token warden-local-demo" &&
      c.req.header("authorization") !== "Bearer warden-local-demo"
    )
      return c.json({ message: "Unauthorized fixture request" }, 401);
    if (state.pullDelayMs > 0 && /\/pulls\/\d+$/.test(c.req.path)) {
      const delay = state.pullDelayMs;
      state.pullDelayMs = 0;
      await Bun.sleep(delay);
    }
    await next();
  });
  const paginate = (data: unknown[], c: Context) => {
    const page = Number(c.req.query("page") ?? 1);
    const n = Number(c.req.query("per_page") ?? 100);
    if (page * n < data.length) {
      const next = new URL(c.req.url);
      next.searchParams.set("page", String(page + 1));
      c.header("Link", `<${next}>; rel="next"`);
    }
    return data.slice((page - 1) * n, page * n);
  };
  app.get("/repos/:owner/:repo/pulls", (c) =>
    c.json(
      paginate(
        state.prs.filter((p) => p.state === "open"),
        c,
      ),
    ),
  );
  app.get("/app/installations/:id", (c) =>
    state.installationState === "removed"
      ? c.json({ message: "Not found" }, 404)
      : c.json({
          id: Number(c.req.param("id")),
          suspended_at:
            state.installationState === "suspended"
              ? "2026-10-02T00:00:00Z"
              : null,
        }),
  );
  app.get("/installation/repositories", (c) =>
    c.json({
      total_count: state.repositories.length,
      repositories: paginate(state.repositories, c),
    }),
  );
  app.get("/repos/:owner/:repo/installation", (c) =>
    state.repositories.some(
      (repo) =>
        repo.owner.login === c.req.param("owner") &&
        repo.name === c.req.param("repo"),
    )
      ? c.json({ id: 1 })
      : c.json({ message: "Not found" }, 404),
  );
  app.get("/repos/:owner/:repo", (c) => {
    const repo = state.repositories.find(
      (repo) =>
        repo.owner.login === c.req.param("owner") &&
        repo.name === c.req.param("repo"),
    );
    return repo ? c.json(repo) : c.json({ message: "Not found" }, 404);
  });
  app.get("/repos/:owner/:repo/actions/runs", (c) =>
    c.json({
      total_count: state.workflows.filter(
        (w) => w.head_sha === c.req.query("head_sha"),
      ).length,
      workflow_runs: paginate(
        state.workflows.filter((w) => w.head_sha === c.req.query("head_sha")),
        c,
      ),
    }),
  );
  app.get("/repos/:owner/:repo/actions/runs/:id/jobs", (c) => {
    const workflow = state.workflows.find(
      (w) => Number(w.id) === Number(c.req.param("id")),
    );
    const jobs = (
      state.jobs ??
      state.checks
        .filter((check) => check.check_suite.id === workflow?.check_suite_id)
        .map((check) => ({
          run_attempt: workflow?.run_attempt ?? 1,
          check_run_url: `http://github.local/repos/acme/repo/check-runs/${check.id}`,
        }))
    )
      .filter(
        (job) =>
          !state.jobs ||
          !job.run_id ||
          Number(job.run_id) === Number(c.req.param("id")),
      )
      .filter(
        (job) => c.req.query("filter") !== "latest" || job.current !== false,
      );
    return c.json({ total_count: jobs.length, jobs: paginate(jobs, c) });
  });
  app.get("/repos/:owner/:repo/pulls/:number", (c) => {
    if ((state.raceSha || state.raceBaseRef) && --state.raceAfter <= 0) {
      const p = state.prs[0];
      if (p && state.raceSha) p.head.sha = state.raceSha;
      if (p && state.raceBaseRef) p.base.ref = state.raceBaseRef;
      state.raceSha = null;
      state.raceBaseRef = null;
    }
    const p = state.prs.find((p) => p.number === Number(c.req.param("number")));
    const repo = state.repositories.find(
      (repo) =>
        repo.owner.login === c.req.param("owner") &&
        repo.name === c.req.param("repo"),
    );
    return p && repo
      ? c.json({ ...p, base: { ...p.base, repo } })
      : c.json({ message: "Not Found" }, 404);
  });
  app.get("/repos/:owner/:repo/commits/:sha/pulls", (c) =>
    c.json(
      paginate(
        state.prs
          .filter((p) => p.head.sha === c.req.param("sha"))
          .map((p) => ({
            ...p,
            base: {
              ...p.base,
              repo: state.repositories.find(
                (repo) =>
                  repo.owner.login === c.req.param("owner") &&
                  repo.name === c.req.param("repo"),
              ),
            },
          })),
        c,
      ),
    ),
  );
  app.get("/repos/:owner/:repo/contents/*", (c) => {
    if (!state.prs.some((p) => p.base.sha === c.req.query("ref")))
      return c.json({ message: "Untrusted config ref" }, 403);
    if (state.missingConfig) return c.json({ message: "Not Found" }, 404);
    if (
      !/application\/vnd\.github(?:\.v3)?\.raw\b/.test(
        c.req.header("accept") ?? "",
      )
    )
      return c.json({ message: "Raw content media type required" }, 406);
    return c.text(state.configs[c.req.query("ref") ?? ""] ?? state.config);
  });
  app.get("/repos/:owner/:repo/git/commits/:sha", (c) =>
    state.inaccessibleTree
      ? c.json({ message: "Not Found" }, 404)
      : c.json({ tree: { sha: "root-tree" } }),
  );
  app.get("/repos/:owner/:repo/git/trees/:sha", (c) =>
    c.json({ truncated: false, tree: [] }),
  );
  app.get("/repos/:owner/:repo/collaborators/:login/permission", (c) =>
    c.json({
      permission: state.permissions[c.req.param("login")] ?? "read",
      role_name:
        state.roles[c.req.param("login")] === null
          ? undefined
          : (state.roles[c.req.param("login")] ??
            state.permissions[c.req.param("login")] ??
            "read"),
    }),
  );
  app.get("/repos/:owner/:repo/commits/:sha/check-runs", (c) => {
    if (
      !c.req.query("check_name") &&
      state.injectedCheck &&
      --state.injectOnCheckRead <= 0
    ) {
      state.checks.push(state.injectedCheck);
      state.injectedCheck = null;
    }
    const checks = state.checks.filter(
      (v) =>
        v.head_sha === c.req.param("sha") &&
        (!c.req.query("check_name") || v.name === c.req.query("check_name")),
    );
    return c.json({
      total_count: checks.length,
      check_runs:
        state.truncatePage === Number(c.req.query("page"))
          ? []
          : paginate(checks, c),
    });
  });
  app.get("/repos/:owner/:repo/commits/:sha/statuses", (c) =>
    c.json(
      paginate(
        state.statuses.filter((s) => s.sha === c.req.param("sha")),
        c,
      ),
    ),
  );
  app.get("/repos/:owner/:repo/commits/:sha/check-suites", (c) =>
    c.json({
      total_count: state.suites.filter((s) => s.head_sha === c.req.param("sha"))
        .length,
      check_suites: paginate(
        state.suites.filter((s) => s.head_sha === c.req.param("sha")),
        c,
      ),
    }),
  );
  app.post("/repos/:owner/:repo/check-runs", async (c) => {
    const body = await c.req.json();
    if (!checkWrite.safeParse(body).success)
      return c.json(
        { message: "Invalid GitHub check action constraints" },
        422,
      );
    const run = {
      ...fixtureCheck(state.nextId++, null, "in_progress", CHECK_NAME),
      ...body,
      app: { id: 1 },
      check_suite: { id: 999 },
    };
    state.checks.push(run);
    if (state.loseNextWrite) {
      state.loseNextWrite = false;
      return c.json({ message: "Lost response after successful write" }, 500);
    }
    return c.json(run, 201);
  });
  app.patch("/repos/:owner/:repo/check-runs/:id", async (c) => {
    const run = state.checks.find((v) => v.id === Number(c.req.param("id")));
    if (!run) return c.json({ message: "Not Found" }, 404);
    const update = await c.req.json();
    if (!checkWrite.safeParse(update).success)
      return c.json(
        { message: "Invalid GitHub check action constraints" },
        422,
      );
    Object.assign(run, update);
    if (update.status !== "completed") run.conclusion = null;
    return c.json(run);
  });
  app.get("/repos/:owner/:repo/issues/:number/timeline", (c) =>
    c.json(
      paginate(
        state.timeline.filter(
          (event) => event.issue === Number(c.req.param("number")),
        ),
        c,
      ),
    ),
  );
  app.get("/repos/:owner/:repo/issues/:number/comments", (c) =>
    c.json(
      paginate(
        state.comments.filter((v) => v.issue === Number(c.req.param("number"))),
        c,
      ),
    ),
  );
  app.get("/repos/:owner/:repo/issues/comments/:id", (c) => {
    const comment = state.comments.find(
      (item) => item.id === Number(c.req.param("id")),
    );
    return comment ? c.json(comment) : c.json({ message: "Not Found" }, 404);
  });
  app.post("/repos/:owner/:repo/issues/:number/comments", async (c) => {
    const body = await c.req.json();
    const comment = {
      id: state.nextId++,
      issue: Number(c.req.param("number")),
      body: body.body,
      user: { type: "Bot" },
      performed_via_github_app: { id: 1 },
    };
    state.comments.push(comment);
    if (state.loseNextWrite) {
      state.loseNextWrite = false;
      return c.json({ message: "Lost comment response" }, 500);
    }
    return c.json(comment, 201);
  });
  app.patch("/repos/:owner/:repo/issues/comments/:id", async (c) => {
    const comment = state.comments.find(
      (v) => v.id === Number(c.req.param("id")),
    );
    if (!comment) return c.json({ message: "Not Found" }, 404);
    Object.assign(comment, await c.req.json());
    return c.json(comment);
  });
  return { app, getState: () => state };
}
if (import.meta.main) {
  const server = Bun.serve({
    port: Number(process.env.PORT ?? 4000),
    fetch: createFixture().app.fetch,
  });
  console.log(
    `Warden fixture GitHub HTTP service on ${server.port}; aggregate ${CHECK_NAME}`,
  );
}
