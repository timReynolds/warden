import { createHash } from "node:crypto";
import type { Policy } from "./config";
import {
  CHECK_NAME,
  type Check,
  canonicalJson,
  type Decision,
  type Detail,
  type Snapshot,
  type Workflow,
} from "./model";
export type Evaluation = Omit<Decision, "state" | "phase"> &
  (
    | { state: "failure"; phase: "failed" }
    | { state: "pending"; phase: "running" | "discovery" }
    | { state: "success"; phase: "passed" }
  );

export function matches(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) =>
    new RegExp(
      `^${pattern
        .split("*")
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    ).test(name),
  );
}
export function ignoredWorkflow(w: Workflow, policy: Policy): boolean {
  return policy.checks.ignore_workflows.some((match) =>
    "id" in match
      ? match.id === w.workflowId
      : "path" in match
        ? matches(w.path, [match.path])
        : matches(w.name, [match.name]),
  );
}
export function evaluate(
  snapshot: Snapshot,
  policy: Policy,
  appId: number,
): Evaluation {
  const workflows = new Map<number, Workflow>();
  const currentWorkflows = new Map<string, Workflow>();
  for (const w of snapshot.workflows) {
    const key = `${w.sha}:${w.workflowId}`;
    const old = currentWorkflows.get(key);
    if (!old || w.id > old.id || (w.id === old.id && w.attempt > old.attempt))
      currentWorkflows.set(key, w);
  }
  for (const w of snapshot.workflows) workflows.set(w.suiteId, w);
  const latest = new Map<string, Check>();
  const details: Detail[] = [];
  for (const c of snapshot.checks) {
    if (c.appId === appId && c.name === CHECK_NAME) continue;
    const w = workflows.get(c.suiteId);
    if (
      w &&
      currentWorkflows.get(`${w.sha}:${w.workflowId}`)?.suiteId !== w.suiteId
    )
      continue;
    // A partial rerun retains untouched jobs. Only the jobs API's latest set can
    // prove a specific execution was superseded; a run-wide attempt cutoff cannot.
    if (c.workflowCurrent === false) continue;
    // Jobs within one workflow attempt can have identical display names. Their
    // check IDs are distinct; explicit job-attempt metadata removes older reruns.
    const key = `${c.sha}:${c.appId}:${w?.workflowId ?? c.workflowId ?? "external"}:${w ? c.id : c.name}`;
    const previous = latest.get(key);
    if (!previous || c.id > previous.id) latest.set(key, c);
  }
  const statuses = new Map<string, Snapshot["statuses"][number]>();
  for (const s of snapshot.statuses) {
    const key = `${s.sha}:${s.context}`;
    const old = statuses.get(key);
    if (
      !old ||
      s.updatedAt > old.updatedAt ||
      (s.updatedAt === old.updatedAt && s.id > old.id)
    )
      statuses.set(key, s);
  }
  const pending: string[] = [];
  const failed: string[] = [];
  let applicable = 0;
  const accepted = new Set<string>(policy.checks.passing_conclusions);
  for (const c of latest.values()) {
    const w = workflows.get(c.suiteId);
    const ignored =
      matches(c.name, policy.checks.ignore_checks) ||
      (w !== undefined && ignoredWorkflow(w, policy));
    const state = ignored
      ? "ignored"
      : c.status !== "completed"
        ? "running"
        : accepted.has(c.conclusion ?? "")
          ? "passed"
          : "failed";
    details.push({
      kind: "check",
      name: `${c.name}${w ? ` [${w.name}]` : ""} (${c.sha.slice(0, 7)})`,
      state,
      url: c.url,
    });
    if (ignored) continue;
    applicable++;
    if (state === "running") pending.push(`Check: ${c.name} (${c.status})`);
    else if (state === "failed")
      failed.push(`Check: ${c.name} (${c.conclusion ?? "unknown"})`);
  }
  for (const s of statuses.values()) {
    const ignored = matches(s.context, policy.checks.ignore_statuses);
    const state = ignored
      ? "ignored"
      : s.state === "pending"
        ? "running"
        : s.state === "success"
          ? "passed"
          : "failed";
    details.push({
      kind: "status",
      name: `${s.context} (${s.sha.slice(0, 7)})`,
      state,
      url: s.url,
    });
    if (ignored) continue;
    applicable++;
    if (state === "running") pending.push(`Status: ${s.context} (pending)`);
    else if (state === "failed")
      failed.push(`Status: ${s.context} (${s.state})`);
  }
  for (const w of currentWorkflows.values()) {
    if (ignoredWorkflow(w, policy)) {
      details.push({
        kind: "workflow",
        name: w.name,
        state: "ignored",
        url: w.url,
      });
      continue;
    }
    if (w.status !== "completed") {
      pending.push(`Workflow: ${w.name} (${w.status})`);
      details.push({
        kind: "workflow",
        name: w.name,
        state: "running",
        url: w.url,
      });
    } else if (
      ![...latest.values()].some((c) => c.suiteId === w.suiteId) &&
      !accepted.has(w.conclusion ?? "")
    ) {
      failed.push(`Workflow startup: ${w.name} (${w.conclusion ?? "unknown"})`);
      details.push({
        kind: "workflow",
        name: w.name,
        state: "failed",
        url: w.url,
      });
    }
  }
  const eligibleSuites: Snapshot["suites"] = [];
  for (const suite of snapshot.suites) {
    if (suite.appId === appId) continue;
    const w = workflows.get(suite.id);
    if (
      w &&
      (ignoredWorkflow(w, policy) ||
        currentWorkflows.get(`${w.sha}:${w.workflowId}`)?.suiteId !== suite.id)
    )
      continue;
    const runs = [...latest.values()].filter((c) => c.suiteId === suite.id);
    if (
      runs.length &&
      runs.every((c) => matches(c.name, policy.checks.ignore_checks))
    )
      continue;
    eligibleSuites.push(suite);
    if (suite.status !== "completed") {
      pending.push(`Check suite: ${suite.id} (${suite.status})`);
      details.push({
        kind: "suite",
        name: String(suite.id),
        state: "running",
        url: null,
      });
    } else if (!runs.length && !accepted.has(suite.conclusion ?? "")) {
      failed.push(
        `Check suite startup: ${suite.id} (${suite.conclusion ?? "unknown"})`,
      );
      details.push({
        kind: "suite",
        name: String(suite.id),
        state: "failed",
        url: null,
      });
    }
  }
  details.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
  );
  const fingerprint = createHash("sha256")
    .update(
      canonicalJson({
        checks: [...latest.values()]
          .filter((c) => {
            const w = workflows.get(c.suiteId);
            return (
              !matches(c.name, policy.checks.ignore_checks) &&
              !(w && ignoredWorkflow(w, policy))
            );
          })
          .sort((a, b) => a.id - b.id),
        statuses: [...statuses.values()]
          .filter((s) => !matches(s.context, policy.checks.ignore_statuses))
          .sort((a, b) => a.id - b.id),
        suites: eligibleSuites.sort((a, b) => a.id - b.id),
        workflows: [...currentWorkflows.values()]
          .filter((w) => !ignoredWorkflow(w, policy))
          .sort((a, b) => a.id - b.id),
        policy,
      }),
    )
    .digest("hex");
  const base = { applicable, fingerprint, details };
  if (failed.length)
    return {
      ...base,
      state: "failure",
      phase: "failed",
      reason: "Checks failed",
      blockers: failed.concat(pending),
    };
  if (pending.length)
    return {
      ...base,
      state: "pending",
      phase: "running",
      reason: "Waiting for checks",
      blockers: pending,
    };
  if (!applicable)
    return {
      ...base,
      state: "pending",
      phase: "discovery",
      reason: "No applicable checks",
      blockers: [`Empty-check policy: ${policy.empty_checks.policy}`],
    };
  return {
    ...base,
    state: "success",
    phase: "passed",
    reason: "All applicable checks passed",
    blockers: [],
  };
}
