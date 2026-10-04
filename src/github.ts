import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestInterface, RequestParameters } from "@octokit/types";
import { Webhooks } from "@octokit/webhooks";
import { App, Octokit, RequestError } from "octokit";
import { z } from "zod";
import type { Env } from "./env";
import {
  ACTION_ID,
  CHECK_NAME,
  COMMENT_MARKER,
  type Decision,
  type PullRequest,
  type RepositoryIdentity,
  type Snapshot,
  type Target,
} from "./model";

const prSchema = z.object({
  number: z.number(),
  state: z.string(),
  draft: z.boolean().optional(),
  merge_commit_sha: z.string().nullable().optional(),
  head: z.object({ sha: z.string() }),
  base: z.object({
    sha: z.string(),
    ref: z.string(),
    repo: z.object({
      id: z.number(),
      name: z.string(),
      owner: z.object({ login: z.string() }),
    }),
  }),
  labels: z.array(z.object({ name: z.string() })),
});
const checkSchema = z.object({
  id: z.number(),
  name: z.string(),
  head_sha: z.string(),
  app: z.object({ id: z.number() }),
  check_suite: z.object({ id: z.number() }).nullable(),
  status: z.string(),
  conclusion: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  html_url: z.string().nullable(),
  external_id: z.string().nullable().optional(),
});
const statusSchema = z.object({
  id: z.number(),
  context: z.string(),
  state: z.string(),
  updated_at: z.string(),
  target_url: z.string().nullable(),
});
const suiteSchema = z.object({
  id: z.number(),
  app: z.object({ id: z.number() }),
  status: z.string(),
  conclusion: z.string().nullable(),
});
const commentSchema = z.object({
  id: z.number(),
  body: z.string().nullable(),
  user: z.object({ type: z.string() }).nullable(),
  performed_via_github_app: z.object({ id: z.number() }).nullable().optional(),
});
export class GitHubError extends Error {
  constructor(
    message: string,
    public retryAfter: number,
  ) {
    super(message);
  }
}
export class GitHub {
  private client: (installationId: number) => Promise<Octokit>;
  private clientScope = new AsyncLocalStorage<{
    installationId: number;
    client: Octokit;
  }>();
  public readonly webhooks: Webhooks<{ octokit: Octokit }>;
  private configCache = new Map<string, string | null>();
  public requests = 0;
  public readonly appId: number;
  constructor(
    env: Env,
    observe?: (route: string, status: number) => Promise<void>,
  ) {
    this.appId = env.WARDEN_APP_ID;
    const Client = Octokit.plugin((client) => {
      client.hook.wrap("request", async (request, options) => {
        options.headers["x-github-api-version"] = "2022-11-28";
        const route = `${options.method} ${options.url}`;
        this.requests++;
        try {
          const response = await request(options);
          if (response.data == null)
            throw new Error("GitHub returned an empty response body");
          await observe?.(route, response.status);
          return response;
        } catch (error) {
          await observe?.(
            route,
            error instanceof RequestError ? error.status : 0,
          );
          if (error instanceof RequestError) {
            // Octokit's pagination treats 409 as an empty repository. Warden
            // must keep observation errors blocking, never count an empty scan.
            if (error.status === 409)
              throw new Error("GitHub conflict; observation incomplete", {
                cause: error,
              });
            if (error.status === 429 || error.status === 403) {
              const headers = error.response?.headers;
              const wait = Math.max(
                60,
                Number(headers?.["retry-after"]) || 0,
                (Number(headers?.["x-ratelimit-reset"]) || 0) -
                  Date.now() / 1000,
              );
              throw new GitHubError(
                "GitHub permission/rate-limit error; retry deferred",
                Math.min(86400, wait),
              );
            }
          }
          throw error;
        }
      });
    }).defaults({
      baseUrl: env.WARDEN_GITHUB_API_URL,
      request: { timeout: 10000 },
      // The durable queue owns retries, including ambiguous write recovery.
      retry: { enabled: false },
      throttle: { enabled: false },
    });
    if (env.WARDEN_DEMO === "true") {
      const client = new Client({ auth: "warden-local-demo" });
      this.client = async () => client;
      this.webhooks = new Webhooks({
        secret: env.WARDEN_WEBHOOK_SECRET,
        transform: (event) => ({ ...event, octokit: client }),
      });
    } else {
      if (!env.privateKey) throw new Error("GitHub App private key required");
      const app = new App({
        appId: this.appId,
        privateKey: env.privateKey,
        Octokit: Client,
        webhooks: { secret: env.WARDEN_WEBHOOK_SECRET },
      });
      this.webhooks = app.webhooks;
      this.client = (installationId) => {
        const current = this.clientScope.getStore();
        if (current?.installationId === installationId)
          return Promise.resolve(current.client);
        return app.getInstallationOctokit(installationId);
      };
    }
  }
  async withClient<T>(
    installationId: number,
    run: () => Promise<T>,
    client?: Octokit,
  ) {
    return this.clientScope.run(
      { installationId, client: client ?? (await this.client(installationId)) },
      run,
    );
  }
  async installationState(
    installationId: number,
  ): Promise<"active" | "suspended" | "removed"> {
    const client = await this.client(installationId);
    try {
      // auth-app selects JWT authentication for this App endpoint, including
      // suspended installations whose installation tokens cannot be used.
      const value = z
        .object({ id: z.number(), suspended_at: z.string().nullable() })
        .parse(
          (
            await client.rest.apps.getInstallation({
              installation_id: installationId,
            })
          ).data,
        );
      if (value.id !== installationId)
        throw new Error("Installation identity mismatch");
      return value.suspended_at ? "suspended" : "active";
    } catch (error) {
      if (error instanceof RequestError && error.status === 404)
        return "removed";
      throw error;
    }
  }
  async repository(t: Target): Promise<RepositoryIdentity> {
    const client = await this.client(t.installationId);
    if (t.owner && t.repo) {
      try {
        const installation = z.object({ id: z.number() }).parse(
          (
            await client.rest.apps.getRepoInstallation({
              owner: t.owner,
              repo: t.repo,
            })
          ).data,
        );
        if (installation.id === t.installationId) {
          const repo = z
            .object({
              id: z.number(),
              name: z.string(),
              owner: z.object({ login: z.string() }),
              archived: z.boolean(),
            })
            .parse(
              (
                await client.rest.repos.get({
                  owner: t.owner,
                  repo: t.repo,
                })
              ).data,
            );
          if (repo.id === t.repositoryId)
            return {
              owner: repo.owner.login,
              repo: repo.name,
              state: repo.archived ? "suspended" : "active",
            };
        }
      } catch (error) {
        if (error instanceof RequestError && error.status === 404) {
          /* A stale path is resolved by ID below. */
        } else throw error;
      }
    }
    // Check accessible repository IDs, avoiding stale names or public-repository
    // reads that remain possible after removal from the installation.
    const repos = await this.pages(
      client,
      client.rest.apps.listReposAccessibleToInstallation,
      {},
    );
    const repo = repos
      .map((value) =>
        z
          .object({
            id: z.number(),
            name: z.string(),
            owner: z.object({ login: z.string() }),
            archived: z.boolean(),
          })
          .parse(value),
      )
      .find((value) => value.id === t.repositoryId);
    return repo
      ? {
          owner: repo.owner.login,
          repo: repo.name,
          state: repo.archived ? "suspended" : "active",
        }
      : { owner: t.owner, repo: t.repo, state: "removed" };
  }
  private async pages<
    M extends Pick<RequestInterface<{ url: string }>, "endpoint"> &
      ((parameters: never) => Promise<unknown>),
  >(
    client: Octokit,
    method: M,
    parameters: NonNullable<Parameters<M>[0]> & object,
  ): Promise<unknown[]> {
    const options: RequestParameters = parameters;
    const results: unknown[] = [];
    let total = 0;
    let pages = 0;
    for await (const { data, headers } of client.paginate.iterator<unknown>({
      ...method.endpoint({ ...options, per_page: 100, page: 1 }),
    })) {
      const entries: unknown = data;
      if (!Array.isArray(entries)) throw new Error("Malformed GitHub list");
      if ("incomplete_results" in entries && entries.incomplete_results)
        throw new Error("Incomplete GitHub list; refusing success");
      if ("total_count" in entries && entries.total_count !== undefined) {
        total = Math.max(
          total,
          z.number().int().nonnegative().parse(entries.total_count),
        );
        if (
          method.endpoint.DEFAULTS.url?.endsWith("/actions/runs") &&
          total > 1000
        )
          throw new Error(
            "GitHub caps filtered workflow lists at 1000; refusing incomplete discovery",
          );
      }
      results.push(...entries);
      if (
        results.length > 5000 ||
        (++pages >= 50 && headers.link?.includes('rel="next"'))
      )
        throw new Error(
          "GitHub pagination exceeds Warden safety bound (5000); refusing incomplete snapshot",
        );
    }
    if (total > results.length)
      throw new Error("Incomplete GitHub pagination; refusing success");
    return results;
  }
  async openPulls(t: Target) {
    const client = await this.client(t.installationId);
    return this.pages(client, client.rest.pulls.list, {
      owner: t.owner,
      repo: t.repo,
      state: "open",
    });
  }
  async repositories(installationId: number) {
    const client = await this.client(installationId);
    return this.pages(
      client,
      client.rest.apps.listReposAccessibleToInstallation,
      {},
    );
  }
  async pull(t: Target): Promise<PullRequest> {
    const client = await this.client(t.installationId);
    const read = async (target: Target) =>
      (
        await client.rest.pulls.get({
          owner: target.owner,
          repo: target.repo,
          pull_number: target.number,
        })
      ).data;
    let value: unknown;
    try {
      value = await read(t);
    } catch (error) {
      if (!(error instanceof RequestError && error.status === 404)) throw error;
      const repo = await this.repository(t);
      if (repo.state === "removed")
        throw new Error("Repository identity is no longer installed");
      value = await read({ ...t, owner: repo.owner, repo: repo.repo });
    }
    let p = prSchema.parse(value);
    if (p.base.repo.id !== t.repositoryId) {
      const repo = await this.repository(t);
      if (repo.state === "removed")
        throw new Error("Repository identity mismatch");
      p = prSchema.parse(
        await read({ ...t, owner: repo.owner, repo: repo.repo }),
      );
    }
    if (p.base.repo.id !== t.repositoryId || p.number !== t.number)
      throw new Error("PR repository identity mismatch");
    return {
      number: p.number,
      owner: p.base.repo.owner.login,
      repo: p.base.repo.name,
      sha: p.head.sha,
      baseSha: p.base.sha,
      baseRef: p.base.ref,
      mergeSha: p.merge_commit_sha ?? null,
      state: p.state,
      draft: p.draft ?? false,
      labels: p.labels.map((l) => l.name),
    };
  }
  async associated(t: Target, sha: string): Promise<number[]> {
    const client = await this.client(t.installationId);
    return (
      await this.pages(
        client,
        client.rest.repos.listPullRequestsAssociatedWithCommit,
        { owner: t.owner, repo: t.repo, commit_sha: sha },
      )
    )
      .map((p) => prSchema.parse(p))
      .filter(
        (p) =>
          p.state === "open" &&
          (p.head.sha === sha || p.merge_commit_sha === sha),
      )
      .map((p) => p.number);
  }
  async config(t: Target, baseSha: string): Promise<string | null> {
    const client = await this.client(t.installationId);
    const key = `${t.installationId}/${t.repositoryId}:${baseSha}`;
    if (this.configCache.has(key)) return this.configCache.get(key) ?? null;
    if (this.configCache.size > 1000) this.configCache.clear();
    try {
      const content = z.string().parse(
        (
          await client.rest.repos.getContent({
            owner: t.owner,
            repo: t.repo,
            path: ".github/warden.yml",
            ref: baseSha,
            mediaType: { format: "raw" },
          })
        ).data,
      );
      this.configCache.set(key, content);
      return content;
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) {
        // GitHub can hide inaccessible resources behind 404. Confirm that the
        // trusted revision/tree is readable and that the config is truly absent.
        const commit = z.object({ tree: z.object({ sha: z.string() }) }).parse(
          (
            await client.rest.git.getCommit({
              owner: t.owner,
              repo: t.repo,
              commit_sha: baseSha,
            })
          ).data,
        );
        const treeSchema = z.object({
          truncated: z.boolean(),
          tree: z.array(
            z.object({ path: z.string(), type: z.string(), sha: z.string() }),
          ),
        });
        const root = treeSchema.parse(
          (
            await client.rest.git.getTree({
              owner: t.owner,
              repo: t.repo,
              tree_sha: commit.tree.sha,
            })
          ).data,
        );
        if (root.truncated)
          throw new Error(
            "Cannot prove configuration absence from a truncated tree",
          );
        const directory = root.tree.find(
          (entry) => entry.path === ".github" && entry.type === "tree",
        );
        if (directory) {
          const githubTree = treeSchema.parse(
            (
              await client.rest.git.getTree({
                owner: t.owner,
                repo: t.repo,
                tree_sha: directory.sha,
              })
            ).data,
          );
          if (
            githubTree.truncated ||
            githubTree.tree.some((entry) => entry.path === "warden.yml")
          )
            throw new Error(
              "Warden configuration exists or absence cannot be verified; contents read failed",
            );
        }
        this.configCache.set(key, null);
        return null;
      }
      throw error;
    }
  }
  async permission(t: Target, username: string): Promise<string> {
    const client = await this.client(t.installationId);
    const result = z
      .object({ permission: z.string(), role_name: z.string().optional() })
      .parse(
        (
          await client.rest.repos.getCollaboratorPermissionLevel({
            owner: t.owner,
            repo: t.repo,
            username,
          })
        ).data,
      );
    const roles: Record<string, string> = {
      admin: "admin",
      maintain: "write",
      write: "write",
      triage: "read",
      read: "read",
      none: "none",
    };
    const role = result.role_name;
    return role && roles[role] === result.permission ? role : "none";
  }
  async labelApplication(
    t: Target,
    label: string,
  ): Promise<{ id: string; actor: string } | null> {
    const client = await this.client(t.installationId);
    const events = await this.pages(
      client,
      client.rest.issues.listEventsForTimeline,
      { owner: t.owner, repo: t.repo, issue_number: t.number },
    );
    const changes = events
      .filter(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "event" in value &&
          ["labeled", "unlabeled"].includes(String(value.event)),
      )
      .map((value) =>
        z
          .object({
            id: z.number(),
            event: z.string(),
            created_at: z.string(),
            actor: z.object({ login: z.string() }).nullable(),
            label: z.object({ name: z.string() }),
          })
          .parse(value),
      )
      .filter((value) => value.label.name === label)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
    const current = changes.at(-1);
    return current?.event === "labeled" && current.actor
      ? { id: String(current.id), actor: current.actor.login }
      : null;
  }
  async snapshot(t: Target, sha: string): Promise<Snapshot> {
    const client = await this.client(t.installationId);
    const checks = (
      await this.pages(client, client.rest.checks.listForRef, {
        owner: t.owner,
        repo: t.repo,
        ref: sha,
        filter: "all",
      })
    ).map((p) => checkSchema.parse(p));
    if (checks.some((c) => c.head_sha !== sha))
      throw new Error("GitHub returned check for unexpected SHA");
    const statuses = (
      await this.pages(client, client.rest.repos.listCommitStatusesForRef, {
        owner: t.owner,
        repo: t.repo,
        ref: sha,
      })
    ).map((p) => statusSchema.parse(p));
    const suites = (
      await this.pages(client, client.rest.checks.listSuitesForRef, {
        owner: t.owner,
        repo: t.repo,
        ref: sha,
      })
    ).map((p) => suiteSchema.parse(p));
    const workflows = (
      await this.pages(client, client.rest.actions.listWorkflowRunsForRepo, {
        owner: t.owner,
        repo: t.repo,
        head_sha: sha,
      })
    ).map((p) =>
      z
        .object({
          id: z.number(),
          workflow_id: z.number(),
          name: z.string().nullable(),
          path: z.string(),
          run_attempt: z.number().optional(),
          check_suite_id: z.number(),
          head_sha: z.string(),
          status: z.string(),
          conclusion: z.string().nullable(),
          html_url: z.string(),
        })
        .parse(p),
    );
    if (workflows.some((w) => w.head_sha !== sha))
      throw new Error("Unexpected workflow SHA");
    const currentWorkflows = new Map<number, (typeof workflows)[number]>();
    for (const workflow of workflows) {
      const old = currentWorkflows.get(workflow.workflow_id);
      if (
        !old ||
        workflow.id > old.id ||
        (workflow.id === old.id &&
          (workflow.run_attempt ?? 1) > (old.run_attempt ?? 1))
      )
        currentWorkflows.set(workflow.workflow_id, workflow);
    }
    const attemptByCheck = new Map<number, number>();
    const currentJobChecks = new Set<number>();
    for (const workflow of currentWorkflows.values()) {
      const jobs = await this.pages(
        client,
        client.rest.actions.listJobsForWorkflowRun,
        { owner: t.owner, repo: t.repo, run_id: workflow.id, filter: "all" },
      );
      const latestJobs = await this.pages(
        client,
        client.rest.actions.listJobsForWorkflowRun,
        { owner: t.owner, repo: t.repo, run_id: workflow.id, filter: "latest" },
      );
      const allJobChecks = new Set(
        jobs.map(
          (entry) =>
            z
              .object({ check_run_url: z.string().nullable() })
              .parse(entry)
              .check_run_url?.match(/\/check-runs\/(\d+)$/)?.[1],
        ),
      );
      if (jobs.length && !latestJobs.length)
        throw new Error(
          "Current workflow jobs cannot be verified from an empty latest-jobs response",
        );
      for (const entry of latestJobs) {
        const job = z
          .object({ check_run_url: z.string().nullable() })
          .parse(entry);
        const id = job.check_run_url?.match(/\/check-runs\/(\d+)$/)?.[1];
        if (
          !id ||
          !allJobChecks.has(id) ||
          !checks.some(
            (check) =>
              check.id === Number(id) &&
              check.check_suite?.id === workflow.check_suite_id,
          )
        )
          throw new Error(
            "Current workflow job is missing from complete check observations; refusing success",
          );
        currentJobChecks.add(Number(id));
      }
      for (const entry of jobs) {
        const job = z
          .object({
            run_attempt: z.number().optional(),
            check_run_url: z.string().nullable(),
          })
          .parse(entry);
        const checkId = job.check_run_url?.match(/\/check-runs\/(\d+)$/)?.[1];
        if (checkId) attemptByCheck.set(Number(checkId), job.run_attempt ?? 1);
      }
    }
    const workflowBySuite = new Map(
      workflows.map((w) => [w.check_suite_id, w.workflow_id]),
    );
    return {
      workflows: workflows.map((w) => ({
        id: w.id,
        workflowId: w.workflow_id,
        name: w.name ?? String(w.workflow_id),
        path: w.path.split("@")[0] ?? w.path,
        attempt: w.run_attempt ?? 1,
        suiteId: w.check_suite_id,
        sha: w.head_sha,
        status: w.status,
        conclusion: w.conclusion,
        url: w.html_url,
      })),
      checks: checks.map((c) => ({
        sha,
        workflowId: workflowBySuite.get(c.check_suite?.id ?? 0),
        workflowAttempt: attemptByCheck.get(c.id),
        workflowCurrent: attemptByCheck.has(c.id)
          ? currentJobChecks.has(c.id)
          : undefined,
        id: c.id,
        name: c.name,
        appId: c.app.id,
        suiteId: c.check_suite?.id ?? 0,
        status: c.status,
        conclusion: c.conclusion,
        updatedAt: c.completed_at ?? c.started_at ?? "",
        url: c.html_url,
      })),
      statuses: statuses.map((s) => ({
        sha,
        id: s.id,
        context: s.context,
        state: s.state,
        updatedAt: s.updated_at,
        url: s.target_url,
      })),
      suites: suites.map((s) => ({
        sha,
        id: s.id,
        appId: s.app.id,
        status: s.status,
        conclusion: s.conclusion,
      })),
    };
  }
  async findCheck(t: Target, sha: string): Promise<number | null> {
    const client = await this.client(t.installationId);
    const externalId = `warden:${t.installationId}/${t.repositoryId}:${sha}`;
    const runs = (
      await this.pages(client, client.rest.checks.listForRef, {
        owner: t.owner,
        repo: t.repo,
        ref: sha,
        check_name: CHECK_NAME,
        filter: "all",
      })
    )
      .map((p) => checkSchema.parse(p))
      .filter((c) => c.app.id === this.appId && c.external_id === externalId);
    return runs.sort((a, b) => b.id - a.id)[0]?.id ?? null;
  }
  async findComment(t: Target): Promise<number | null> {
    const client = await this.client(t.installationId);
    const comments = (
      await this.pages(client, client.rest.issues.listComments, {
        owner: t.owner,
        repo: t.repo,
        issue_number: t.number,
      })
    ).map((p) => commentSchema.parse(p));
    return (
      comments.find(
        (c) =>
          c.body?.startsWith(COMMENT_MARKER) &&
          c.user?.type === "Bot" &&
          c.performed_via_github_app?.id === this.appId,
      )?.id ?? null
    );
  }
  async commentExists(t: Target, id: number): Promise<boolean> {
    const client = await this.client(t.installationId);
    try {
      const comment = commentSchema.parse(
        (
          await client.rest.issues.getComment({
            owner: t.owner,
            repo: t.repo,
            comment_id: id,
          })
        ).data,
      );
      return (
        comment.body?.startsWith(COMMENT_MARKER) === true &&
        comment.user?.type === "Bot" &&
        comment.performed_via_github_app?.id === this.appId
      );
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) return false;
      throw error;
    }
  }
  async publishCheck(
    t: Target,
    sha: string,
    decision: Decision,
    id: number | null,
  ): Promise<number> {
    const client = await this.client(t.installationId);
    const summary = [decision.reason, ...decision.blockers.map((b) => `- ${b}`)]
      .join("\n")
      .slice(0, 60000);
    const status: "in_progress" | "completed" =
      decision.state === "pending" ? "in_progress" : "completed";
    const fields = {
      owner: t.owner,
      repo: t.repo,
      name: CHECK_NAME,
      external_id: `warden:${t.installationId}/${t.repositoryId}:${sha}`,
      status,
      ...(decision.state !== "pending"
        ? { conclusion: decision.state, completed_at: new Date().toISOString() }
        : {}),
      output: { title: decision.reason.slice(0, 255), summary },
      actions: [
        {
          label: "Reconcile now",
          description: "Refresh Warden check state",
          identifier: ACTION_ID,
        },
      ],
    };
    const data =
      id === null
        ? (
            await client.rest.checks.create({
              ...fields,
              head_sha: sha,
            })
          ).data
        : (await client.rest.checks.update({ ...fields, check_run_id: id }))
            .data;
    return z.object({ id: z.number() }).parse(data).id;
  }
  async publishComment(
    t: Target,
    sha: string,
    decision: Decision,
    id: number | null,
    timing?: { last: string; next: string | null },
  ): Promise<number> {
    const client = await this.client(t.installationId);
    const escapeText = (v: string) =>
      v.replace(/[@<>&`*_[\]\\]/g, (c) => `&#${c.charCodeAt(0)};`);
    const counts = { passed: 0, running: 0, failed: 0, ignored: 0 };
    for (const detail of decision.details ?? []) counts[detail.state]++;
    const body =
      `${COMMENT_MARKER}\n## Warden\n\n**${escapeText(decision.reason)}**\n\nHead: \`${sha}\`\n\nPassed: ${counts.passed} · Running: ${counts.running} · Failed: ${counts.failed} · Ignored: ${counts.ignored}.\n\n${timing ? `Last complete reconciliation: ${timing.last}. Next retry: ${timing.next ?? "none (settled)"}.\n\n` : ""}${decision.blockers.map((b) => `- ${escapeText(b)}`).join("\n")}\n\n${decision.details?.map((d) => `- ${escapeText(d.state)} ${escapeText(d.kind)}: ${escapeText(d.name)}${d.url && /^https?:\/\//.test(d.url) ? ` ([details](${d.url.replace(/[()<>\s]/g, encodeURIComponent)}))` : ""}`).join("\n") ?? ""}\n\n${decision.applicable} applicable checks/statuses. Use **Reconcile now** on the Warden check to refresh.`.slice(
        0,
        60000,
      );
    const data =
      id === null
        ? (
            await client.rest.issues.createComment({
              owner: t.owner,
              repo: t.repo,
              issue_number: t.number,
              body,
            })
          ).data
        : (
            await client.rest.issues.updateComment({
              owner: t.owner,
              repo: t.repo,
              comment_id: id,
              body,
            })
          ).data;
    return z.object({ id: z.number() }).parse(data).id;
  }
}
