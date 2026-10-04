import { describe, expect, test } from "bun:test";
import { redact } from "../src/api";
import { defaultPolicy, parsePolicy } from "../src/config";
import {
  advanceDiscovery,
  isEmptyEvaluation,
  stabilityRemaining,
} from "../src/discovery";
import { evaluate } from "../src/evaluator";
import { CHECK_NAME, type Check, type Snapshot } from "../src/model";

const run = (
  id: number,
  conclusion: string | null = "success",
  status = "completed",
  name = "test",
  appId = 2,
): Check => ({
  id,
  name,
  appId,
  suiteId: 20,
  sha: "head",
  status,
  conclusion,
  updatedAt: "2026-10-01T00:00:00Z",
  url: null,
});
const snap = (checks: Check[] = []): Snapshot => ({
  checks,
  statuses: [],
  suites: [],
  workflows: [],
});

describe("discovery progress", () => {
  const now = new Date("2026-10-01T00:00:10Z");
  const previous = {
    fingerprint: null,
    stableSince: null,
    emptyScans: 2,
    emptyNext: null,
  };

  test("empty policy follows the typed phase when presentation text changes", () => {
    const evaluation = {
      ...evaluate(snap(), defaultPolicy, 1),
      reason: "Nothing to evaluate yet",
    };
    const progress = advanceDiscovery(
      previous,
      evaluation,
      defaultPolicy,
      now,
      30,
      true,
    );
    expect(progress.decision).toMatchObject({
      state: "success",
      phase: "passed",
    });
    expect(progress.emptyScans).toBe(3);

    const waiting = snap();
    waiting.suites.push({
      id: 1,
      appId: 2,
      sha: "head",
      status: "queued",
      conclusion: null,
    });
    const pendingSuite = evaluate(waiting, defaultPolicy, 1);
    expect(pendingSuite.applicable).toBe(0);
    expect(isEmptyEvaluation(pendingSuite)).toBe(false);
    expect(isEmptyEvaluation({ ...evaluation, state: "failure" })).toBe(false);
  });

  test("event overlays and early scheduled reads do not consume an empty scan", () => {
    const evaluation = evaluate(snap(), defaultPolicy, 1);
    const emptyNext = new Date(now.getTime() + 30000);
    const progress = { ...previous, emptyNext };
    for (const [at, authoritative] of [
      [now, true],
      [now, false],
      [emptyNext, false],
    ] as const) {
      const result = advanceDiscovery(
        progress,
        evaluation,
        defaultPolicy,
        at,
        30,
        authoritative,
      );
      expect(result.emptyScans).toBe(2);
      expect(result.decision.state).toBe("pending");
    }
    expect(
      advanceDiscovery(progress, evaluation, defaultPolicy, emptyNext, 30, true)
        .emptyScans,
    ).toBe(3);
  });

  test("eligible work clears empty progress while unchanged evidence retains stability", () => {
    const evaluation = evaluate(snap([run(1)]), defaultPolicy, 1);
    const stableSince = new Date(now.getTime() - 5000);
    const result = advanceDiscovery(
      {
        ...previous,
        fingerprint: evaluation.fingerprint,
        stableSince,
        emptyNext: now,
      },
      evaluation,
      defaultPolicy,
      now,
      30,
      false,
    );
    expect(result.emptyScans).toBe(0);
    expect(result.emptyNext).toBe(null);
    expect(result.stableSince).toEqual(stableSince);
    expect(
      advanceDiscovery(previous, evaluation, defaultPolicy, now, 30, true)
        .stableSince,
    ).toEqual(now);
  });

  test("readiness waits for both discovery grace and the quiet period", () => {
    const start = new Date(now.getTime() - 10000);
    expect(
      stabilityRemaining(
        defaultPolicy,
        start,
        new Date(now.getTime() - 5000),
        now,
      ),
    ).toBe(0);
    expect(
      stabilityRemaining(
        defaultPolicy,
        start,
        new Date(now.getTime() - 3000),
        now,
      ),
    ).toBe(2000);
    expect(
      stabilityRemaining(
        defaultPolicy,
        new Date(now.getTime() - 7000),
        start,
        now,
      ),
    ).toBe(3000);
  });
});
describe("independent evaluator", () => {
  test("database JSON field order does not change check stability", () => {
    const check = run(1);
    const reordered = Object.fromEntries(Object.entries(check).reverse());
    const persisted: Snapshot = JSON.parse(
      JSON.stringify({ ...snap(), checks: [reordered] }),
    );
    expect(evaluate(persisted, defaultPolicy, 1).fingerprint).toBe(
      evaluate(snap([check]), defaultPolicy, 1).fingerprint,
    );
  });
  test("success includes all checks and commit status contexts", () => {
    const s = snap([run(1), run(2, "success", "completed", "lint")]);
    s.statuses = [
      {
        id: 1,
        context: "deploy",
        sha: "head",
        state: "pending",
        updatedAt: "",
        url: null,
      },
    ];
    expect(evaluate(s, defaultPolicy, 1).state).toBe("pending");
    s.statuses[0] = {
      id: 2,
      context: "deploy",
      sha: "head",
      state: "success",
      updatedAt: "",
      url: null,
    };
    expect(evaluate(s, defaultPolicy, 1).state).toBe("success");
  });
  test("failure is immediate even while other checks run", () =>
    expect(
      evaluate(
        snap([run(1, "failure"), run(2, null, "in_progress", "lint")]),
        defaultPolicy,
        1,
      ).state,
    ).toBe("failure"));
  test("latest rerun replaces failure; pending rerun does not pass", () => {
    expect(
      evaluate(
        snap([run(1, "failure"), run(3, null, "queued")]),
        defaultPolicy,
        1,
      ).state,
    ).toBe("pending");
    expect(
      evaluate(snap([run(1, "failure"), run(3)]), defaultPolicy, 1).state,
    ).toBe("success");
  });
  test("same name across apps remains independent", () =>
    expect(
      evaluate(
        snap([run(1, "failure", "completed", "test", 3), run(2)]),
        defaultPolicy,
        1,
      ).state,
    ).toBe("failure"));
  test("check and status names have distinct namespaces", () => {
    const s = snap([run(1)]);
    s.statuses = [
      {
        id: 2,
        context: "test",
        sha: "head",
        state: "error",
        updatedAt: "",
        url: null,
      },
    ];
    expect(evaluate(s, defaultPolicy, 1).state).toBe("failure");
  });
  test("ignores only owned aggregate and configured exact/glob names", () => {
    const p = parsePolicy(
      "checks:\n  ignore_checks: ['optional-*']\n  ignore_statuses: ['coverage']",
    );
    expect(
      evaluate(
        snap([
          run(1, "failure", "completed", CHECK_NAME, 1),
          run(2, "failure", "completed", "optional-lint"),
        ]),
        p,
        1,
      ).applicable,
    ).toBe(0);
    expect(
      evaluate(snap([run(1, "failure", "completed", CHECK_NAME, 3)]), p, 1)
        .state,
    ).toBe("failure");
  });
  test("empty always defers to scheduled reconciliation policy", () =>
    expect(evaluate(snap(), defaultPolicy, 1).state).toBe("pending"));
  for (const conclusion of [
    "cancelled",
    "timed_out",
    "action_required",
    "stale",
    "startup_failure",
    null,
  ])
    test(`blocks conclusion ${conclusion}`, () =>
      expect(evaluate(snap([run(1, conclusion)]), defaultPolicy, 1).state).toBe(
        "failure",
      ));
  test("neutral and skipped are configurable", () => {
    expect(
      evaluate(
        snap([run(1, "neutral"), run(2, "skipped", "completed", "lint")]),
        defaultPolicy,
        1,
      ).state,
    ).toBe("success");
    expect(
      evaluate(
        snap([run(1, "skipped")]),
        parsePolicy("checks:\n  passing_conclusions: [success]"),
        1,
      ).state,
    ).toBe("failure");
  });
  test("pending check suite prevents success before checks materialise", () => {
    const s = snap([run(1)]);
    s.suites = [
      { id: 3, appId: 3, sha: "head", status: "queued", conclusion: null },
    ];
    expect(evaluate(s, defaultPolicy, 1).state).toBe("pending");
  });
  test("strict config rejects unknown keys and invalid policy", () => {
    expect(() => parsePolicy("empty_checks: green")).toThrow();
    expect(() => parsePolicy("unknown: true")).toThrow();
    expect(() =>
      parsePolicy("reconciliation:\n  quiet_period_seconds: 0"),
    ).toThrow();
  });
});
test("identical job names in the same current workflow remain independently blocking", () => {
  const a = run(1, "failure");
  const b = run(2);
  const s = snap([a, b]);
  s.workflows = [
    {
      id: 1,
      workflowId: 9,
      name: "CI",
      path: ".github/workflows/ci.yml",
      attempt: 1,
      suiteId: 20,
      sha: "head",
      status: "completed",
      conclusion: "failure",
      url: "http://github.local/runs/1",
    },
  ];
  expect(evaluate(s, defaultPolicy, 1).state).toBe("failure");
  a.workflowAttempt = 1;
  a.workflowCurrent = false;
  b.workflowAttempt = 2;
  const workflow = s.workflows[0];
  if (workflow)
    s.workflows[0] = { ...workflow, attempt: 2, conclusion: "success" };
  expect(evaluate(s, defaultPolicy, 1).state).toBe("success");
});
test("workflow path/name exclusions resolve actual identities with anchored glob syntax", () => {
  const s = snap([run(1, "failure")]);
  s.workflows = [
    {
      id: 1,
      workflowId: 9,
      name: "Docs",
      path: ".github/workflows/docs.yml",
      attempt: 1,
      suiteId: 20,
      sha: "head",
      status: "queued",
      conclusion: null,
      url: "http://github.local/runs/1",
    },
  ];
  expect(
    evaluate(
      s,
      parsePolicy(
        "checks:\n  ignore_workflows: [{path: '.github/workflows/docs.yml'}]",
      ),
      1,
    ).applicable,
  ).toBe(0);
  expect(
    evaluate(s, parsePolicy("checks:\n  ignore_workflows: [{name: 'Do*'}]"), 1)
      .blockers,
  ).toHaveLength(1); // Only empty discovery remains.
  expect(
    evaluate(s, parsePolicy("checks:\n  ignore_workflows: [{path: 'docs'}]"), 1)
      .state,
  ).toBe("failure");
});
test("sensitive webhook fields are redacted recursively without losing check history", () => {
  expect(
    redact({
      token: "sensitive",
      check: { name: "build", authorization: "sensitive" },
      array: [{ private_key: "sensitive" }],
    }),
  ).toEqual({
    token: "[REDACTED]",
    check: { name: "build", authorization: "[REDACTED]" },
    array: [{ private_key: "[REDACTED]" }],
  });
});

