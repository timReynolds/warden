# Repository configuration

Put `.github/warden.yml` in the repository Warden monitors. Warden reads it at
the PR's **base commit**, so merge policy changes into the target branch before
expecting them to apply to PRs. If the file is absent, Warden uses the defaults
below. Invalid YAML, unknown keys, or invalid values block the gate with a
configuration error. Configuration is limited to 64 KiB.

## Default policy

```yaml
version: 1
checks:
  passing_conclusions: [success, neutral, skipped]
  ignore_checks: []
  ignore_statuses: []
  ignore_workflows: []
reconciliation:
  intervals_seconds: [30, 60, 120, 300]
  max_duration_seconds: 21600
  initial_grace_seconds: 10
  quiet_period_seconds: 5
empty_checks:
  policy: pass_after_attempts
  pass_after_attempts: 3
bypass:
  label: "skip warden"
  allowed_permissions: [write, maintain, admin]
comment:
  enabled: true
  min_update_interval_seconds: 5
```

Sections and individual fields can be omitted to use their defaults.

## Check selection

`passing_conclusions` is a nonempty list drawn from `success`, `neutral`, and
`skipped`. To require successful check runs, use `[success]`. Commit statuses
must report `success`; `pending` blocks and `failure` or `error` fails the gate.
Queued or running checks, suites, and workflows also block it. Failed workflow
or suite startup can block the gate even if no job check was created.

Ignore lists remove matching signals from evaluation:

```yaml
version: 1
checks:
  passing_conclusions: [success]
  ignore_checks: ["Preview *"]
  ignore_statuses: ["deploy/preview"]
  ignore_workflows:
    - path: ".github/workflows/preview.yml"
    - name: "Optional *"
    - id: 12345678
empty_checks:
  policy: block
```

Check names, status contexts, and workflow names or paths match the full string,
case-sensitively. `*` matches zero or more characters; other characters are
literal, including `?`. Quote patterns containing `*` in YAML. Each workflow
selector must contain exactly one of `id`, `path`, or `name`; IDs are positive
integers. Prefer a workflow path or ID when display names may change.

Warden excludes its own aggregate check from evaluation. It observes both the
PR head and its current merge candidate when available and resolves current
workflow attempts, including partial reruns. An ignore rule can reduce the
signals to an empty set, so review it alongside `empty_checks`.

## Discovery and retries

| Field | Default | Allowed values |
| --- | --- | --- |
| `intervals_seconds` | `[30, 60, 120, 300]` | 1–20 intervals, each 1–3600 seconds |
| `max_duration_seconds` | `21600` (6 hours) | 1–86400 seconds |
| `initial_grace_seconds` | `10` | 0–300 seconds |
| `quiet_period_seconds` | `5` | 1–300 seconds |

Webhooks prompt updates, while scheduled reconciliations refresh GitHub state.
The interval list supplies retry delays; the last interval is reused for later
attempts, with jitter. Initial discovery grace and a stable quiet period must
complete before normal success. New observations can reset that stability.

With `empty_checks.policy: pass_after_attempts`, no eligible checks can pass
after `pass_after_attempts` complete scheduled empty scans (1–100, default 3).
Webhook bursts and failed API reads do not count as complete empty scans. With
`policy: block`, an empty set stays blocking. Neither setting verifies that an
expected workflow exists; configure GitHub's individual required checks when
that guarantee is needed.

The reconciliation window is bounded by `max_duration_seconds`. A timeout never
passes the gate. Use **Reconcile now** on Warden's check, or send a new relevant
event, to renew observation after resolving the cause.

## Bypass

The label name is fixed to `skip warden`. An actor with one of the configured
repository permissions (`write`, `maintain`, or `admin`) must apply it. To limit
bypass to repository administrators:

```yaml
bypass:
  allowed_permissions: [admin]
```

Warden verifies the actor, label application, current permission, and PR head.
A preexisting label without a verified grant does not bypass evaluation. A new
head requires a new verified label application; remove and reapply the label.
Removing the label revokes the grant. Bypass is unavailable when multiple open
PRs share the same head SHA, because GitHub's check is shared by that commit.
Other branch-protection requirements still apply.

## PR comment

Warden maintains one status comment per PR. Set `comment.enabled: false` to
disable comment publication. `min_update_interval_seconds` limits comment
update frequency (0–300 seconds, default 5). The aggregate check still reports
the decision and its blockers.
