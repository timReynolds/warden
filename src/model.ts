export const CHECK_NAME = "Warden / All checks passed";
export const COMMENT_MARKER = "<!-- warden:status -->";
export const BYPASS_LABEL = "skip warden";
export const ACTION_ID = "warden_reconcile";
export type LifecycleState = "active" | "suspended" | "removed";
export type RepositoryIdentity = {
  owner: string;
  repo: string;
  state: LifecycleState;
};
export type Workflow = {
  id: number;
  workflowId: number;
  name: string;
  path: string;
  attempt: number;
  suiteId: number;
  sha: string;
  status: string;
  conclusion: string | null;
  url: string;
};
export type Check = {
  id: number;
  name: string;
  appId: number;
  suiteId: number;
  sha: string;
  status: string;
  conclusion: string | null;
  updatedAt: string;
  url: string | null;
  workflowId?: number | undefined;
  workflowAttempt?: number | undefined;
  workflowCurrent?: boolean | undefined;
};
export type CommitStatus = {
  id: number;
  context: string;
  sha: string;
  state: string;
  updatedAt: string;
  url: string | null;
};
export type Suite = {
  id: number;
  appId: number;
  sha: string;
  status: string;
  conclusion: string | null;
};
export type Snapshot = {
  checks: Check[];
  statuses: CommitStatus[];
  suites: Suite[];
  workflows: Workflow[];
};
export type PullRequest = {
  number: number;
  owner: string;
  repo: string;
  sha: string;
  baseSha: string;
  baseRef: string;
  mergeSha: string | null;
  state: string;
  draft: boolean;
  labels: string[];
};
export type Detail = {
  kind: "check" | "status" | "workflow" | "suite";
  name: string;
  state: "passed" | "running" | "failed" | "ignored";
  url: string | null;
};
export type Decision = {
  state: "pending" | "failure" | "success";
  phase?:
    | "discovery"
    | "running"
    | "failed"
    | "passed"
    | "bypassed"
    | "configuration_error"
    | "observation_error"
    | "timeout";
  reason: string;
  blockers: string[];
  applicable: number;
  fingerprint: string;
  details?: Detail[];
};
export type Target = {
  owner: string;
  repo: string;
  number: number;
  installationId: number;
  repositoryId: number;
};
export function targetKey(t: Target): string {
  return `${t.installationId}/${t.repositoryId}#${t.number}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
}

export function sameSubject(a: PullRequest, b: PullRequest): boolean {
  return (
    a.owner === b.owner &&
    a.repo === b.repo &&
    a.sha === b.sha &&
    a.baseSha === b.baseSha &&
    a.baseRef === b.baseRef &&
    a.mergeSha === b.mergeSha &&
    a.state === b.state &&
    [...a.labels].sort().join("\0") === [...b.labels].sort().join("\0")
  );
}