test("credential redaction handles header, camelCase and environment names", () => {
  const fields = [
    "Proxy-Authorization",
    "accessToken",
    "installation_token",
    "privateKey",
    "api-key",
    "DATABASE_URL",
    "WARDEN_PRIVATE_KEY",
    "WARDEN_WEBHOOK_SECRET",
    "WARDEN_POSTGRES_PASSWORD",
  ];
  expect(
    redact({
      check: { id: 42, name: "build", conclusion: "success" },
      nested: [Object.fromEntries(fields.map((key) => [key, "sensitive"]))],
    }),
  ).toEqual({
    check: { id: 42, name: "build", conclusion: "success" },
    nested: [Object.fromEntries(fields.map((key) => [key, "[REDACTED]"]))],
  });
});

test("an untouched failure remains eligible during a partial workflow rerun", () => {
  const a = run(1, "failure", "completed", "tests");
  const b = run(2, "success", "completed", "lint");
  a.workflowAttempt = 1;
  b.workflowAttempt = 2;
  const s = snap([a, b]);
  s.workflows = [
    {
      id: 1,
      workflowId: 9,
      name: "CI",
      path: ".github/workflows/ci.yml",
      attempt: 2,
      suiteId: 20,
      sha: "head",
      status: "completed",
      conclusion: "failure",
      url: "http://github.local/runs/1",
    },
  ];
  expect(evaluate(s, defaultPolicy, 1).state).toBe("failure");
});

test("historical jobs cannot conceal a current jobless workflow startup failure", () => {
  const old = run(1);
  old.workflowAttempt = 1;
  old.workflowCurrent = false;
  const s = snap([old]);
  s.workflows = [
    {
      id: 1,
      workflowId: 9,
      name: "CI",
      path: ".github/workflows/ci.yml",
      attempt: 2,
      suiteId: 20,
      sha: "head",
      status: "completed",
      conclusion: "startup_failure",
      url: "http://github.local/runs/1",
    },
  ];
  s.suites = [
    {
      id: 20,
      appId: 2,
      sha: "head",
      status: "completed",
      conclusion: "startup_failure",
    },
  ];
  s.statuses = [
    {
      id: 2,
      context: "deploy",
      sha: "head",
      state: "success",
      updatedAt: "",
      url: null,
    },
  ];
  expect(evaluate(s, defaultPolicy, 1).state).toBe("failure");
});

test("ignored workflow suite transitions do not reset eligible-work stability", () => {
  const s = snap([run(1, "success", "completed", "lint")]);
  s.workflows = [
    {
      id: 2,
      workflowId: 9,
      name: "Optional",
      path: ".github/workflows/optional.yml",
      attempt: 1,
      suiteId: 30,
      sha: "head",
      status: "queued",
      conclusion: null,
      url: "http://github.local/runs/2",
    },
  ];
  s.suites = [
    { id: 30, appId: 2, sha: "head", status: "queued", conclusion: null },
  ];
  const policy = parsePolicy("checks:\n  ignore_workflows: [{id: 9}]\n");
  const before = evaluate(s, policy, 1);
  s.suites[0] = {
    id: 30,
    appId: 2,
    sha: "head",
    status: "completed",
    conclusion: "failure",
  };
  expect(evaluate(s, policy, 1).fingerprint).toBe(before.fingerprint);
});
